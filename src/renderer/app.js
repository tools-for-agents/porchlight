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

/** id -> { term, fit, ro, running } for bays that have ever been rendered */
const terms = new Map();

const bayId = (page, slot) => `p${page}s${slot}`;

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
    pagesNav.append(b);
  });

  const add = document.createElement('button');
  add.className = 'page-btn';
  add.type = 'button';
  add.textContent = '+';
  add.title = 'Add another nine';
  add.setAttribute('aria-label', 'Add a page');
  add.addEventListener('click', () => {
    state.pages.push({ bays: Array(BAYS_PER_PAGE).fill(null) });
    pageIndex = state.pages.length - 1;
    save();
    renderAll();
  });
  pagesNav.append(add);
}

function renderGrid() {
  grid.replaceChildren();
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
    $('.title', node).textContent = bay.title;
    $('.title', node).title = bay.path;

    const rec = terms.get(id);
    $('.dot', node).classList.toggle('running', !!rec?.running);
    $('.dot', node).classList.toggle('exited', !!rec && !rec.running);
    node.classList.toggle('busy', !!rec?.running);

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
  for (const [id, rec] of terms) {
    if (!id.startsWith(`p${pageIndex}s`)) rec.ro?.disconnect();
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

// ── the + ───────────────────────────────────────────────────────────────────
async function pick(slot) {
  const folder = await window.hangar.pickFolder();
  if (!folder) return;                       // cancelled: leave the bay empty
  state.pages[pageIndex].bays[slot] = { path: folder.path, title: folder.title };
  save();
  renderAll();
}

// ── wiring ──────────────────────────────────────────────────────────────────
window.hangar.onData(({ id, data }) => terms.get(id)?.term.write(data));

window.hangar.onExit(({ id, code, reason }) => {
  const rec = terms.get(id);
  if (!rec) return;
  rec.running = false;
  const why = reason ? ` ${reason}` : '';
  rec.term.write(`\r\n\x1b[90m── agent exited (${code})${why} · ⟳ to restart ──\x1b[0m\r\n`);
  renderAll();
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
  renderAll();
})();
