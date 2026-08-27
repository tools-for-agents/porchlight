'use strict';

// jarvis's pure parts, pinned down: the wake word as whisper actually mangles it, the
// ANSI stripper that turns a TUI recording into text, and the brain-reply parser that
// must survive a model wrapping its JSON in prose or fences. No Electron, no models —
// the impure edges (mic, sherpa, claude -p) are covered by engine.js's CLI selftest.

const { test } = require('node:test');
const assert = require('node:assert');

const { matchWake, guessLang } = require('../src/voice/wake.js');
const { stripAnsi, tail } = require('../src/voice/ansi.js');
const { parseReply, buildContext, buildPrompt, memoryDirFor } = require('../src/voice/brain.js');
const { parseBayId, chooseSlot, inferProjectsDir } = require('../src/voice/jarvis.js');

// ── wake ─────────────────────────────────────────────────────────────────────
test('the wake word survives whisper: jarvis, Jarvis!, carvis, Çarvis, jarvıs all wake', () => {
  for (const heard of [
    'jarvis bay üç nasıl gidiyor',
    'Jarvis, how is bay three?',
    'Carvis bay üç nasıl',
    'Çarvis, durum ne?',
    'jarvıs testleri çalıştır',
  ]) {
    assert.ok(matchWake(heard), `"${heard}" should wake`);
  }
});

test('the command is what comes AFTER the wake word, original casing kept', () => {
  assert.equal(matchWake('Jarvis, bay üç nasıl gidiyor?').command, 'bay üç nasıl gidiyor?');
  assert.equal(matchWake("Jarvis'e göre durum ne").command, 'göre durum ne');
  assert.equal(matchWake('Jarvis.').command, '');
});

test('a sentence merely ABOUT jarvis, or without it, does not wake', () => {
  assert.equal(matchWake('bay üçte jarvis kelimesi geçiyor mu bilmiyorum'), null);
  assert.equal(matchWake('merhaba dünya nasılsın bugün'), null);
  assert.equal(matchWake(''), null);
  // "servis" is a real Turkish word one edit from carvis — it must NOT wake
  assert.equal(matchWake('servis katmanı bozuldu galiba'), null);
});

test('mira: her name wakes, in any of its whisper spellings, alongside jarvis', () => {
  const WAKES = ['mira', 'jarvis'];   // the shipped default
  assert.equal(matchWake('Mira, bay üç nasıl gidiyor?', WAKES).command, 'bay üç nasıl gidiyor?');
  assert.equal(matchWake('mira testleri çalıştır', WAKES).command, 'testleri çalıştır');
  assert.equal(matchWake("Mira'ya söylüyorum, dur", WAKES).command, 'söylüyorum, dur');
  assert.ok(matchWake('Jarvis, durum ne?', WAKES), 'the old habit still answers');
});

test('mira: near-words with a different first letter can never summon her', () => {
  const WAKES = ['mira', 'jarvis'];
  assert.equal(matchWake('bira alalım mı bugün', WAKES), null);       // 1 edit away, wrong start
  assert.equal(matchWake('mimar bey geldi az önce', WAKES), null);    // right start, 2 edits, short name allows 1
  assert.equal(matchWake('bay üç mira kelimesini yazdı', WAKES), null); // about her, not to her
});

test('guessLang: Turkish by letters or stopwords, English otherwise', () => {
  assert.equal(guessLang('çalışıyor mu bilmiyorum'), 'tr');
  assert.equal(guessLang('tamam devam et'), 'tr');
  assert.equal(guessLang('run the tests and report back'), 'en');
});

// ── ansi ─────────────────────────────────────────────────────────────────────
test('stripAnsi: colours, cursor moves, OSC titles and \\r all vanish; words stay', () => {
  const tui = '\x1b]0;claude\x07\x1b[2J\x1b[1;32m✓ tests passed\x1b[0m\r\n\x1b[?25lrunning build\x1b[?25h';
  const out = stripAnsi(tui);
  assert.ok(out.includes('✓ tests passed'));
  assert.ok(out.includes('running build'));
  assert.ok(!/[\x00-\x09\x0b-\x1f]/.test(out), 'no control chars survive');
  assert.ok(!out.includes('claude'), 'the OSC title was chrome, not content');
});

test('tail: last n chars only, whole lines, stripped', () => {
  const buf = 'x'.repeat(5000) + '\nline A\n\x1b[31mline B\x1b[0m\nline C';
  const t = tail(buf, 30);
  assert.ok(t.endsWith('line C'));
  assert.ok(!t.includes('\x1b'));
  assert.ok(!t.startsWith('x') || t.indexOf('\n') === -1 || t.split('\n')[0].length < 30);
});

// ── brain reply parsing ──────────────────────────────────────────────────────
test('a clean reply parses; bad actions are dropped, not fatal', () => {
  const r = parseReply(JSON.stringify({
    say: 'Bay üç testleri koşuyor.',
    lang: 'tr',
    actions: [
      { type: 'send', bay: 'pg_1s2', text: 'run the tests' },
      { type: 'send', bay: 'pg_1s2' },                        // no text → dropped
      { type: 'launch-missiles', bay: 'pg_1s2' },             // unknown type → dropped
      { type: 'esc', bay: 'pg_1s0' },
    ],
  }));
  assert.equal(r.say, 'Bay üç testleri koşuyor.');
  assert.equal(r.lang, 'tr');
  assert.equal(r.actions.length, 2);
  assert.equal(r.actions[0].type, 'send');
  assert.equal(r.actions[1].type, 'esc');
});

test('models wrap JSON in fences and prose; the parser digs it out', () => {
  const fenced = 'Sure! Here is the response:\n```json\n{"say":"All good.","actions":[]}\n```\nHope that helps!';
  assert.equal(parseReply(fenced).say, 'All good.');
  const braces = 'Note: {"say":"Done — I sent {\\"quoted\\"} text.","actions":[]} trailing words';
  assert.equal(parseReply(braces).say, 'Done — I sent {"quoted"} text.');
});

test('garbage, empty say, or no JSON at all → null, never a throw', () => {
  assert.equal(parseReply('I cannot answer that.'), null);
  assert.equal(parseReply('{"say":""}'), null);
  assert.equal(parseReply('{"broken": '), null);
  assert.equal(parseReply(''), null);
});

// ── memory plumbing ──────────────────────────────────────────────────────────
test('memoryDirFor: the munge Claude Code actually uses — every / and . becomes -', () => {
  assert.equal(
    memoryDirFor('/Users/fatih/Dev/toolsforagents', '/Users/fatih'),
    '/Users/fatih/.claude/projects/-Users-fatih-Dev-toolsforagents/memory',
  );
  assert.equal(
    memoryDirFor('/a/b.app', '/h'),
    '/h/.claude/projects/-a-b-app/memory',
  );
});

test('buildPrompt: memory indexes ride inline, with their dirs, and the write rules', () => {
  const snap = { pageIndex: 0, focusedBayId: null, pages: [{ id: 'p', bays: [] }], running: {} };
  const mem = [{ title: 'hangar', dir: '/h/.claude/projects/x/memory', index: '- [mission](m.md) — ship it' }];
  const p = buildPrompt(snap, 'şu iş nasıl gidiyor', [], mem);
  assert.ok(p.includes('ship it'), 'the index content is in the prompt');
  assert.ok(p.includes('/h/.claude/projects/x/memory'), 'and the dir the files live in');
  assert.ok(p.includes('WRITE'), 'the brain is told it may persist memory');
  assert.ok(p.includes('şu iş'), 'natural references are taught, not hoped for');
  const bare = buildPrompt(snap, 'selam', []);
  assert.ok(!bare.includes('What you remember'), 'no memory, no empty memory block');
});

// ── the orchestrator's pure pieces ───────────────────────────────────────────
test('parseBayId: the renderer id scheme, round-tripped — including an s in the page id', () => {
  assert.deepEqual(parseBayId('pg_abc123s4'), { pageId: 'pg_abc123', slot: 4 });
  assert.deepEqual(parseBayId('pg_s9sts0'), { pageId: 'pg_s9st', slot: 0 });
  assert.equal(parseBayId('nonsense'), null);
  assert.equal(parseBayId(''), null);
});

test('chooseSlot: the page on screen first, any page second, a new page last', () => {
  const full = { id: 'a', bays: Array(9).fill({ path: '/x', title: 'x' }) };
  const holey = { id: 'b', bays: [{ path: '/x', title: 'x' }, null, ...Array(7).fill(null)] };
  assert.deepEqual(chooseSlot([holey, full], 0), { pi: 0, slot: 1, newPage: false });
  assert.deepEqual(chooseSlot([full, holey], 0), { pi: 1, slot: 1, newPage: false }, 'preferred full → spill to the other');
  assert.deepEqual(chooseSlot([full], 0), { pi: 1, slot: 0, newPage: true }, 'everything full → a fresh page');
});

test('inferProjectsDir: new projects go where the existing ones already live', () => {
  const pages = [{ id: 'a', bays: [
    { path: '/u/dev/one' }, { path: '/u/dev/two' }, { path: '/u/elsewhere/three' },
    ...Array(6).fill(null)] }];
  assert.equal(inferProjectsDir(pages, '/u/Projects'), '/u/dev');
  assert.equal(inferProjectsDir([], '/u/Projects'), '/u/Projects', 'no bays yet → the fallback');
});

test('parseReply: the fleet actions survive, and a start without a path does not', () => {
  const r = parseReply(JSON.stringify({ say: 'Tamam.', lang: 'tr', actions: [
    { type: 'start', path: 'yeniproje', create: true, text: 'Build a snake game.' },
    { type: 'start' },                       // no path → dropped
    { type: 'close', bay: 'pg_1s0' },
    { type: 'restart', bay: 'pg_1s1' },
    { type: 'kill', bay: 'pg_1s2' },
  ] }));
  assert.equal(r.actions.length, 4);
  assert.equal(r.actions[0].type, 'start');
  assert.equal(r.actions[0].create, true);
});

// ── brain context ────────────────────────────────────────────────────────────
test('buildContext: ids, spoken numbers, RUNNING/FOCUSED marks, whole-fleet tails', () => {
  const snap = {
    pageIndex: 0,
    focusedBayId: 'pg_a s1'.replace(' ', ''),
    pages: [
      { id: 'pg_a', bays: [{ title: 'hangar', path: '/x/hangar' }, { title: 'iris', path: '/x/iris' }, null, null, null, null, null, null, null] },
      { id: 'pg_b', bays: [{ title: 'scout', path: '/x/scout' }, null, null, null, null, null, null, null, null] },
    ],
    running: {
      pg_as0: { buf: '\x1b[32mtests: 12 passed\x1b[0m\n' },
      pg_bs0: { buf: 'scout is reading the docs page\n' },
    },
  };
  const ctx = buildContext(snap);
  assert.ok(ctx.includes('bay 1 [id=pg_as0] "hangar"'));
  assert.ok(ctx.includes('RUNNING'));
  assert.ok(ctx.includes('FOCUSED'), 'bay 2 on page 1 is where the user is');
  assert.ok(ctx.includes('tests: 12 passed'), 'on-screen running bay shows its tail');
  assert.ok(ctx.includes('scout is reading'), 'an orchestrator sees off-screen sessions too');
  assert.ok(ctx.includes('Page 2'));
});
