'use strict';

// A bay's buffer is a TUI recording: cursor moves, colours, alternate-screen swaps —
// mostly escape codes by volume. The brain reads TEXT. This strips every ANSI/VT
// sequence and control char except newline, then squeezes the blank lines the erasures
// leave behind. Pure, tested.

const PATTERNS = [
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,   // OSC (title set, hyperlinks) — BEL or ST terminated
  /\x1b\[[0-9;?]*[ -/]*[@-~]/g,           // CSI (colours, cursor, erase)
  /\x1b[PX^_][^\x1b]*\x1b\\/g,            // DCS/SOS/PM/APC
  /\x1b[@-Z\\-_]/g,                       // two-char escapes (charset, keypad...)
  /[\x00-\x08\x0b-\x1f\x7f]/g,            // raw control chars; \n (0x0a) survives, \r dies
];

function stripAnsi(s) {
  let out = String(s || '');
  for (const re of PATTERNS) out = out.replace(re, '');
  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** The last `n` characters of a buffer, as readable text, whole lines only. */
function tail(buf, n = 1500) {
  const text = stripAnsi(buf);
  if (text.length <= n) return text.trim();
  const cut = text.slice(-n);
  const nl = cut.indexOf('\n');
  return (nl === -1 ? cut : cut.slice(nl + 1)).trim();
}

module.exports = { stripAnsi, tail };
