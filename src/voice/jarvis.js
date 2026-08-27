'use strict';

/* jarvis — the orchestrator. Lives in the main process, owns the voice sidecar, and is
 * the only thing that connects HEARING to DOING:
 *
 *   renderer mic → [engine: VAD → voiceprint gate → whisper] → wake word → claude -p
 *   (the brain, fed every bay's tail) → type into a bay's pty / speak through piper.
 *
 * Policy lives HERE, not in the engine: whether an unenrolled mic may command anything
 * (it may not), what the wake word is, when a follow-up may skip it, and what actually
 * gets written into a pty. The engine only ever answers "who spoke and what did they say".
 */

const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { matchWake, guessLang } = require('./wake.js');
const brain = require('./brain.js');

const FOLLOW_UP_MS = 25_000;   // after jarvis speaks, you may answer without the wake word
const HISTORY_KEPT = 4;

// Models live in ONE fixed place regardless of --user-data-dir: a test run in a temp dir
// must not want its own 570MB copy. HANGAR_MODELS overrides for CI or a second machine.
const modelsDir = () => process.env.HANGAR_MODELS
  || path.join(os.homedir(), 'Library', 'Application Support', 'hangar', 'voice-models');
const modelsReady = () => fs.existsSync(path.join(modelsDir(), 'whisper', 'small-encoder.int8.onnx'))
  && fs.existsSync(path.join(modelsDir(), 'silero_vad.onnx'));

// Electron ships src inside app.asar, but a CHILD process is outside the asar magic: it
// needs real paths for the script it runs and the dylibs it loads. electron-builder
// unpacks both (asarUnpack), at the same relative path under app.asar.unpacked.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function createJarvis({ userDataDir, bays, loadState, findClaude, loginEnv, send, dbg }) {
  const cfgFile = path.join(userDataDir, 'voice.json');
  const profileFile = path.join(userDataDir, 'voice-profile.json');

  const saved = readJson(cfgFile) || {};
  const cfg = {
    wake: 'jarvis',
    model: 'haiku',        // the brain: fast beats brilliant for "how is bay 3 doing"
    threshold: null,       // null → the value enrollment measured, or the engine's default
    ...saved,
    // Her voice: Edge's neural Emel/Jenny when the network is there (realistic), piper's
    // dfki/amy offline. All four are women's voices — that was the spec, verbatim.
    voices: { enabled: true, tr: 'tr-TR-EmelNeural', en: 'en-US-JennyNeural', ...(saved.voices || {}) },
  };
  let profile = readJson(profileFile);   // { v: [[..]x3], threshold } | null

  let engine = null;
  let engineReady = false;
  let enabled = false;
  let phase = 'off';       // off|boot|listening|hearing|thinking|speaking|enroll
  let view = { page: 0, focused: null };  // what the renderer says is on screen
  let followUpUntil = 0;
  let pttArmed = false;    // orb long-press / “talk” — next utterance needs no wake word
  let player = null;       // the afplay currently speaking, so it can be interrupted
  let speakSeq = 0;
  let enrollTaken = [];    // embeddings collected so far this enrollment
  let history = [];
  let warnedUnenrolled = false;

  const event = (p) => send('voice:event', p);
  const setPhase = (p) => { if (phase !== p) { phase = p; event({ t: 'phase', phase: p }); } };
  const snapshotForRenderer = () => ({
    enabled, phase, enrolled: !!profile?.v?.length, modelsReady: modelsReady(), wake: cfg.wake,
  });

  // ── the sidecar ────────────────────────────────────────────────────────────
  function startEngine() {
    if (engine) return;
    const enginePath = unpacked(path.join(__dirname, 'engine.js'));
    const dylibDir = unpacked(path.join(__dirname, '..', '..', 'node_modules', 'sherpa-onnx-darwin-arm64'));
    dbg(`jarvis: spawning engine (models: ${modelsDir()})`);
    setPhase('boot');
    engine = spawn(process.execPath, [enginePath, '--models', modelsDir(), '--serve'], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DYLD_LIBRARY_PATH: `${dylibDir}:${process.env.DYLD_LIBRARY_PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    engine.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { onEngine(JSON.parse(line)); } catch { /* half a line, or noise */ }
      }
    });
    engine.stderr.on('data', (d) => dbg(`engine! ${String(d).trim()}`));
    engine.on('exit', (code) => {
      dbg(`jarvis: engine exited (${code})`);
      engine = null; engineReady = false;
      if (enabled) { setPhase('boot'); setTimeout(() => { if (enabled) startEngine(); }, 2000); }
      else setPhase('off');
    });
  }

  const toEngine = (obj) => { try { engine?.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* dying */ } };

  function sendProfile() {
    toEngine({
      t: 'cfg',
      profile: profile?.v || null,
      threshold: cfg.threshold ?? profile?.threshold ?? 0.45,
      voices: cfg.voices,
    });
  }

  function onEngine(msg) {
    switch (msg.t) {
      case 'ready':
        engineReady = true;
        sendProfile();
        setPhase(enrollTaken.wanted ? 'enroll' : 'listening');
        event({ t: 'status', ...snapshotForRenderer() });
        break;
      case 'vad':
        if (phase === 'listening' || phase === 'hearing') setPhase(msg.on ? 'hearing' : 'listening');
        break;
      case 'utt': onUtterance(msg); break;
      case 'reject':
        dbg(`jarvis: voice rejected (cos ${msg.score})`);
        event({ t: 'reject', score: msg.score });
        break;
      case 'enrolled': onEnrolled(msg.v); break;
      case 'spoke': onSpoke(msg); break;
      case 'err':
        dbg(`jarvis: engine err — ${msg.m}`);
        event({ t: 'toast', text: msg.m });
        break;
      case 'log': dbg(`engine: ${msg.m}`); break;
    }
  }

  // ── hearing → doing ────────────────────────────────────────────────────────
  async function onUtterance({ text, score }) {
    dbg(`jarvis: heard "${text}"${score === null ? '' : ` (cos ${score})`}`);
    if (phase === 'enroll') return;

    // The gate's other half: an un-enrolled jarvis obeys NOBODY. score===null means the
    // engine had no voiceprint to check against, so nothing proves this voice is yours.
    if (score === null) {
      if (!warnedUnenrolled) {
        warnedUnenrolled = true;
        event({ t: 'need', what: 'profile' });
      }
      return;
    }

    if (player) { try { player.kill(); } catch { /* done */ } }   // you talk, jarvis stops

    const wake = matchWake(text, cfg.wake);
    const inWindow = Date.now() < followUpUntil;
    let command = null;
    if (wake) command = wake.command;
    else if (inWindow || pttArmed) command = text.trim();
    pttArmed = false;

    if (command === null) { event({ t: 'heard', text, acted: false }); return; }
    event({ t: 'heard', text, acted: true });

    if (!command) {   // "Jarvis." — a summons with no order
      followUpUntil = Date.now() + FOLLOW_UP_MS;
      speak('Efendim?', 'tr');
      return;
    }

    setPhase('thinking');
    const reply = await think(command);
    if (!reply) {
      speak(guessLang(command) === 'tr' ? 'Buna bir cevap üretemedim, tekrar sorar mısın?'
                                        : "I couldn't come up with an answer to that, ask me again?", guessLang(command));
      return;
    }
    for (const a of reply.actions) act(a);
    event({ t: 'say', text: reply.say, actions: reply.actions.length });
    history.push({ heard: command, said: reply.say });
    history = history.slice(-HISTORY_KEPT);
    followUpUntil = Date.now() + FOLLOW_UP_MS;
    speak(reply.say, reply.lang || guessLang(reply.say));
  }

  async function think(command) {
    const bin = await findClaude();
    if (!bin) return null;
    const env = await loginEnv();
    const state = loadState();
    const running = {};
    for (const [id, b] of bays) if (!b.exited) running[id] = { buf: b.buf };
    const snap = { pages: state.pages || [], pageIndex: view.page, focusedBayId: view.focused, running };
    return brain.ask({ bin, env, model: cfg.model, snap, transcript: command, history, dbg });
  }

  function act(a) {
    const bay = bays.get(a.bay);
    if (!bay || bay.exited) { dbg(`jarvis: action for dead bay ${a.bay} dropped`); return; }
    if (a.type === 'esc') { bay.proc.write('\x1b'); return; }
    if (a.type === 'send') {
      // One line, then Enter a beat later — the TUI needs a tick to take the paste, and a
      // newline INSIDE the text would submit half a prompt.
      bay.proc.write(a.text.replace(/\s*\n\s*/g, ' ').trim());
      setTimeout(() => { try { if (!bay.exited) bay.proc.write('\r'); } catch { /* raced */ } }, 300);
    }
  }

  // ── speaking ───────────────────────────────────────────────────────────────
  function speak(text, lang) {
    if (!engineReady) return;
    const id = ++speakSeq;
    toEngine({ t: 'speak', id, text, lang });
  }

  function onSpoke({ id, wav }) {
    if (id !== speakSeq) { fs.unlink(wav, () => {}); return; }   // superseded while synthesizing
    if (player) { try { player.kill(); } catch { /* done */ } }
    setPhase('speaking');
    player = execFile('/usr/bin/afplay', [wav], () => {
      player = null;
      fs.unlink(wav, () => {});
      if (enabled && phase === 'speaking') setPhase('listening');
      followUpUntil = Date.now() + FOLLOW_UP_MS;
    });
  }

  // ── enrollment: three sentences → a voiceprint ─────────────────────────────
  function enrollStart() {
    enrollTaken = []; enrollTaken.wanted = true;
    if (!engine) startEngine();
    setPhase(engineReady ? 'enroll' : 'boot');
  }
  const enrollCapture = () => toEngine({ t: 'enroll' });
  function enrollCancel() {
    enrollTaken = [];
    toEngine({ t: 'enroll-cancel' });
    setPhase(enabled ? 'listening' : 'off');
  }
  function onEnrolled(v) {
    enrollTaken.push(v);
    event({ t: 'enroll-got', n: enrollTaken.length });
    if (enrollTaken.length < 3) return;
    // The threshold is measured, not guessed: your three samples' similarity to each
    // other says how consistent your voice looks to this model. A stranger scored ~0.28
    // in testing while the same voice scored ~0.87 — the floor keeps a mumbled sample
    // from opening the gate to everyone.
    const sims = [];
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      let dot = 0, na = 0, nb = 0;
      for (let k = 0; k < enrollTaken[i].length; k++) {
        dot += enrollTaken[i][k] * enrollTaken[j][k];
        na += enrollTaken[i][k] ** 2; nb += enrollTaken[j][k] ** 2;
      }
      sims.push(dot / (Math.sqrt(na) * Math.sqrt(nb) || 1));
    }
    const threshold = Math.min(0.55, Math.max(0.35, Math.min(...sims) - 0.12));
    profile = { v: enrollTaken, threshold, createdAt: new Date().toISOString() };
    writeJson(profileFile, profile);
    enrollTaken = [];
    warnedUnenrolled = false;
    sendProfile();
    event({ t: 'enroll-done', threshold: +threshold.toFixed(3) });
    setPhase('listening');
    speak('Sesini tanıdım. Artık sadece seni dinliyorum.', 'tr');
  }

  // ── surface for main.js ────────────────────────────────────────────────────
  return {
    status: snapshotForRenderer,
    setEnabled(on) {
      enabled = !!on;
      if (enabled) { if (!modelsReady()) { enabled = false; event({ t: 'need', what: 'models' }); return; } startEngine(); }
      else { toEngine({ t: 'flush' }); pttArmed = false; setPhase('off'); }
      event({ t: 'status', ...snapshotForRenderer() });
    },
    get enabled() { return enabled; },
    frame(buf) { if (enabled && engineReady) toEngine({ t: 'a', d: Buffer.from(buf).toString('base64') }); },
    ptt() { if (enabled) { pttArmed = true; event({ t: 'ptt' }); } },
    setView(v) { view = { page: v.page | 0, focused: v.focused || null }; },
    enrollStart, enrollCapture, enrollCancel,
    shutdown() { try { engine?.kill(); } catch { /* going down anyway */ } engine = null; },
  };
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, obj) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); }
  catch (e) { console.error('jarvis: could not save', f, e.message); }
}

module.exports = { createJarvis, modelsReady };
