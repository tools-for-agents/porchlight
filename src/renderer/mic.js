'use strict';

/* The microphone, as the engine wants it: mono, 16kHz, 16-bit, ~120ms at a time.
 * getUserMedia only exists in the renderer, so capture starts here; everything after
 * the resample happens across the bridge in main. Exposes window.hangarMic. */

(() => {
  const TARGET_SR = 16000;
  const CHUNK = 1920;              // 120ms at 16k — small enough to feel live, big enough not to spam IPC

  let ctx = null, stream = null, node = null;
  let acc = new Int16Array(CHUNK), accLen = 0;
  let readPos = 0;                 // fractional read cursor into the incoming stream, in source samples

  // Linear-interpolation resampler. The context's rate is whatever the hardware likes
  // (48k usually, 44.1k sometimes) — a fixed /3 decimation would quietly detune 44.1k
  // into chipmunk PCM and whisper would transcribe soup.
  let carry = new Float32Array(0);
  function feed(block, srcRate) {
    const ratio = srcRate / TARGET_SR;
    const joined = new Float32Array(carry.length + block.length);
    joined.set(carry, 0); joined.set(block, carry.length);
    let i = readPos;
    while (i + 1 < joined.length) {
      const lo = Math.floor(i), frac = i - lo;
      const s = joined[lo] * (1 - frac) + joined[lo + 1] * frac;
      acc[accLen++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (accLen === CHUNK) { window.hangar.voice.frame(acc.buffer.slice(0)); accLen = 0; }
      i += ratio;
    }
    const keepFrom = Math.floor(i);
    carry = joined.slice(keepFrom);
    readPos = i - keepFrom;
  }

  async function start() {
    if (ctx) return true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule('mic-worklet.js');
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
    }
  }

  function stop() {
    try { node?.disconnect(); } catch { /* half-built */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* half-built */ }
    try { ctx?.close(); } catch { /* half-built */ }
    ctx = null; stream = null; node = null;
    accLen = 0; carry = new Float32Array(0); readPos = 0;
  }

  window.hangarMic = { start, stop, get live() { return !!ctx; } };
})();
