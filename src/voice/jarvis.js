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
const { matchWake, guessLang, stopKind } = require('./wake.js');
const brain = require('./brain.js');
const { BAYS_PER_PAGE } = require('../state.js');

// ── pure pieces of the orchestrator, out here so node --test can hold them ───
/** 'pg_abc123s4' → { pageId: 'pg_abc123', slot: 4 } — the renderer's id scheme, parsed back. */
function parseBayId(id) {
  const m = /^(.+)s(\d)$/.exec(String(id || ''));
  return m ? { pageId: m[1], slot: Number(m[2]) } : null;
}

/** Where does a new session go? First empty slot on the page being looked at, then any
 *  page's, and only then a fresh page — the same choice a human's eye would make. */
function chooseSlot(pages, prefPi) {
  const order = [prefPi, ...pages.map((_, i) => i).filter((i) => i !== prefPi)];
  for (const pi of order) {
    const slot = pages[pi]?.bays?.findIndex((b) => !b);
    if (slot !== undefined && slot !== -1) return { pi, slot, newPage: false };
  }
  return { pi: pages.length, slot: 0, newPage: true };
}

/** "yeni proje aç" needs a parent dir. Don't guess a convention — read the user's own:
 *  the most common parent among the folders their bays already point at. */
function inferProjectsDir(pages, fallback) {
  const counts = new Map();
  for (const p of pages || []) {
    for (const b of p.bays || []) {
      if (!b?.path) continue;
      const parent = path.dirname(b.path);
      counts.set(parent, (counts.get(parent) || 0) + 1);
    }
  }
  let best = null;
  for (const [dir, n] of counts) if (best === null || n > counts.get(best)) best = dir;
  return best || fallback;
}

const FOLLOW_UP_MS = 25_000;   // after jarvis speaks, you may answer without the wake word
const HISTORY_KEPT = 4;

// Models live in ONE fixed place regardless of --user-data-dir: a test run in a temp dir
// must not want its own 570MB copy. PORCHLIGHT_MODELS overrides for CI or a second machine.
const modelsDir = () => process.env.PORCHLIGHT_MODELS
  || path.join(os.homedir(), 'Library', 'Application Support', 'porchlight', 'voice-models');
const modelsReady = () => fs.existsSync(path.join(modelsDir(), 'whisper', 'small-encoder.int8.onnx'))
  && fs.existsSync(path.join(modelsDir(), 'silero_vad.onnx'));

// Electron ships src inside app.asar, but a CHILD process is outside the asar magic: it
// needs real paths for the script it runs and the dylibs it loads. electron-builder
// unpacks both (asarUnpack), at the same relative path under app.asar.unpacked.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function createJarvis({ userDataDir, bays, loadState, saveState, killBay, findClaude, loginEnv, send, dbg }) {
  const cfgFile = path.join(userDataDir, 'voice.json');
  const profileFile = path.join(userDataDir, 'voice-profile.json');

  const saved = readJson(cfgFile) || {};
  const cfg = {
    // Her name is Mira — Omicron Ceti, "the Wonderful", the first star anyone watched
    // breathe: it brightens and dims like the orb does. Chosen by measurement, not vibes:
    // whisper transcribed it perfectly in every trial (Hüma came back "Yuma"), and no
    // common Turkish sentence-starter is within edit range of it. "jarvis" stays as a
    // second wake word for the habit that named this module.
    wake: ['mira', 'jarvis'],
    // The brain, per the owner's explicit spec: STRONG over fast — opus at xhigh effort,
    // locally, with tools and the memory dirs. A status question costs ~30-60s; the ack
    // line and the instant stop path below are what make that livable. voice.json can
    // set {"model":"haiku","effort":null,"ack":false} to trade depth back for speed.
    model: 'opus',
    effort: 'xhigh',
    ack: true,             // speak "bakıyorum" the moment a command lands, then think
    brainTimeout: 240_000,
    threshold: null,       // null → the value enrollment measured, or the engine's default
    sttLang: 'tr',         // the owner speaks Turkish to her; '' lets whisper guess per utterance
    // The owner's arrangement (their own words: "ben türkçe konuşayım, o ingilizce
    // konuşsun"): mira ALWAYS answers in English — her voice is only natural there.
    // 'tr' pins Turkish back; 'match' mirrors whatever the user spoke.
    replyLang: 'en',
    ...saved,
    // Her voice: ONE voice for both languages — Edge's Ava (multilingual: natural in
    // Turkish AND English, warm where Emel was flat), piper's dfki/amy offline fallback.
    // All are women's voices — that was the spec, verbatim. rate/pitch shade the tone;
    // voice.json can pin any of it, e.g. {"voices":{"tr":"tr-TR-EmelNeural","rate":"+0%"}}.
    voices: {
      enabled: true,
      tr: 'en-US-AvaMultilingualNeural', en: 'en-US-AvaMultilingualNeural',
      rate: '-5%', pitch: '-2Hz',
      ...(saved.voices || {}),
    },
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

  // Everything mira says out of her own head (not the brain's replies) in both tongues;
  // pl() picks per cfg.replyLang, falling back to the user's language under 'match'.
  const PHRASES = {
    en: {
      summons: 'Yes?',
      acks: ['On it.', 'One moment, looking.', 'Checking now.'],
      stopped: 'Stopped.', nothingRunning: 'Nothing was running.',
      noAnswer: "I couldn't come up with an answer to that — ask me again?",
      enrolled: 'Got your voice. From now on I only listen to you.',
    },
    tr: {
      summons: 'Efendim?',
      acks: ['Bakıyorum efendim.', 'Hemen bakıyorum.', 'Bir saniye, bakıyorum.'],
      stopped: 'Durdurdum.', nothingRunning: 'Duran bir ajan göremiyorum.',
      noAnswer: 'Buna bir cevap üretemedim, tekrar sorar mısın?',
      enrolled: 'Sesini tanıdım. Artık sadece seni dinliyorum.',
    },
  };
  const pl = (cmd) => (cfg.replyLang === 'en' || cfg.replyLang === 'tr') ? cfg.replyLang : guessLang(cmd || 'tamam');

  const event = (p) => send('voice:event', p);
  const setPhase = (p) => { if (phase !== p) { phase = p; event({ t: 'phase', phase: p }); } };
  const snapshotForRenderer = () => ({
    enabled, phase, enrolled: !!profile?.v?.length, modelsReady: modelsReady(), wake: cfg.wake,
  });

  // ── the sidecar ────────────────────────────────────────────────────────────
  // The engine must run in a REAL node, not in Electron-as-node: sherpa-onnx hands
  // audio back as external buffers, and Electron's V8 memory cage refuses those with
  // "External buffers are not allowed" — ELECTRON_RUN_AS_NODE does not lift the cage.
  // So find node the way main.js finds claude: on the login shell's PATH. Only a
  // machine with no node at all falls back to Electron, where voice cannot work.
  let nodePathPromise = null;
  function findNode() {
    if (nodePathPromise) return nodePathPromise;
    nodePathPromise = loginEnv().then((env) => {
      for (const d of (env.PATH || '').split(':')) {
        if (d && fs.existsSync(path.join(d, 'node'))) return path.join(d, 'node');
      }
      return ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p)) || null;
    });
    return nodePathPromise;
  }

  let engineStarting = false;
  function startEngine() {
    if (engine || engineStarting) return;
    engineStarting = true;
    setPhase('boot');
    findNode().then((nodeBin) => {
      engineStarting = false;
      if (engine) return;
      if (!enabled) { setPhase('off'); return; }
      const enginePath = unpacked(path.join(__dirname, 'engine.js'));
      const dylibDir = unpacked(path.join(__dirname, '..', '..', 'node_modules', 'sherpa-onnx-darwin-arm64'));
      dbg(`jarvis: spawning engine with ${nodeBin || `${process.execPath} (NO node on PATH — sherpa will refuse)`} (models: ${modelsDir()})`);
      engine = spawn(nodeBin || process.execPath, [enginePath, '--models', modelsDir(), '--serve'], {
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
    });
  }

  const toEngine = (obj) => { try { engine?.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* dying */ } };

  function sendProfile() {
    toEngine({
      t: 'cfg',
      profile: profile?.v || null,
      // Capped at 0.48 no matter what enrollment measured: the owner's own profile came
      // out at 0.55 (three clean, consistent samples) and then REJECTED most of their
      // real-world speech — same voice, different distance and mood scores 0.45-0.55.
      // A too-strict gate reads as "mira ignores me", which is worse than a rare leak.
      threshold: Math.min(cfg.threshold ?? profile?.threshold ?? 0.45, 0.48),
      voices: cfg.voices,
      sttLang: cfg.sttLang,
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
        dbg(`jarvis: voice rejected (cos ${msg.score} < ${msg.need})`);
        event({ t: 'reject', score: msg.score, need: msg.need });
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

    const wasSpeaking = !!player || phase === 'speaking';
    if (player) { try { player.kill(); } catch { /* done */ } }   // you talk, mira stops

    const wake = matchWake(text, cfg.wake);
    const inWindow = Date.now() < followUpUntil;
    let command = null;
    if (wake) command = wake.command;
    else if (inWindow || pttArmed) command = text.trim();
    // A stop needs no wake word while she is busy — being stoppable is the point.
    else if ((wasSpeaking || busyThinking) && stopKind(text)) command = text.trim();
    pttArmed = false;

    if (command === null) { event({ t: 'heard', text, acted: false }); return; }
    event({ t: 'heard', text, acted: true });

    if (!command) {   // "Mira." — a summons with no order
      followUpUntil = Date.now() + FOLLOW_UP_MS;
      const L = pl('');
      speak(PHRASES[L].summons, L);
      return;
    }

    // "Dur" must not wait 40 seconds for opus to agree. A bare stop word goes straight
    // to Esc — the focused bay if there is one, else every running bay on this page.
    if (quickStop(command, wasSpeaking)) return;

    setPhase('thinking');
    if (cfg.ack) {
      const L = pl(command);
      const acks = PHRASES[L].acks;
      speak(acks[Math.floor(Math.random() * acks.length)], L);
    }
    const reply = await think(command);
    const muted = muteReply; muteReply = false;   // "sus" while she thought → text only
    if (!reply) {
      if (!muted) { const L = pl(command); speak(PHRASES[L].noAnswer, L); }
      return;
    }
    for (const a of reply.actions) act(a);
    // the renderer lights up the tiles that just received an order, in their own hue
    event({ t: 'say', text: reply.say, actions: reply.actions.length, bays: reply.actions.map((a) => a.bay).filter(Boolean) });
    history.push({ heard: command, said: reply.say });
    history = history.slice(-HISTORY_KEPT);
    followUpUntil = Date.now() + FOLLOW_UP_MS;
    // a pinned replyLang also pins the VOICE — if the brain disobeys and answers in
    // Turkish anyway, Ava still reads it (multilingual), just less at home
    if (!muted) speak(reply.say, cfg.replyLang === 'match' ? (reply.lang || guessLang(reply.say)) : cfg.replyLang);
  }

  // Stops skip the brain entirely: "dur" must not wait 40 seconds for opus to agree.
  // What a stop does depends on what she was doing. Any stop while she is TALKING means
  // "be quiet" — the barge-in already killed the player, don't take it out on the
  // agents. "dur" into silence → Esc to the agents. "kapat" → the mic itself goes off.
  function quickStop(command, wasSpeaking) {
    const kind = stopKind(command);
    if (!kind) return false;
    if (kind === 'off') {
      event({ t: 'say', text: 'Kapattım. Orb ile geri açarsın.', actions: 0, bays: [] });
      api.setEnabled(false);
      return true;
    }
    if (kind === 'hush' || wasSpeaking) {
      if (busyThinking) muteReply = true;   // the pending answer arrives as text, not voice
      followUpUntil = 0;
      setPhase(busyThinking ? 'thinking' : 'listening');
      return true;
    }
    const targets = [];
    if (view.focused && bays.get(view.focused) && !bays.get(view.focused).exited) {
      targets.push(view.focused);
    } else {
      const pageId = loadState().pages?.[view.page]?.id;
      for (const [id, b] of bays) if (!b.exited && pageId && id.startsWith(`${pageId}s`)) targets.push(id);
    }
    for (const id of targets) { try { bays.get(id).proc.write('\x1b'); } catch { /* raced with exit */ } }
    dbg(`jarvis: quick stop → ${targets.length ? targets.join(', ') : 'nothing running'}`);
    const L = pl(command);
    event({ t: 'say', text: PHRASES[L].stopped, actions: targets.length, bays: targets });
    speak(targets.length ? PHRASES[L].stopped : PHRASES[L].nothingRunning, L);
    followUpUntil = Date.now() + FOLLOW_UP_MS;
    return true;
  }

  let busyThinking = false;
  let muteReply = false;
  async function think(command) {
    const bin = await findClaude();
    if (!bin) return null;
    const env = await loginEnv();
    const state = loadState();
    const running = {};
    for (const [id, b] of bays) if (!b.exited) running[id] = { buf: b.buf };
    const snap = { pages: state.pages || [], pageIndex: view.page, focusedBayId: view.focused, running };
    busyThinking = true;
    try {
      return await brain.ask({
        bin, env, model: cfg.model, effort: cfg.effort, snap,
        transcript: command, history, timeoutMs: cfg.brainTimeout,
        projectsDir: projectsDir(), replyLang: cfg.replyLang, dbg,
      });
    } finally {
      busyThinking = false;
    }
  }

  // ── the orchestrator's hands ───────────────────────────────────────────────
  // send/esc talk to a session; start/kill/close/restart manage the fleet itself: they
  // mutate state.json here in main and tell the renderer to re-sync — its normal render
  // flow then mounts the tile and auto-starts the agent, exactly as if a human had
  // clicked +. Nothing here spawns a process directly; the one way to run a bay stays
  // the one way (main's startBay, CLAUDE_ARGS and all).
  const newPageId = () => `pg_${Math.random().toString(36).slice(2, 10)}`;
  const projectsDir = () =>
    cfg.projectsDir || inferProjectsDir(loadState().pages, path.join(os.homedir(), 'Projects'));

  function act(a) {
    switch (a.type) {
      case 'start': return actStart(a);
      case 'kill': return killBay(a.bay);
      case 'close': return actClose(a.bay);
      case 'restart': return actRestart(a.bay);
    }
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

  function actStart(a) {
    try {
      let p = String(a.path || '').trim();
      if (!p) return dbg('jarvis: start with no path dropped');
      if (!path.isAbsolute(p)) p = path.join(projectsDir(), p);
      p = path.resolve(p);
      // A misheard word must not mkdir outside the user's own house.
      if (!(p + path.sep).startsWith(os.homedir() + path.sep)) {
        return dbg(`jarvis: start outside home refused — ${p}`);
      }
      if (a.create) fs.mkdirSync(p, { recursive: true });
      if (!fs.existsSync(p)) return dbg(`jarvis: start for missing folder dropped — ${p}`);

      const state = loadState();
      const spot = chooseSlot(state.pages, view.page);
      if (spot.newPage) state.pages.push({ id: newPageId(), bays: Array(BAYS_PER_PAGE).fill(null) });
      const page = state.pages[spot.pi];
      page.bays[spot.slot] = { path: p, title: a.title || path.basename(p) };
      saveState(state);
      const id = `${page.id}s${spot.slot}`;
      dbg(`jarvis: starting session ${id} in ${p}`);
      send('voice:sync', { page: spot.pi });   // the renderer mounts it and the agent starts
      if (a.text) deliverWhenReady(id, a.text);
    } catch (e) {
      dbg(`jarvis: start failed — ${e.message}`);
    }
  }

  // A freshly started claude needs a few seconds before a paste will stick. Wait for the
  // pty's first output, then a grace beat, then hand the new agent its first order.
  function deliverWhenReady(id, text, tries = 0) {
    const bay = bays.get(id);
    if (bay && !bay.exited && bay.spoke && Date.now() - bay.startedAt > 6000) {
      bay.proc.write(text.replace(/\s*\n\s*/g, ' ').trim());
      setTimeout(() => { try { if (!bay.exited) bay.proc.write('\r'); } catch { /* raced */ } }, 400);
      return;
    }
    if (tries > 60) return dbg(`jarvis: gave up delivering the first order to ${id}`);
    setTimeout(() => deliverWhenReady(id, text, tries + 1), 1000);
  }

  function actClose(bayId) {
    const at = parseBayId(bayId);
    if (!at) return;
    killBay(bayId);
    const state = loadState();
    const pi = state.pages.findIndex((p) => p.id === at.pageId);
    if (pi === -1) return;
    state.pages[pi].bays[at.slot] = null;
    saveState(state);
    send('voice:sync', {});
  }

  function actRestart(bayId) {
    const at = parseBayId(bayId);
    if (!at) return;
    const state = loadState();
    const pi = state.pages.findIndex((p) => p.id === at.pageId);
    if (pi === -1 || !state.pages[pi].bays[at.slot]) return;
    send('voice:sync', { page: pi, restart: [bayId] });
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
      // the ack line ends long before opus does — fall back to 'thinking', not 'listening'
      if (enabled && phase === 'speaking') setPhase(busyThinking ? 'thinking' : 'listening');
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
    const threshold = Math.min(0.48, Math.max(0.33, Math.min(...sims) - 0.12));
    profile = { v: enrollTaken, threshold, createdAt: new Date().toISOString() };
    writeJson(profileFile, profile);
    enrollTaken = [];
    warnedUnenrolled = false;
    sendProfile();
    event({ t: 'enroll-done', threshold: +threshold.toFixed(3) });
    setPhase('listening');
    const L = pl('');
    speak(PHRASES[L].enrolled, L);
  }

  // ── surface for main.js ────────────────────────────────────────────────────
  // (named so quickStop's "kapat" can flip the same switch the orb does)
  const api = {
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
    act,   // exposed for main's PORCHLIGHT_VOICE_DEMO test hook — same code path the brain drives
    shutdown() { try { engine?.kill(); } catch { /* going down anyway */ } engine = null; },
  };
  return api;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, obj) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); }
  catch (e) { console.error('jarvis: could not save', f, e.message); }
}

module.exports = { createJarvis, modelsReady, parseBayId, chooseSlot, inferProjectsDir };
