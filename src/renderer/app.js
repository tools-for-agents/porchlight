'use strict';

/* hangar's renderer. It knows about bays, pages and terminals. It does not know how to
   run anything — main.js decides that, and it only ever decides `claude`. */

const BAYS_PER_PAGE = 9;
const { Terminal } = window;
const FitAddon = window.FitAddon?.FitAddon;

const $ = (s, r = document) => r.querySelector(s);
const grid = $('#grid');
const pagesNav = $('#pages');
const countEl = $('#count');
const killAllBtn = $('#killall');
const tpl = $('#bay-tpl');

/** state.pages[i].bays[j] = { path, title } | null  — the only thing we persist */
let state = { pages: [{ bays: Array(BAYS_PER_PAGE).fill(null) }] };
let pageIndex = 0;
let zoomed = null;      // bay id filling the grid, or null

/** id -> { term, fit, ro, running } for bays that have ever been rendered */
const terms = new Map();

// 🔑 A BAY'S ID MUST NOT MOVE WHEN A PAGE IS DELETED.
//
// These were positional (`p0s3`). Close page 1 and page 2 slides down into index 0 —
// every id on it changes, the pty living under the old key in main is orphaned, and the
// tile shows an empty terminal next to a process nobody can reach or kill. So the page
// carries an id it keeps for life, and the bay is that id plus its slot.
const pageId = (i) => state.pages[i]?.id || `p${i}`;
const bayId = (i, slot) => `${pageId(i)}s${slot}`;
const newPageId = () => `pg_${Math.random().toString(36).slice(2, 10)}`;

// Nine bays, nine hues, fixed to the slot so a bay's colour never moves under you.
// Slot-based rather than hashed from the folder: with nine of them a hash collides and
// two neighbours go the same colour, which is the one thing this has to never do.
const BAY_COLORS = [
  '#6ea8fe', // blue
  '#a78bfa', // violet
  '#4ade80', // green
  '#fbbf24', // amber
  '#f472b6', // pink
  '#22d3ee', // cyan
  '#fb923c', // orange
  '#a3e635', // lime
  '#f87171', // red
];
const bayColor = (slot) => BAY_COLORS[slot % BAY_COLORS.length];

const theme = {
  background: '#0d1117',
  foreground: '#e6ebf5',
  cursor: '#6ea8fe',
  selectionBackground: 'rgba(110,168,254,.3)',
  black: '#0b0e14', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
  blue: '#6ea8fe', magenta: '#a78bfa', cyan: '#67e8f9', white: '#e6ebf5',
  brightBlack: '#8a96ad', brightRed: '#fca5a5', brightGreen: '#86efac',
  brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#c4b5fd',
  brightCyan: '#a5f3fc', brightWhite: '#ffffff',
};

// ── persistence ─────────────────────────────────────────────────────────────
const save = () => window.hangar.saveState(state);

// ── rendering ───────────────────────────────────────────────────────────────
function renderPages() {
  pagesNav.replaceChildren();
  state.pages.forEach((page, i) => {
    const b = document.createElement('button');
    b.className = 'page-btn' + (i === pageIndex ? ' on' : '');
    b.type = 'button';
    b.setAttribute('aria-label', `Page ${i + 1}`);
    if (i === pageIndex) b.setAttribute('aria-current', 'page');

    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1);
    b.append(n);

    // A page you are not looking at can still have agents on it. Say so.
    const live = page.bays.filter((_, s) => terms.get(bayId(i, s))?.running).length;
    if (live) {
      const d = document.createElement('span');
      d.className = 'live-dot';
      d.title = `${live} running`;
      b.append(d);
      b.setAttribute('aria-label', `Page ${i + 1}, ${live} running`);
    }

    b.addEventListener('click', () => { pageIndex = i; renderAll(); });

    // You could add pages and never get rid of one. A page with agents on it asks first —
    // closing it kills them, and that is not something to discover afterwards.
    if (state.pages.length > 1) {
      b.classList.add('closable');
      const x = document.createElement('button');
      x.className = 'page-x';
      x.type = 'button';
      x.textContent = '✕';
      x.title = `Close page ${i + 1}`;
      x.setAttribute('aria-label', `Close page ${i + 1}`);
      x.addEventListener('click', (e) => { e.stopPropagation(); closePage(i); });
      b.append(x);
    }
    pagesNav.append(b);
  });

  const add = document.createElement('button');
  add.className = 'page-btn';
  add.type = 'button';
  add.textContent = '+';
  add.title = 'Add another nine';
  add.setAttribute('aria-label', 'Add a page');
  add.addEventListener('click', () => {
    state.pages.push({ id: newPageId(), bays: Array(BAYS_PER_PAGE).fill(null) });
    pageIndex = state.pages.length - 1;
    save();
    renderAll();
  });
  pagesNav.append(add);
}

function renderGrid() {
  grid.replaceChildren();
  grid.classList.toggle('zoomed', !!zoomed);
  const page = state.pages[pageIndex];

  page.bays.forEach((bay, slot) => {
    const id = bayId(pageIndex, slot);
    const node = tpl.content.firstElementChild.cloneNode(true);
    const plus = $('.plus', node);
    const live = $('.live', node);

    if (!bay) {
      plus.addEventListener('click', () => pick(slot));
      grid.append(node);
      return;
    }

    plus.hidden = true;
    live.hidden = false;
    node.style.setProperty('--bay-c', bayColor(slot));
    $('.title', node).textContent = bay.title;
    $('.title', node).title = bay.path;

    const rec = terms.get(id);
    $('.dot', node).classList.toggle('running', !!rec?.running);
    $('.dot', node).classList.toggle('exited', !!rec && !rec.running);
    node.classList.toggle('busy', !!rec?.running);

    if (zoomed === id) node.classList.add('zoom');
    $('.zoom', node).addEventListener('click', () => toggleZoom(id));
    // the title bar is a big target and does nothing else
    $('.head', node).addEventListener('dblclick', () => toggleZoom(id));
    // clicking the chrome should put you in the terminal, not nowhere
    $('.head', node).addEventListener('click', (e) => { if (!e.target.closest('.act')) terms.get(id)?.term.focus(); });
    $('.reveal', node).addEventListener('click', () => window.hangar.openFolder(bay.path));
    $('.restart', node).addEventListener('click', () => startBay(id, slot, bay));
    $('.close', node).addEventListener('click', () => closeBay(id, slot));

    grid.append(node);
    mountTerm(id, $('.term', node), slot, bay);
  });
}

function renderAll() {
  // Terminals are torn down when their tile leaves the DOM; the pty keeps running in
  // main and the buffer is replayed on the way back. The agent never notices a page turn.
  const here = `${pageId(pageIndex)}s`;
  for (const [id, rec] of terms) {
    if (!id.startsWith(here)) rec.ro?.disconnect();
  }
  renderGrid();
  renderPages();
  updateCount();
}

function updateCount() {
  const n = [...terms.values()].filter((r) => r.running).length;
  countEl.textContent = `${n} running`;
  killAllBtn.disabled = n === 0;
}

// ── terminals ───────────────────────────────────────────────────────────────
async function mountTerm(id, host, slot, bay) {
  let rec = terms.get(id);

  if (!rec) {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = FitAddon ? new FitAddon() : null;
    if (fit) term.loadAddon(fit);
    // 🔑 ONE HOST ELEMENT PER BAY, FOR THE LIFE OF THE BAY.
    //
    // Every render does grid.replaceChildren(), so the tile's DOM is new each time.
    // Calling term.open() again against the new node leaves xterm attached to a screen
    // that no longer exists: the pty streamed fine, the bay said "running", and the
    // terminal painted NOTHING. Give xterm a node it owns and re-parent THAT instead —
    // moving a DOM node takes its children and its renderer with it.
    const el = document.createElement('div');
    el.className = 'xterm-host';
    rec = { term, fit, el, running: false, ro: null, opened: false };
    terms.set(id, rec);
    term.onData((d) => window.hangar.write(id, d));
  }

  host.append(rec.el);
  if (!rec.opened) {
    rec.term.open(rec.el);            // open() measures, so it must be in the DOM already
    rec.opened = true;
    const buf = await window.hangar.buffer(id);
    if (buf) rec.term.write(buf);     // replay whatever ran before this tile existed
  }

  const fit = () => {
    try {
      rec.fit?.fit();
      if (rec.term.cols > 0 && rec.term.rows > 0) window.hangar.resize(id, rec.term.cols, rec.term.rows);
    } catch { /* the tile is mid-layout; the next tick will do it */ }
  };
  requestAnimationFrame(fit);

  rec.ro?.disconnect();
  rec.ro = new ResizeObserver(fit);
  rec.ro.observe(host);

  rec.running = await window.hangar.isRunning(id);
  if (!rec.running && !rec.started) startBay(id, slot, bay, host);
}

async function startBay(id, slot, bay, host) {
  const rec = terms.get(id);
  if (!rec) return;
  rec.started = true;
  rec.term.reset();

  const r = await window.hangar.start(id, bay.path, rec.term.cols || 80, rec.term.rows || 24);
  rec.running = !!r?.ok;
  renderAll();
  if (r?.ok) rec.term.focus();
}

async function closeBay(id, slot) {
  await window.hangar.kill(id);
  const rec = terms.get(id);
  rec?.ro?.disconnect();
  rec?.term.dispose();
  terms.delete(id);
  state.pages[pageIndex].bays[slot] = null;
  save();
  renderAll();
}

function toggleZoom(id) {
  zoomed = zoomed === id ? null : id;
  renderAll();
  // the tile just changed size by a factor of nine; the pty needs to hear about it
  requestAnimationFrame(() => terms.get(id)?.term.focus());
}

async function closePage(i) {
  const page = state.pages[i];
  const live = page.bays.filter((_, s) => terms.get(bayId(i, s))?.running).length;
  // Killing agents is not undoable, so say the number and let them stop.
  if (live && !confirm(`Close page ${i + 1}? ${live} running agent${live > 1 ? 's' : ''} will be stopped.`)) return;

  for (let s = 0; s < BAYS_PER_PAGE; s++) {
    const id = bayId(i, s);
    const rec = terms.get(id);
    if (!rec) continue;
    await window.hangar.kill(id);
    rec.ro?.disconnect();
    rec.term.dispose();
    terms.delete(id);
  }

  state.pages.splice(i, 1);
  if (!state.pages.length) state.pages.push({ id: newPageId(), bays: Array(BAYS_PER_PAGE).fill(null) });
  pageIndex = Math.min(pageIndex > i ? pageIndex - 1 : pageIndex, state.pages.length - 1);
  save();
  renderAll();
}

// ── the + ───────────────────────────────────────────────────────────────────
async function pick(slot) {
  const folder = await window.hangar.pickFolder();
  if (!folder) return;                       // cancelled: leave the bay empty
  state.pages[pageIndex].bays[slot] = { path: folder.path, title: folder.title };
  save();
  renderAll();
}

// ── usage ───────────────────────────────────────────────────────────────────
// The same two numbers ~/.claude/statusline.sh drew under every prompt, drawn once here
// instead of nine times inside nine 20-row terminals. Same thresholds as that script, so
// the colour means the same thing it always did: green under 50, amber to 80, red above.
const m5 = $('#m5'), m7 = $('#m7'), unote = $('#unote');

const pressure = (p) => (p >= 80 ? 'hot' : p >= 50 ? 'warn' : '');

// "2h14m" / "3d4h" — the countdown from statusline.sh's left()
function left(resetsAt) {
  if (!resetsAt) return '';
  const secs = Math.round(resetsAt - Date.now() / 1000);
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function meter(el, w) {
  if (!w) { el.hidden = true; return false; }
  el.hidden = false;
  const p = Math.max(0, Math.min(100, w.pct ?? 0));
  el.classList.remove('warn', 'hot');
  const c = pressure(p);
  if (c) el.classList.add(c);
  $('.fill', el).style.width = `${p}%`;
  $('.pct', el).textContent = `${p}%`;
  // Always a countdown, never a date: "↻1h46m" is the thing you actually want to know,
  // and it is what the statusline this replaces always said. main turns /usage's prose
  // back into an epoch; the raw text is only a fallback if that parse ever fails.
  const l = w.resets_at ? left(w.resets_at) : (w.resets_text || '');
  $('.reset', el).textContent = l ? `↻${l}` : '';
  return true;
}

let usage = null;
function paintUsage(u) {
  if (u) usage = u;
  const a = meter(m5, usage?.five_hour);
  const b = meter(m7, usage?.seven_day);
  // Before any bay has run there is nothing to report, and a made-up 0% would be a lie.
  unote.hidden = a || b;
}
// The reset countdowns are the only thing that moves on their own.
setInterval(() => { if (usage) paintUsage(); }, 30_000);

// ── wiring ──────────────────────────────────────────────────────────────────
window.hangar.onUsage((u) => paintUsage(u));
window.hangar.onData(({ id, data }) => terms.get(id)?.term.write(data));

window.hangar.onExit(({ id, code, reason }) => {
  const rec = terms.get(id);
  if (!rec) return;
  rec.running = false;
  const why = reason ? ` ${reason}` : '';
  rec.term.write(`\r\n\x1b[90m── agent exited (${code})${why} · ⟳ to restart ──\x1b[0m\r\n`);
  renderAll();
});

// esc: xterm gets the keystroke first when a terminal is focused (claude needs esc to
// interrupt), so this only fires when focus is on the chrome. The ⤢ button is the way
// out from inside a terminal.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && zoomed) { zoomed = null; renderAll(); }
});

killAllBtn.addEventListener('click', async () => {
  for (const [id, rec] of terms) {
    if (rec.running) { await window.hangar.kill(id); rec.running = false; }
  }
  renderAll();
});

(async function boot() {
  const loaded = await window.hangar.loadState();
  if (loaded?.pages?.length) state = loaded;
  let patched = false;
  for (const p of state.pages) if (!p.id) { p.id = newPageId(); patched = true; }   // state written before ids existed
  if (patched) save();
  if (window.hangar.zoomAtBoot) zoomed = window.hangar.zoomAtBoot;   // test hook
  renderAll();
  paintUsage(await window.hangar.usage());
})();
