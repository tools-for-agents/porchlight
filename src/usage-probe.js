#!/usr/bin/env node
'use strict';

// haunt's statusline, which is not a status line.
//
// Claude Code runs `statusLine.command` on every state change and pipes it a JSON blob
// describing the session — including rate_limits.five_hour and rate_limits.seven_day,
// the exact numbers the footer wants. Whatever the command PRINTS becomes the bar under
// the prompt.
//
// So this prints nothing, and writes the numbers to a file instead. Two things fall out
// of that one move:
//
//   1. The usage bar disappears from all nine tiles. Nine copies of the same two
//      percentages is eight copies too many, and the tiles are 20 rows tall.
//   2. haunt gets live usage from the real source — the same feed the user's own
//      statusline reads — with no extra `claude` invocation, no polling, and no token
//      of any kind. It costs nothing because Claude Code was going to run this anyway.
//
// It must never throw and never print: a statusline that errors puts its stderr under
// the user's prompt, and a statusline that is slow makes the session feel slow.

const fs = require('node:fs');
const path = require('node:path');

const OUT = process.env.HAUNT_USAGE_FILE
  || path.join(process.env.HOME || '', 'Library/Application Support/haunt/usage.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const s = JSON.parse(raw);
    const rl = s.rate_limits || {};
    const pick = (w) => (w ? {
      pct: Math.round(w.used_percentage ?? 0),
      resets_at: w.resets_at ?? 0,
    } : null);

    const next = {
      five_hour: pick(rl.five_hour),
      seven_day: pick(rl.seven_day),
      model: s.model?.display_name ?? s.model?.id ?? null,
      ts: Date.now(),
    };

    // Nine tiles write this file. A partial read is a footer full of NaN, so write a
    // temp file and rename it — rename is atomic, so a reader sees old or new, never half.
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const tmp = `${OUT}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, OUT);
  } catch {
    // A bad blob is not worth a line of red under someone's prompt.
  }
  // Print nothing. That is the bar, gone.
});
