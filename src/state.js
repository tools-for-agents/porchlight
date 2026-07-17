'use strict';

// ── State: which bay points at which folder ──────────────────────────────────
//
// Only paths and titles. No secrets pass through here — the agent authenticates itself with
// your own ~/.claude, exactly as it does in a terminal.
//
// This lives apart from main.js for one reason: main.js cannot be imported without Electron,
// and THE CODE THAT LOST A USER'S BAYS WAS IN IT. Untestable code that has already destroyed
// somebody's work once is not a thing to leave untested — so the part that decides whether to
// trust a file, and the part that writes one, take a directory and know nothing about `app`.

const fs = require('node:fs');
const path = require('node:path');

const BAYS_PER_PAGE = 9;

const emptyState = () => ({ pages: [{ id: 'pg_1', bays: Array(BAYS_PER_PAGE).fill(null) }] });

/**
 * @param {string} dir  where state.json lives (Electron: app.getPath('userData'))
 * @param {(...a: unknown[]) => void} [dbg]
 * @param {typeof fs} [io]  the filesystem. Injectable for ONE reason: "writes are atomic"
 *   is a claim about HOW the bytes land, and nothing observable afterwards can tell you
 *   whether they landed atomically. A test that only looked at the directory afterwards
 *   passed happily against a plain in-place write — it was decoration, and it took a
 *   deliberate mutation to find that out. With the seam, the claim is checkable.
 */
function stateStore(dir, dbg = () => {}, io = fs) {
  const stateFile = () => path.join(dir, 'state.json');
  const backupFile = () => path.join(dir, 'state.bak.json');

  // 🔑 A FAILED READ MUST NEVER CAUSE A WRITE.
  //
  // This lost a real user's bays. loadState() swallowed a parse error and returned an empty
  // default; the renderer then stamped ids on that default's pages and called save() — and the
  // empty default landed on top of seven bays somebody had actually set up. Two bugs holding
  // hands:
  //
  //   1. saveState wrote in place, so a reader could catch a half-written file and throw.
  //   2. loadState reported "I could not read it" and "there is nothing here" with the same
  //      value, so the caller could not tell the difference and saved over the wreckage.
  //
  // Now: writes are atomic (tmp + rename, so a reader sees old or new, never half), the last
  // good state is kept beside it, and a read that FAILS says so — `ok:false` — which the
  // renderer treats as "show a clean grid but do not write anything until the user acts".
  // An unreadable file is also copied aside rather than overwritten, because it is the only
  // copy of something that mattered.
  function load() {
    const read = (f) => {
      const s = JSON.parse(io.readFileSync(f, 'utf8'));
      if (!Array.isArray(s?.pages) || !s.pages.length) throw new Error('no pages');
      return s;
    };

    try {
      const s = read(stateFile());
      dbg(`loadState: ${stateFile()} — ${s.pages.length} page(s)`);
      return { ...s, ok: true };
    } catch (e) {
      if (!io.existsSync(stateFile())) {
        dbg('loadState: no state file — first run');
        return { ...emptyState(), ok: true };   // genuinely a first run
      }
      dbg(`loadState: UNREADABLE (${e?.message || e}) — trying the backup`);
      // The file is there and unreadable. Try the backup before giving up on someone's work.
      try {
        const b = read(backupFile());
        try { io.copyFileSync(stateFile(), `${stateFile()}.corrupt`); } catch { /* best effort */ }
        dbg(`loadState: recovered ${b.pages.length} page(s) from the backup`);
        return { ...b, ok: true, recovered: true };
      } catch { /* no usable backup either */ }
      try { io.copyFileSync(stateFile(), `${stateFile()}.corrupt`); } catch { /* best effort */ }
      dbg('loadState: no usable backup — ok:false, the renderer must not write over this');
      return { ...emptyState(), ok: false, error: String(e?.message || e) };
    }
  }

  function save(state) {
    try {
      io.mkdirSync(path.dirname(stateFile()), { recursive: true });
      // keep the last good one before replacing it
      try { if (io.existsSync(stateFile())) io.copyFileSync(stateFile(), backupFile()); } catch { /* best effort */ }
      const tmp = `${stateFile()}.${process.pid}.tmp`;
      io.writeFileSync(tmp, JSON.stringify(state, null, 2));
      io.renameSync(tmp, stateFile());          // atomic: a reader sees old or new
    } catch { /* a launcher that cannot remember is still a launcher */ }
  }

  return { load, save, stateFile, backupFile };
}

module.exports = { stateStore, emptyState, BAYS_PER_PAGE };
