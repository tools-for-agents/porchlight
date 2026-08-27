'use strict';

// The audio thread's half of the microphone: hand every 128-sample block to the main
// thread, untouched. Resampling happens over there — this thread has a deadline every
// 2.7ms and a dropped block is a glitch in what jarvis hears.
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
