'use strict';

/* The microphone, as the engine wants it: mono, 16kHz, 16-bit, ~120ms at a time.
 * getUserMedia only exists in the renderer, so capture starts here; everything after
 * the resample happens across the bridge in main. Exposes window.hauntMic. */

(() => {
  const TARGET_SR = 16000;
  const CHUNK = 1920;              // 120ms at 16k — small enough to feel live, big enough not to spam IPC

  let ctx = null, stream = null, node = null;
  let acc = new Int16Array(CHUNK), accLen = 0;
  let readPos = 0;                 // fractional read cursor into the incoming stream, in source samples
  let level = 0;                   // 0..1 smoothed RMS — the orb draws THIS, the real signal

  // Linear-interpolation resampler. The context's rate is whatever the hardware likes
  // (48k usually, 44.1k sometimes) — a fixed /3 decimation would quietly detune 44.1k
  // into chipmunk PCM and whisper would transcribe soup.
  let carry = new Float32Array(0);
  function feed(block, srcRate) {
    // The visualizer's feed: fast attack, slow decay, so a syllable registers and the
    // fall-off reads as motion rather than flicker.
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.min(1, Math.sqrt(sum / block.length) * 6);
    level = rms > level ? rms : level * 0.92;

    const ratio = srcRate / TARGET_SR;
    const joined = new Float32Array(carry.length + block.length);
    joined.set(carry, 0); joined.set(block, carry.length);
    let i = readPos;
    while (i + 1 < joined.length) {
      const lo = Math.floor(i), frac = i - lo;
      const s = joined[lo] * (1 - frac) + joined[lo + 1] * frac;
      acc[accLen++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (accLen === CHUNK) { window.haunt.voice.frame(acc.buffer.slice(0)); accLen = 0; }
      i += ratio;
    }
    const keepFrom = Math.floor(i);
    carry = joined.slice(keepFrom);
    readPos = i - keepFrom;
  }

  // The audio thread's half of the tap, INLINED and loaded from a Blob on purpose:
  // in the packaged app this page lives inside app.asar, and Chromium's loader cannot
  // fetch a worklet module out of an asar — addModule('mic-worklet.js') "resolves" yet
  // registers nothing, and AudioWorkletNode dies with "mic-tap is not defined". Found
  // live: the dev app always worked because there the file is real. Same family as
  // native modules needing asarUnpack. Hand every 128-sample block over untouched —
  // that thread has a deadline every 2.7ms; the resample happens over here.
  const WORKLET = `
    class MicTap extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0]?.[0];
        if (ch) this.port.postMessage(ch.slice(0));
        return true;
      }
    }
    registerProcessor('mic-tap', MicTap);
  `;

  let starting = null;    // two callers, one AudioContext — never interleave two starts
  function start() {
    if (ctx) return Promise.resolve(true);
    if (starting) return starting;
    starting = (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        ctx = new AudioContext();
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
        const src = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, 'mic-tap');
        node.port.onmessage = (e) => feed(e.data, ctx.sampleRate);
        src.connect(node);
        // deliberately NOT connected to ctx.destination: this is a tap, not a monitor
        return true;
      } catch (e) {
        console.warn('mic:', e.message);
        stop();
        return false;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function stop() {
    try { node?.disconnect(); } catch { /* half-built */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* half-built */ }
    try { ctx?.close(); } catch { /* half-built */ }
    ctx = null; stream = null; node = null;
    accLen = 0; carry = new Float32Array(0); readPos = 0;
    level = 0;
  }

  window.hauntMic = { start, stop, get live() { return !!ctx; }, get level() { return level; } };
})();
