'use strict';

// The bay list is the only thing hangar remembers, and it once forgot seven of somebody's.
// These tests are that bug, written down. They need no Electron and no window: state.js
// takes a directory, which is the whole reason it is a separate file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { stateStore, emptyState, BAYS_PER_PAGE } = require('../src/state.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-state-'));
const seven = () => ({
  pages: [{
    id: 'pg_main',
    bays: [
      { path: '/a', title: 'a' }, { path: '/b', title: 'b' }, { path: '/c', title: 'c' },
      { path: '/d', title: 'd' }, { path: '/e', title: 'e' }, { path: '/f', title: 'f' },
      { path: '/g', title: 'g' }, null, null,
    ],
  }],
});
const bayCount = (s) => s.pages.flatMap((p) => p.bays).filter(Boolean).length;

test('a first run is not a failure: no file at all reads as an empty grid, ok', () => {
  const dir = tmp();
  const s = stateStore(dir).load();
  assert.equal(s.ok, true, 'a missing file is a first run, and a first run is fine');
  assert.equal(s.pages.length, 1);
  assert.equal(s.pages[0].bays.length, BAYS_PER_PAGE);
  assert.ok(s.pages[0].bays.every((b) => b === null), 'and it is empty');
});

test('a good file round-trips', () => {
  const dir = tmp();
  const st = stateStore(dir);
  st.save(seven());
  const s = st.load();
  assert.equal(s.ok, true);
  assert.equal(bayCount(s), 7);
  assert.equal(s.pages[0].bays[0].title, 'a');
});

// 🔑 THE BUG, WRITTEN DOWN. An unreadable file and an empty one used to return the same
// value, so the renderer could not tell them apart — it stamped ids on the "empty" default
// and saved it straight over seven real bays. `ok` is the whole difference: it is the flag
// the renderer reads as "show a clean grid, but do not write anything until the user acts".
test('an UNREADABLE file reports ok:false — it must never look like an empty one', () => {
  const dir = tmp();
  const st = stateStore(dir);
  fs.writeFileSync(st.stateFile(), '{ this is not json');

  const s = st.load();
  assert.equal(s.ok, false, 'a read that failed must SAY it failed');
  assert.ok(s.error, 'and say why');

  // The tell: the two cases must not be confusable. A first run is ok:true; this is not.
  const firstRun = stateStore(tmp()).load();
  assert.equal(firstRun.ok, true);
  assert.notEqual(s.ok, firstRun.ok, 'ok is the only thing standing between a bad read and a save');
});

test('an unreadable file is copied aside, not overwritten — it is the only copy of somebody\'s work', () => {
  const dir = tmp();
  const st = stateStore(dir);
  fs.writeFileSync(st.stateFile(), '{ half a fi');
  st.load();
  assert.ok(fs.existsSync(`${st.stateFile()}.corrupt`), 'the wreckage is kept');
  assert.equal(fs.readFileSync(`${st.stateFile()}.corrupt`, 'utf8'), '{ half a fi', 'verbatim');
});

test('a torn file with a good backup recovers the bays instead of losing them', () => {
  const dir = tmp();
  const st = stateStore(dir);
  st.save(seven());          // writes state.json
  st.save(seven());          // ...and now state.bak.json holds the last good one
  fs.writeFileSync(st.stateFile(), '{ torn');

  const s = st.load();
  assert.equal(s.ok, true, 'recovered, so the renderer may write again');
  assert.equal(s.recovered, true, 'and it says it recovered rather than pretending nothing happened');
  assert.equal(bayCount(s), 7, 'all seven came back');
});

test('a file that parses but is not a state file is treated as unreadable, not as truth', () => {
  const dir = tmp();
  const st = stateStore(dir);
  for (const junk of ['{}', '[]', 'null', '{"pages":[]}', '{"pages":"nope"}', '42']) {
    fs.writeFileSync(st.stateFile(), junk);
    const s = st.load();
    assert.equal(s.ok, false, `${junk} is valid JSON and is not a state file`);
  }
});

// 🔑 THE OTHER HALF OF THE SAME BUG: saveState wrote in place, so a reader could catch a
// half-written file and throw — which is how the file became unreadable in the first place.
// tmp + rename means a reader sees the old file or the new one, never a torn one.
//
// 🔑 AND THE FIRST VERSION OF THIS TEST WAS DECORATION. It asserted "no .tmp left behind"
// and called that atomicity — but a plain in-place write leaves no .tmp either, so it passed
// against the exact bug it was named after. A deliberate mutation is what exposed it: swap
// tmp+rename for writeFileSync(stateFile) and 11/11 stayed green. Atomicity is a claim about
// HOW the bytes land, and nothing you can see in the directory afterwards can tell you. So
// watch the calls: the real file must never be handed to writeFileSync, and the bytes must
// arrive by rename.
test('save is atomic: the real file is only ever moved into place, never written in place', () => {
  const dir = tmp();
  const calls = [];
  const spy = { ...fs };
  for (const m of ['mkdirSync', 'existsSync', 'copyFileSync', 'writeFileSync', 'renameSync', 'readFileSync']) {
    spy[m] = (...a) => { calls.push({ m, args: a }); return fs[m](...a); };
  }
  const st = stateStore(dir, () => {}, spy);
  st.save(seven());

  const wrote = calls.filter((c) => c.m === 'writeFileSync').map((c) => c.args[0]);
  const renamed = calls.filter((c) => c.m === 'renameSync').map((c) => c.args);

  assert.ok(!wrote.includes(st.stateFile()),
    `state.json was written in place — a reader can catch it torn. writeFileSync saw: ${wrote.join(', ')}`);
  assert.equal(wrote.length, 1, 'exactly one write, and it is the temp file');
  assert.equal(renamed.length, 1, 'and exactly one rename');
  assert.equal(renamed[0][1], st.stateFile(), 'the rename lands ON state.json — that is the atomic step');
  assert.equal(renamed[0][0], wrote[0], 'and it renames the very file that was written');

  // and it still, you know, works
  assert.equal(bayCount(st.load()), 7);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'no litter');
});

test('save keeps the previous good copy beside it before replacing anything', () => {
  const dir = tmp();
  const st = stateStore(dir);
  st.save(seven());
  const one = { pages: [{ id: 'pg_main', bays: Array(BAYS_PER_PAGE).fill(null) }] };
  st.save(one);

  assert.equal(bayCount(st.load()), 0, 'the new state is what loads');
  const bak = JSON.parse(fs.readFileSync(st.backupFile(), 'utf8'));
  assert.equal(bayCount(bak), 7, 'and the seven bays are still on disk, one file over');
});

test('save into a directory that does not exist yet still works', () => {
  const dir = path.join(tmp(), 'not', 'created', 'yet');
  const st = stateStore(dir);
  st.save(seven());
  assert.equal(bayCount(st.load()), 7);
});

test('a launcher that cannot write is still a launcher — save never throws', () => {
  const dir = tmp();
  const st = stateStore(dir);
  fs.chmodSync(dir, 0o500);                       // read-only: the write cannot land
  try {
    assert.doesNotThrow(() => st.save(seven()), 'a failed save must not take the app down with it');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

// The other half of "never throws": never SILENT. load() narrates every failure; a save that fails into
// an empty catch is how "why aren't my bays persisting?" becomes unanswerable, in the one module that has
// already lost somebody's bays once. So a failed save must still not throw — but it must say so.
test('a save that fails is logged, not swallowed — never throws, but never silent either', () => {
  const dir = tmp();
  const msgs = [];
  const io = { ...fs, writeFileSync: () => { throw new Error('disk full'); } };   // the bytes cannot land
  const st = stateStore(dir, (m) => msgs.push(String(m)), io);
  assert.doesNotThrow(() => st.save(seven()), 'a failed save still must not take the app down');
  assert.ok(msgs.some((m) => /FAILED|not persisted/i.test(m)),
    `the failure must be visible in the debug log, like load() would — saw: ${JSON.stringify(msgs)}`);
});

test('emptyState is a real empty grid, not a shape that only looks like one', () => {
  const e = emptyState();
  assert.equal(e.pages.length, 1);
  assert.equal(e.pages[0].bays.length, BAYS_PER_PAGE);
  assert.ok(e.pages[0].bays.every((b) => b === null));
  // Two calls must not share an array — one page's edits would show up in the other's.
  const a = emptyState(); const b = emptyState();
  a.pages[0].bays[0] = { path: '/x', title: 'x' };
  assert.equal(b.pages[0].bays[0], null, 'each call gets its own grid');
});
