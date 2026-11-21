'use strict';

// jarvis's brain is `claude -p`: the transcript plus a snapshot of every bay goes in,
// strict JSON comes out — what to SAY, and optionally what to TYPE into which bay. The
// intelligence lives in the model; this file only packs the context and unpacks the
// answer. buildPrompt and parseReply are pure and tested; ask() is the one impure edge.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tail } = require('./ansi.js');

// ── memory ───────────────────────────────────────────────────────────────────
// Claude Code keeps a per-project memory at ~/.claude/projects/<munged-cwd>/memory —
// the munge is every / and . flattened to '-'. Mira's brain gets each bay's MEMORY.md
// index INLINE (small, instant) and reads the files behind it with its own tools when
// an answer needs more than the index line.
function memoryDirFor(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', String(cwd).replace(/[/.]/g, '-'), 'memory');
}

function gatherMemory(snap, home = os.homedir()) {
  const dirs = [];
  for (const page of snap.pages) {
    for (const bay of page.bays || []) if (bay) dirs.push({ title: bay.title, dir: memoryDirFor(bay.path, home) });
  }
  dirs.push({ title: 'global (home)', dir: memoryDirFor(home, home) });
  const seen = new Set(), out = [];
  for (const { title, dir } of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      out.push({ title, dir, index: fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').slice(0, 4000) });
    } catch { /* no memory there — not every folder has a past */ }
  }
  return out.slice(0, 6);
}

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
      if (live) {
        // The orchestrator sees the WHOLE fleet: on-screen bays in detail, the rest
        // abridged — enough to answer "başka sayfadaki oyun ne durumda" without a page turn.
        const t = tail(live.buf, here ? 1200 : 600);
        if (t) lines.push('    last output:\n' + t.split('\n').map((l) => '      ' + l).join('\n'));
      }
    });
    if (page.bays.every((b) => !b)) lines.push('  (empty)');
  });
  return lines.join('\n');
}

function buildPrompt(snap, transcript, history, mem = [], projectsDir = '', replyLang = 'match') {
  const past = (history || [])
    .map((h) => `user said: ${h.heard}\nyou said: ${h.said}`)
    .join('\n');
  const memBlock = mem.length
    ? '\nWhat you remember (each project\'s MEMORY.md index; the files it points at live in the same dir):\n'
      + mem.map((m) => `--- ${m.title} · ${m.dir} ---\n${m.index}`).join('\n')
    : '';
  return [
    'You are Mira, the voice of "haunt" — a desktop app running Claude Code agents in a 3x3 grid of',
    'terminal tiles called bays. (The user may also call you jarvis; both are you.)',
    'The user SPOKE to you; your reply will be READ ALOUD by TTS.',
    '',
    'Bays right now (numbers are what the user says out loud; ids are what actions take):',
    buildContext(snap),
    past ? '\nRecent exchange:\n' + past : '',
    memBlock,
    '',
    `The user just said: "${transcript}"`,
    '',
    'You have tools (Read, Grep, Glob, Write, Bash). Use them when they make the answer TRUE rather than',
    'plausible — read the memory files behind an index line, grep a project, peek at a file a bay mentioned.',
    'Do not wander: a couple of reads, then answer. The user\'s standing rules are in ~/.claude/CLAUDE.md.',
    '',
    'MEMORY — you may also WRITE it. When the user asks you to remember something ("not al", "hatırla",',
    '"kaydet", "remember"), or a durable decision/fact emerges, persist it into the relevant project\'s',
    'memory dir (paths above): one markdown file per fact with the same frontmatter shape the dir already',
    'uses, plus a one-line pointer in that dir\'s MEMORY.md. Update an existing file over duplicating it.',
    'Never rewrite MEMORY.md wholesale — append or edit your one line.',
    '',
    'Your FINAL message must be ONLY this JSON object — no markdown fences, no prose around it:',
    '{"say": "<spoken reply>", "lang": "tr"|"en", "actions": [',
    '  {"type":"send","bay":"<id>","text":"<prompt for that agent>"}   — type into a running session',
    '  | {"type":"esc","bay":"<id>"}                                   — interrupt it (Esc)',
    '  | {"type":"start","path":"<folder or name>","title":"<tile name>","create":true|false,"text":"<optional first task>"}',
    '  | {"type":"kill","bay":"<id>"}                                  — stop the agent, keep the tile',
    '  | {"type":"restart","bay":"<id>"}                               — fresh agent, same folder',
    '  | {"type":"close","bay":"<id>"}                                 — stop AND empty the tile',
    ']}',
    '',
    'You are the fleet\'s orchestrator, not just a reporter — you may open sessions, close them, and',
    'create project folders:',
    `- "start": a bare name resolves under ${projectsDir || 'the user\'s projects dir'}; "create":true`,
    '  mkdirs it first (a brand-new project). Give "text" to hand the new agent its first task in the',
    '  same breath — it is typed in once the session is up. An existing project\'s path can come from',
    '  memory, the bays above, or a quick Glob of the projects dir.',
    '- "close" or "kill" on a bay that is mid-work needs spoken confirmation first, same as anything',
    '  destructive. Closing an idle or finished session is fine to just do.',
    '',
    'Rules:',
    // The owner's arrangement: they speak Turkish, mira answers in English — her voice
    // is only natural there. replyLang pins it; 'match' restores mirror-the-user.
    replyLang === 'match'
      ? '- "say" is SPEECH: short (1-3 sentences), natural, no lists, no file paths, no code. Match the language the user spoke.'
      : `- "say" is SPEECH: short (1-3 sentences), natural, no lists, no file paths, no code. ALWAYS answer in ${replyLang === 'en' ? 'ENGLISH — the user speaks Turkish to you and understands English fine; do NOT mirror their language' : 'TURKISH'}. Set "lang":"${replyLang}".`,
    '- The user talks about projects NATURALLY — by name ("haunt", "oyun"), by topic, or as "şu iş"/"bu',
    '  iş"/"orada". Resolve: an explicit name beats everything; "şu/bu iş" means the FOCUSED bay if there is',
    '  one, else whatever the recent exchange or memory says they were working on. Only ask when truly stuck.',
    '- Asked how something is going → the bay\'s last output above is the NOW; memory is the WHY. Combine them:',
    '  "what is it doing" from the terminal, "where is this in the bigger plan" from memory, briefly.',
    '- Told to do something in a project → action "send": write the instruction as a clear prompt for that bay\'s',
    '  Claude agent (in the language the codebase/agent works in — usually matching the user), and "say" confirms it briefly.',
    '- "Stop/dur/iptal" for a bay → action "esc" (interrupts that agent).',
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
        (['esc', 'kill', 'restart', 'close'].includes(a.type) && typeof a.bay === 'string') ||
        (a.type === 'start' && typeof a.path === 'string' && a.path.trim())))
    : [];
  return { say: obj.say.trim(), lang: obj.lang === 'en' ? 'en' : obj.lang === 'tr' ? 'tr' : null, actions };
}

/**
 * The impure edge: run `claude -p` with the packed prompt on stdin.
 *
 * This is the STRONG half of mira — the user's explicit spec: a heavyweight local agent
 * (opus at xhigh effort by default), with tools, running under the same
 * --dangerously-skip-permissions this whole app runs its bays under (the owner's
 * standing choice, see CLAUDE_ARGS in main.js) so it can read and write the memory
 * dirs the prompt names. Slow and right beats fast and shallow here; jarvis.js masks
 * the wait by speaking an acknowledgement first.
 * @returns {Promise<{say,lang,actions}|null>}
 */
function ask({ bin, env, model, effort, snap, transcript, history, projectsDir = '', replyLang = 'match', timeoutMs = 240_000, dbg = () => {} }) {
  return new Promise((resolve) => {
    const mem = gatherMemory(snap);
    const prompt = buildPrompt(snap, transcript, history, mem, projectsDir, replyLang);
    const args = ['-p', '--model', model, '--dangerously-skip-permissions'];
    if (effort) args.push('--effort', effort);
    dbg(`brain: asking ${model}${effort ? `/${effort}` : ''} (${prompt.length} chars, ${mem.length} memory indexes)`);
    const t0 = Date.now();
    const child = execFile(bin, args, { env, cwd: os.homedir(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
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

module.exports = { buildContext, buildPrompt, parseReply, ask, memoryDirFor, gatherMemory };
