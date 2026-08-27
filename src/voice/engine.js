'use strict';

/* jarvis's ears, voiceprint and voice — a sidecar process, NOT Electron code.
 *
 * main.js spawns this with ELECTRON_RUN_AS_NODE=1 (Electron's own binary doubles as a
 * plain node, so a packaged app needs no node installed) and speaks JSON-lines over
 * stdin/stdout. It is a separate process for three reasons: sherpa-onnx holds ~500MB of
 * models that should never sit in the UI process; a crash in native code must not take
 * the window (and nine agents' tiles) with it; and a plain-node process sidesteps every
 * Electron-ABI question a native addon can ask.
 *
 * In:  {t:'cfg', profile:[[..]..]|null, threshold}     — the enrolled voiceprint
 *      {t:'a', d:'<base64 int16 mono 16k pcm>'}        — microphone audio
 *      {t:'enroll'}                                    — next utterance → embedding, no STT
 *      {t:'enroll-cancel'}
 *      {t:'speak', id, text, lang:'tr'|'en'}           — synthesize, reply with a wav path
 *      {t:'flush'}                                     — mic stopped; close any open segment
 * Out: {t:'ready'} {t:'vad',on} {t:'utt',text,score,ok,secs} {t:'reject',score,secs}
 *      {t:'enrolled',v:[..]} {t:'spoke',id,wav,secs} {t:'err',m} {t:'log',m}
 *
 * The pipeline per utterance: Silero VAD finds the speech → the speaker model turns it
 * into a 512-dim voiceprint and compares it to the enrolled one (this is the "only my
 * voice" gate — it also throws away jarvis hearing ITSELF through the speakers) → only
 * then does whisper spend the compute to read the words.
 *
 * Also a CLI, so the whole pipeline can be tested without a microphone —
 * `say` makes a wav, this decodes it:
 *   engine.js --models DIR --stt f.wav | --embed a.wav b.wav | --tts "text" --lang tr --out o.wav
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const SR = 16000;
const MODELS = argOf('--models') || process.env.HANGAR_MODELS
  || path.join(os.homedir(), 'Library', 'Application Support', 'hangar', 'voice-models');

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}
const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (m) => say({ t: 'log', m });

let sherpa;
try {
  sherpa = require('sherpa-onnx-node');
} catch (e) {
  // The addon dylibs need DYLD_LIBRARY_PATH (main.js sets it when spawning). If this
  // fires, say so machine-readably rather than dying with a stack trace nobody parses.
  say({ t: 'err', m: `sherpa-onnx failed to load: ${e.message}` });
  process.exit(1);
}

// ── models ───────────────────────────────────────────────────────────────────
const P = {
  vad: path.join(MODELS, 'silero_vad.onnx'),
  whisperEnc: path.join(MODELS, 'whisper', 'small-encoder.int8.onnx'),
  whisperDec: path.join(MODELS, 'whisper', 'small-decoder.int8.onnx'),
  whisperTok: path.join(MODELS, 'whisper', 'small-tokens.txt'),
  speaker: path.join(MODELS, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
  ttsTr: path.join(MODELS, 'vits-piper-tr_TR-dfki-medium'),
  ttsEn: path.join(MODELS, 'vits-piper-en_US-amy-medium'),
};

for (const [k, p] of Object.entries(P)) {
  if (!fs.existsSync(p)) {
    say({ t: 'err', m: `model missing (${k}): ${p} — run \`npm run voice-models\`` });
    process.exit(2);
  }
}

const makeVad = () => new sherpa.Vad({
  sileroVad: {
    model: P.vad,
    threshold: 0.5,
    minSpeechDuration: 0.25,
    minSilenceDuration: 0.6,   // how long a pause ends an utterance — the feel of the thing
    maxSpeechDuration: 18,
    windowSize: 512,
  },
  sampleRate: SR, numThreads: 1, provider: 'cpu', debug: 0,
}, 120);

const makeRecognizer = () => new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: SR, featureDim: 80 },
  modelConfig: {
    whisper: { encoder: P.whisperEnc, decoder: P.whisperDec, language: '', task: 'transcribe', tailPaddings: -1 },
    tokens: P.whisperTok,
    numThreads: 2, provider: 'cpu', debug: 0,
  },
});

const makeExtractor = () => new sherpa.SpeakerEmbeddingExtractor({
  model: P.speaker, numThreads: 1, provider: 'cpu', debug: 0,
});

const ttsCache = new Map();
function tts(lang) {
  if (ttsCache.has(lang)) return ttsCache.get(lang);
  const dir = lang === 'tr' ? P.ttsTr : P.ttsEn;
  const onnx = fs.readdirSync(dir).find((f) => f.endsWith('.onnx'));
  const t = new sherpa.OfflineTts({
    model: {
      vits: { model: path.join(dir, onnx), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data') },
      numThreads: 2, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
  });
  ttsCache.set(lang, t);
  return t;
}

// ── the small math ───────────────────────────────────────────────────────────
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

function embed(extractor, samples, sampleRate = SR) {
  const stream = extractor.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  stream.inputFinished();
  return extractor.compute(stream);
}

function transcribe(recognizer, samples, sampleRate = SR) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  recognizer.decode(stream);
  return (recognizer.getResult(stream).text || '').trim();
}

function synthPiper(text, lang) {
  const audio = tts(lang).generate({ text, sid: 0, speed: 1.0 });
  const wav = path.join(os.tmpdir(), `hangar-jarvis-${process.pid}-${Date.now()}.wav`);
  sherpa.writeWave(wav, { samples: audio.samples, sampleRate: audio.sampleRate });
  return { wav, secs: audio.samples.length / audio.sampleRate };
}

// The mouth is a CHAIN: Edge's neural voices first (they sound like a person — the whole
// point of a jarvis), local piper when the network or Microsoft says no. Both female;
// the voice names travel in the cfg message so voice.json can pick different ones.
const edgeTts = require('./edge-tts.js');
let edgeVoices = { tr: 'tr-TR-EmelNeural', en: 'en-US-JennyNeural', enabled: true };

async function synthBest(text, lang) {
  if (edgeVoices.enabled) {
    try {
      const mp3 = await edgeTts.synth(text, lang === 'tr' ? edgeVoices.tr : edgeVoices.en);
      const f = path.join(os.tmpdir(), `hangar-jarvis-${process.pid}-${Date.now()}.mp3`);
      fs.writeFileSync(f, mp3);
      return { wav: f, secs: 0, via: 'edge' };   // afplay reads mp3; duration unknown and unneeded
    } catch (e) {
      log(`edge-tts → piper fallback: ${e.message}`);
    }
  }
  return { ...synthPiper(text, lang), via: 'piper' };
}

// ── CLI mode: the pipeline without a microphone ──────────────────────────────
(function cli() {
  const stt = argOf('--stt');
  const ttsText = argOf('--tts');
  const embeds = process.argv.flatMap((a, i) => (a === '--embed' ? [process.argv[i + 1]] : []));
  if (!stt && !ttsText && !embeds.length) return;   // serve mode

  if (stt) {
    const w = sherpa.readWave(stt);
    const text = transcribe(makeRecognizer(), w.samples, w.sampleRate);
    console.log(JSON.stringify({ text }));
  }
  if (embeds.length) {
    const ex = makeExtractor();
    const vs = embeds.map((f) => { const w = sherpa.readWave(f); return embed(ex, w.samples, w.sampleRate); });
    const sims = [];
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      sims.push({ a: path.basename(embeds[i]), b: path.basename(embeds[j]), cos: +cosine(vs[i], vs[j]).toFixed(4) });
    }
    console.log(JSON.stringify({ dim: vs[0]?.length || 0, sims }));
  }
  if (ttsText) {
    const { wav, secs } = synthPiper(ttsText, argOf('--lang') || 'tr');
    const out = argOf('--out');
    if (out) fs.copyFileSync(wav, out);
    console.log(JSON.stringify({ wav: out || wav, secs: +secs.toFixed(2) }));
  }
  process.exit(0);
})();

// ── serve mode: the live pipeline ────────────────────────────────────────────
const vad = makeVad();
const recognizer = makeRecognizer();
const extractor = makeExtractor();

let profile = null;        // Float32Array[] — the enrolled voiceprints
let threshold = 0.45;
let enrollArmed = false;
let vadWasOn = false;

function processSegment(samples) {
  const secs = samples.length / SR;
  if (secs < 0.35) return;                       // a cough, a click

  if (enrollArmed) {
    if (secs < 1.0) { say({ t: 'log', m: `enroll: ${secs.toFixed(1)}s is too short, still armed` }); return; }
    enrollArmed = false;
    say({ t: 'enrolled', v: Array.from(embed(extractor, samples)) });
    return;
  }

  let score = null, ok = true;
  if (profile && profile.length) {
    const v = embed(extractor, samples);
    score = Math.max(...profile.map((p) => cosine(v, p)));
    ok = score >= threshold;
  }
  if (!ok) { say({ t: 'reject', score: +score.toFixed(3), secs: +secs.toFixed(1) }); return; }

  const text = transcribe(recognizer, samples);
  if (!text) return;
  say({ t: 'utt', text, score: score === null ? null : +score.toFixed(3), ok, secs: +secs.toFixed(1) });
}

function drainVad() {
  const on = vad.isDetected();
  if (on !== vadWasOn) { vadWasOn = on; say({ t: 'vad', on }); }
  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    try { processSegment(seg.samples); } catch (e) { say({ t: 'err', m: `segment: ${e.message}` }); }
  }
}

// Silero wants exact 512-sample windows; the mic sends whatever it sends. Buffer between.
const pending = new sherpa.CircularBuffer(30 * SR);
function onAudio(b64) {
  const raw = Buffer.from(b64, 'base64');
  const int16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  pending.push(f32);
  while (pending.size() >= 512) {
    vad.acceptWaveform(pending.get(pending.head(), 512));
    pending.pop(512);
  }
  drainVad();
}

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    switch (msg.t) {
      case 'a': onAudio(msg.d); break;
      case 'cfg':
        profile = Array.isArray(msg.profile) && msg.profile.length
          ? msg.profile.map((v) => Float32Array.from(v)) : null;
        if (typeof msg.threshold === 'number') threshold = msg.threshold;
        if (msg.voices) edgeVoices = { ...edgeVoices, ...msg.voices };
        log(`cfg: ${profile ? `${profile.length} voiceprint(s), threshold ${threshold}` : 'no voiceprint — gate open'}`
          + ` · voice: ${edgeVoices.enabled ? edgeVoices.tr + ' (edge)' : 'piper only'}`);
        break;
      case 'enroll': enrollArmed = true; break;
      case 'enroll-cancel': enrollArmed = false; break;
      case 'speak':
        synthBest(msg.text, msg.lang === 'en' ? 'en' : 'tr')
          .then(({ wav, secs, via }) => say({ t: 'spoke', id: msg.id, wav, secs: +secs.toFixed(2), via }))
          .catch((e) => say({ t: 'err', m: `speak: ${e.message}` }));
        break;
      case 'flush': vad.flush(); drainVad(); break;
    }
  } catch (e) {
    say({ t: 'err', m: `${msg.t}: ${e.message}` });
  }
});

process.stdin.on('end', () => process.exit(0));
say({ t: 'ready' });
