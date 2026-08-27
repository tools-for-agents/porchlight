'use strict';

// jarvis's brain is `claude -p`: the transcript plus a snapshot of every bay goes in,
// strict JSON comes out — what to SAY, and optionally what to TYPE into which bay. The
// intelligence lives in the model; this file only packs the context and unpacks the
// answer. buildPrompt and parseReply are pure and tested; ask() is the one impure edge.

const { execFile } = require('node:child_process');
const { tail } = require('./ansi.js');

/**
 * @param {object} snap
 *   { pages: [{ id, bays: [{title,path}|null x9] }], pageIndex, focusedBayId,
 *     running: { [bayId]: { buf } } }   — running comes from main's live bays map
 * @returns {string} the context block the model reads
 */
function buildContext(snap) {
  const lines = [];
  snap.pages.forEach((page, pi) => {
    const here = pi === snap.pageIndex;
    lines.push(`Page ${pi + 1}${here ? ' (the one on screen)' : ''}:`);
    page.bays.forEach((bay, slot) => {
      if (!bay) return;
      const id = `${page.id}s${slot}`;
      const live = snap.running[id];
      const marks = [
        live ? 'RUNNING' : 'stopped',
        id === snap.focusedBayId ? 'FOCUSED — this is "here"/"bura"/"şu"' : '',
      ].filter(Boolean).join(', ');
      lines.push(`  bay ${slot + 1} [id=${id}] "${bay.title}" (${bay.path}) — ${marks}`);
      if (live && here) {
        const t = tail(live.buf, 1200);
        if (t) lines.push('    last output:\n' + t.split('\n').map((l) => '      ' + l).join('\n'));
      }
    });
    if (page.bays.every((b) => !b)) lines.push('  (empty)');
  });
  return lines.join('\n');
}

function buildPrompt(snap, transcript, history) {
  const past = (history || [])
    .map((h) => `user said: ${h.heard}\nyou said: ${h.said}`)
    .join('\n');
  return [
    'You are jarvis, the voice of "hangar" — a desktop app running Claude Code agents in a 3x3 grid of',
    'terminal tiles called bays. The user SPOKE to you; your reply will be READ ALOUD by TTS.',
    '',
    'Bays right now (numbers are what the user says out loud; ids are what actions take):',
    buildContext(snap),
    past ? '\nRecent exchange:\n' + past : '',
    '',
    `The user just said: "${transcript}"`,
    '',
    'Answer ONLY with a JSON object, no markdown fences, no prose around it:',
    '{"say": "<spoken reply>", "lang": "tr"|"en", "actions": [{"type":"send","bay":"<id>","text":"<prompt for that agent>"} | {"type":"esc","bay":"<id>"}]}',
    '',
    'Rules:',
    '- "say" is SPEECH: short (1-3 sentences), natural, no lists, no file paths, no code. Match the language the user spoke.',
    '- Asked how a bay is doing → read its last output above and summarize what the agent is actually doing.',
    '- Told to do something in a project → action "send": write the instruction as a clear prompt for that bay\'s',
    '  Claude agent (in the language the codebase/agent works in — usually matching the user), and "say" confirms it briefly.',
    '- "Stop/dur/iptal" for a bay → action "esc" (interrupts that agent).',
    '- Ambiguous which bay → no actions; ask in "say".',
    '- Sounds destructive (deleting, force-pushing, killing work) → no actions; ask for confirmation in "say".',
    '- Nothing to do (a question, a chat) → "actions": [].',
  ].filter((s) => s !== '').join('\n');
}

/** Pull the reply object out of whatever the model actually returned. Null if hopeless. */
function parseReply(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  // scan to the matching close brace so trailing prose does not poison the parse
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = inStr; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i; break; }
  }
  if (end === -1) return null;
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (typeof obj?.say !== 'string' || !obj.say.trim()) return null;
  const actions = Array.isArray(obj.actions)
    ? obj.actions.filter((a) => a && (
        (a.type === 'send' && typeof a.bay === 'string' && typeof a.text === 'string' && a.text.trim()) ||
        (a.type === 'esc' && typeof a.bay === 'string')))
    : [];
  return { say: obj.say.trim(), lang: obj.lang === 'en' ? 'en' : obj.lang === 'tr' ? 'tr' : null, actions };
}

/**
 * The impure edge: run `claude -p` with the packed prompt on stdin.
 * @returns {Promise<{say,lang,actions}|null>}
 */
function ask({ bin, env, model, snap, transcript, history, timeoutMs = 90_000, dbg = () => {} }) {
  return new Promise((resolve) => {
    const prompt = buildPrompt(snap, transcript, history);
    dbg(`brain: asking ${model} (${prompt.length} chars)`);
    const t0 = Date.now();
    const child = execFile(bin, ['-p', '--model', model], { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { dbg(`brain: ${err.message}`); return resolve(null); }
        const reply = parseReply(stdout);
        dbg(`brain: ${reply ? 'ok' : 'UNPARSEABLE'} after ${Date.now() - t0}ms`);
        resolve(reply);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

module.exports = { buildContext, buildPrompt, parseReply, ask };
