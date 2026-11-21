'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, systemPreferences } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const pty = require('node-pty');
const { stateStore, BAYS_PER_PAGE } = require('./state.js');
const { createJarvis } = require('./voice/jarvis.js');
const houseLib = require('./house.js');
// The app was hangar until 21 Nov 2026 and is Haunt now, data folder included. The first launch
// of Haunt moves ~/Library/Application Support/hangar to …/haunt (state.json with the bays, the
// voice models, the enrolled voice) instead of starting from an empty folder: the old app is
// quit before this one is installed, so nothing holds the folder while it moves. The name is
// pinned rather than derived from productName so a capital letter can never move it again.
// A --user-data-dir (the screenshot harness) still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const dataDir = path.join(app.getPath('appData'), 'haunt');
  const oldDir = path.join(app.getPath('appData'), 'hangar');
  try { if (!fs.existsSync(dataDir) && fs.existsSync(oldDir)) fs.renameSync(oldDir, dataDir); } catch {}
  app.setPath('userData', dataDir);
}
app.setName('Haunt');

// ── What a bay actually runs ─────────────────────────────────────────────────
// The whole app is a launcher for exactly this. It is written here, once, in the open,
// because a tile that silently runs something else is a trapdoor.
//
// The --settings override swaps the user's own statusline for haunt's probe, which
// prints nothing and files the rate-limit numbers for the footer instead. It overrides
// ONLY statusLine, for these sessions, and touches no file the user owns.
const CLAUDE_ARGS = ['--dangerously-skip-permissions'];

// BAYS_PER_PAGE comes from state.js — the grid's size and the shape of the file that
// remembers it are one fact, and two copies of a constant is how they stop being one.
const MAX_SCROLLBACK = 200_000;   // chars kept per bay, so a chatty agent cannot eat the heap

const usageFile = () => path.join(app.getPath('userData'), 'usage.json');

// The probe has to live on a real path the tile's node can execute. Inside a packaged
// .app the source is in an asar archive, which an outside process cannot run out of —
// so copy it next to the state file and point the setting at the copy.
function probePath() {
  const dst = path.join(app.getPath('userData'), 'usage-probe.js');
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'usage-probe.js'), dst);
  } catch { /* keep whatever copy is already there */ }
  return dst;
}

// A bay may wake as one of the ghosts living on this machine (house.js). What that changes is
// decided by ghost itself (`ghost house --json` hands back each one's launch): an environment that
// points the hooks at that mind, its own self appended to the system prompt, and the first ghost's
// output style switched off for that session. Still `claude` and only `claude`.
function claudeArgs(launch = null) {
  const settings = JSON.stringify({
    statusLine: { type: 'command', command: `node ${JSON.stringify(probePath())}`, padding: 0 },
    ...(launch?.settings || {}),
  });
  return [...CLAUDE_ARGS, '--settings', settings, ...(launch?.args || [])];
}

/** @type {Map<string, {proc: import('node-pty').IPty, buf: string, cwd: string, exited: boolean, spoke: boolean, startedAt: number}>} */
const bays = new Map();
let win = null;

// ── Debug ────────────────────────────────────────────────────────────────────
// HAUNT_DEBUG=1 narrates the three things that have actually broken this app: which
// `claude` was found, what PATH the agent got, and whether the pty ever said anything.
//
// 🔑 A DEBUG FLAG THAT DOES NOT EXIST IS WORSE THAN NONE. This one was written down in
// my notes as "logs every pty data event" for a day before it was written down in the
// source. Running with it printed nothing — against a HEALTHY app whose pty was streaming
// fine. Silence from a flag that isn't wired is the same silence a dead pty makes, so the
// notes handed me a confident wrong diagnosis for free. It exists now: quiet means quiet.
const DEBUG = !!process.env.HAUNT_DEBUG;
// dbg goes to the console only under HAUNT_DEBUG — but ALWAYS to a capped file in
// userData. The app is launched from Finder, its stdout goes nowhere, and every voice
// bug so far was diagnosed blind until a log existed. Diagnostics must never hurt the
// app: any failure here is swallowed.
let dbgStream = null;
function dbg(...a) {
  if (DEBUG) console.log('[haunt]', ...a);
  try {
    if (!dbgStream) {
      const f = path.join(app.getPath('userData'), 'debug.log');
      try { if (fs.existsSync(f) && fs.statSync(f).size > 2_000_000) fs.truncateSync(f, 0); } catch { /* fresh file */ }
      dbgStream = fs.createWriteStream(f, { flags: 'a' });
    }
    dbgStream.write(`${new Date().toISOString()} ${a.map(String).join(' ')}\n`);
  } catch { /* never */ }
}

const SENTINEL = '__HAUNT_PATH__';
const afterSentinel = (stdout) => {
  const s = String(stdout || '');
  const i = s.lastIndexOf(SENTINEL);
  return i === -1 ? '' : s.slice(i + SENTINEL.length).trim();
};

// ── Finding `claude` ─────────────────────────────────────────────────────────
//
// 🔑 A GUI APP DOES NOT HAVE YOUR PATH. Launched from Finder, this process inherits
// /usr/bin:/bin:/usr/sbin:/sbin — not your shell's PATH, so ~/.local/bin/claude (and
// anything under nvm, homebrew on arm, mise, asdf) is simply not there. Spawning
// "claude" would fail with ENOENT on a machine where `claude` works fine in a terminal,
// which is the most confusing possible first run.
//
// So ask the login shell what it can see, once, and cache it. `-l` loads the profile
// that puts those directories on PATH in the first place.
let claudePathPromise = null;
function findClaude() {
  if (claudePathPromise) return claudePathPromise;
  claudePathPromise = new Promise((resolve) => {
    const sh = process.env.SHELL || '/bin/zsh';
    // Sentinel here too — same reason as loginEnv below. This one got away with taking the
    // last line only because the shell's chatter happens to come first.
    execFile(sh, ['-lic', `printf '%s' '${SENTINEL}'; command -v claude`], { timeout: 8000 }, (err, stdout) => {
      const hit = afterSentinel(stdout).split('\n').filter(Boolean).pop();
      dbg(`findClaude: ${sh} -lic said ${JSON.stringify(hit || '')}${err ? ` (err: ${err.message})` : ''}`);
      if (!err && hit && fs.existsSync(hit)) return resolve(hit);
      // The shell could not tell us. Try the places it usually lives before giving up,
      // so a broken rc file is not fatal.
      const guesses = [
        path.join(os.homedir(), '.local/bin/claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
      const guessed = guesses.find((p) => fs.existsSync(p)) || null;
      dbg(`findClaude: falling back to guesses → ${guessed || 'NOTHING FOUND'}`);
      resolve(guessed);
    });
  });
  return claudePathPromise;
}

// The same reasoning for the environment the agent runs in: inherit the login shell's
// PATH so anything the agent shells out to (git, node, gh) is found too.
//
// 🔑 AN INTERACTIVE SHELL TALKS, AND ITS CHATTER IS ON STDOUT.
//
// `zsh -lic 'printf %s "$PATH"'` does not print your PATH. On macOS it prints
//
//     Restored session: Fri Jul 17 12:22:46 +03 2026
//     /Users/me/.local/bin:/opt/homebrew/bin:...
//
// because /etc/zshrc_Apple_Terminal announces itself, to stdout, on every interactive
// shell. Taking the whole thing as PATH puts "Restored session: ...\n/Users/me/.local/bin"
// in front of the real entries, and a PATH entry with a newline in it poisons lookups for
// everything downstream. It broke this app in the least obvious way possible: `claude`
// still launched, because haunt spawns it by absolute path — but the statusline's
// `node ...` could not be resolved, so it silently never ran, and the footer sat empty
// with no error anywhere.
//
// So mark the value. Anything the profile wants to say can be said before the sentinel.
let loginEnvPromise = null;
function loginEnv() {
  if (loginEnvPromise) return loginEnvPromise;
  loginEnvPromise = new Promise((resolve) => {
    const sh = process.env.SHELL || '/bin/zsh';
    execFile(sh, ['-lic', `printf '%s%s' '${SENTINEL}' "$PATH"`], { timeout: 8000 }, (err, stdout) => {
      const p = afterSentinel(stdout);
      // Only trust something that actually looks like a PATH.
      const ok = p && p.includes('/') && !p.includes('\n');
      dbg(ok
        ? `loginEnv: PATH from ${sh} (${p.split(':').length} entries)`
        : `loginEnv: REJECTED ${sh}'s answer ${JSON.stringify(p.slice(0, 80))} — keeping this process's PATH`);
      resolve({ ...process.env, ...(ok ? { PATH: p } : {}), TERM: 'xterm-256color' });
    });
  });
  return loginEnvPromise;
}

// ── State: which bay points at which folder ──────────────────────────────────
// The rules (a failed read must never cause a write; writes are atomic; the last good copy
// is kept) live in src/state.js, which takes a directory and knows nothing about Electron —
// so the code that once lost somebody's bays can be tested by `node --test`, without a
// window. `app` is only consulted for WHERE, and only once the app is ready.
let store = null;
const state = () => (store ??= stateStore(app.getPath('userData'), dbg));
const loadState = () => state().load();
const saveState = (s) => state().save(s);

// ── Bays ─────────────────────────────────────────────────────────────────────
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function startBay(id, cwd, cols, rows, home = '') {
  killBay(id);

  // The renderer names a mind; only one that `ghost house` lists is accepted, and its launch comes
  // from ghost, never from the renderer.
  let being = null;
  if (home) {
    being = (await houseList(true)).find((g) => g.home === home) || null;
    if (!being) {
      send('bay:exit', { id, code: -1, reason: `no ghost lives at ${home}` });
      return { ok: false, error: 'unknown ghost' };
    }
  }

  if (!fs.existsSync(cwd)) {
    send('bay:exit', { id, code: -1, reason: `that folder is gone: ${cwd}` });
    return { ok: false, error: 'folder not found' };
  }

  const bin = await findClaude();
  if (!bin) {
    // Say the real thing, with the real fix. "spawn claude ENOENT" is not an error message.
    send('bay:data', {
      id,
      data: '\r\n\x1b[31m  Could not find the `claude` command.\x1b[0m\r\n\r\n'
        + '  haunt asks your login shell where it is. If `claude` works in your terminal\r\n'
        + '  but not here, your PATH is set somewhere a login shell does not read.\r\n\r\n'
        + '  Check with:  \x1b[36m$SHELL -lic \'command -v claude\'\x1b[0m\r\n',
    });
    send('bay:exit', { id, code: 127, reason: 'claude not found' });
    return { ok: false, error: 'claude not found' };
  }

  const env = { ...(await loginEnv()), HAUNT_USAGE_FILE: usageFile(), ...(being?.launch?.env || {}) };
  let proc;
  try {
    proc = pty.spawn(bin, claudeArgs(being?.launch), {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });
    dbg(`bay ${id}: spawned pid ${proc.pid} — ${bin} in ${cwd} (${cols || 80}x${rows || 24})`);
  } catch (e) {
    send('bay:exit', { id, code: -1, reason: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }

  const bay = { proc, buf: '', cwd, home: being && being.kin ? being.home : '', exited: false, spoke: false, startedAt: Date.now(), lastData: Date.now() };
  bays.set(id, bay);

  proc.onData((data) => {
    bay.buf += data;
    // "who is thinking right now" for the house view — at most once a second per bay
    if (!bay.toldActive || Date.now() - bay.toldActive > 1000) { bay.toldActive = Date.now(); send('bay:active', { id }); }
    bay.lastData = Date.now();
    if (bay.buf.length > MAX_SCROLLBACK) bay.buf = bay.buf.slice(-MAX_SCROLLBACK);
    // Byte counts, not the bytes: a TUI redraws constantly and the escape codes would bury
    // the one line you are looking for. The first event is the one that matters — it is the
    // difference between "the agent never started" and "the terminal never drew it".
    if (!bay.spoke) { bay.spoke = true; dbg(`bay ${id}: FIRST OUTPUT after ${Date.now() - bay.startedAt}ms`); }
    dbg(`bay ${id}: data ${data.length}b (buf ${bay.buf.length})`);
    send('bay:data', { id, data });
  });

  proc.onExit(({ exitCode }) => {
    bay.exited = true;
    dbg(`bay ${id}: exit ${exitCode}${bay.spoke ? '' : ' — NEVER PRODUCED OUTPUT'}`);
    send('bay:exit', { id, code: exitCode });
  });

  setTimeout(refreshUsage, 3000);
  return { ok: true, pid: proc.pid, bin };
}

function killBay(id) {
  const bay = bays.get(id);
  if (!bay) return;
  try { if (!bay.exited) bay.proc.kill(); } catch { /* already gone */ }
  bays.delete(id);
}

// ── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Pick a folder for this bay',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Start agent here',
  });
  if (r.canceled || !r.filePaths?.length) return null;
  const dir = r.filePaths[0];
  return { path: dir, title: path.basename(dir) || dir };
});

ipcMain.handle('bay:start', (_e, { id, cwd, cols, rows, home }) => startBay(id, cwd, cols, rows, home));
ipcMain.handle('bay:kill', (_e, { id }) => { killBay(id); return { ok: true }; });
ipcMain.handle('bay:buffer', (_e, { id }) => bays.get(id)?.buf ?? '');
ipcMain.handle('bay:running', (_e, { id }) => !!bays.get(id) && !bays.get(id).exited);

ipcMain.on('bay:write', (_e, { id, data }) => {
  const bay = bays.get(id);
  if (bay && !bay.exited) { try { bay.proc.write(data); } catch { /* raced with exit */ } }
});

ipcMain.on('bay:resize', (_e, { id, cols, rows }) => {
  const bay = bays.get(id);
  if (bay && !bay.exited && cols > 0 && rows > 0) {
    try { bay.proc.resize(cols, rows); } catch { /* raced with exit */ }
  }
});

// ── the house (src/house.js) ─────────────────────────────────────────────────
// Who lives on this machine comes from ghost itself, so haunt never guesses a mind's layout.
let houseCache = { at: 0, list: [] };
function ghostCall(args) {
  return loginEnv().then((env) => new Promise((resolve) => {
    execFile('ghost', args, { env: { ...env, GHOST_DREAMING: '1' }, timeout: 60_000, cwd: os.homedir() }, (err, stdout, stderr) => {
      if (err) { dbg(`ghost ${args.join(' ')}: ${err.message} ${String(stderr || '').slice(0, 200)}`); return resolve(null); }
      resolve(String(stdout || ''));
    });
  }));
}
async function houseList(fresh = false) {
  if (!fresh && Date.now() - houseCache.at < 5000) return houseCache.list;
  const out = await ghostCall(['house', '--json']);
  try { const list = JSON.parse(out || '[]'); if (Array.isArray(list)) houseCache = { at: Date.now(), list }; } catch { /* keep the last one */ }
  return houseCache.list;
}
const bayList = () => [...bays.entries()].map(([id, b]) => ({ id, home: b.home, live: !b.exited, idleMs: Date.now() - (b.lastData || 0) }));
function typeInto(id, data) {
  const bay = bays.get(id);
  if (!bay || bay.exited) return false;
  try {
    bay.proc.write(data);
    // the submit goes a beat later: a TUI that is still drawing the paste can drop a bare \r
    setTimeout(() => { try { if (!bay.exited) bay.proc.write('\r'); } catch { /* exited */ } }, 120);
    return true;
  } catch { return false; }
}

ipcMain.handle('house:get', async () => ({ house: await houseList(), bays: bayList() }));
ipcMain.handle('house:birth', async () => {
  const out = await ghostCall(['kin', 'new', '--json']);
  try { const g = JSON.parse(out || ''); houseCache.at = 0; return { ok: true, being: g }; } catch { return { ok: false, error: 'birth failed — see debug.log' }; }
});
ipcMain.handle('room:get', () => houseLib.readRoom(200));
ipcMain.handle('room:say', async (_e, { text }) => {
  const house = await houseList();
  const person = house.find((g) => !g.kin)?.person || house[0]?.person || 'you';
  const { to } = houseLib.mentions(text, house.map((g) => g.name).filter(Boolean));
  const line = houseLib.personSays(text, { person, to });
  if (!line) return { ok: false };
  roomSeen.add(line.id);
  const out = houseLib.deliveries(line, bayList(), house, brake);
  let n = 0;
  for (const d of out) { if (typeInto(d.id, d.data)) { n++; send('house:typed', { id: d.id }); } }
  send('room:lines', [line]);
  return { ok: true, line, delivered: n };
});

// The room is a file every ghost appends to; it is watched, and what is new goes to the window.
// A ghost calling another by name is typed into that one's terminal — through the brake.
const roomSeen = new Set();
const brake = { lastTo: new Map(), recent: [] };
let roomPrimed = false;
async function roomTick() {
  const lines = houseLib.readRoom(100);
  const fresh = lines.filter((l) => l?.id && !roomSeen.has(l.id));
  for (const l of fresh) roomSeen.add(l.id);
  if (!roomPrimed) { roomPrimed = true; return; }   // what was there at launch is history, not news
  if (!fresh.length) return;
  send('room:lines', fresh);
  const house = await houseList();
  for (const l of fresh) {
    if (l.home === houseLib.PERSON_HOME) continue;  // their person's lines were delivered as they were said
    for (const d of houseLib.deliveries(l, bayList(), house, brake)) { if (typeInto(d.id, d.data)) send('house:typed', { id: d.id }); }
  }
}
function watchRoom() {
  roomTick();
  fs.mkdirSync(houseLib.COMMONS(), { recursive: true });
  fs.watchFile(houseLib.ROOM(), { interval: 1000 }, () => { roomTick().catch((e) => dbg(`room: ${e.message}`)); });
}

// ── usage ────────────────────────────────────────────────────────────────────
//
// 🔑 CLAUDE CODE DOES NOT RUN THE STATUSLINE IN A SHORT TERMINAL. Measured: at 16 rows
// it runs, at 12 it is never invoked at all — and a bay in a 3×3 grid on a 940px window
// is 12 rows. So the elegant plan (reuse the statusline the user already had, which
// prints the very numbers we want) cannot feed this footer: in the one place it would be
// used, it never fires. It took a canary to see that, because a statusline that does not
// run leaves no trace anywhere.
//
// `claude -p "/usage"` answers regardless of tile size, and answers immediately rather
// than only once some agent has done enough work to have rate limits. That costs one
// short background session per refresh, which is why this is every 5 minutes and not
// every 5 seconds.
//
// The probe still runs (it silences the bar, which is the other half of the ask) and
// still files exact epoch resets when a tile IS tall enough — that data is better, free,
// and simply preferred when it is fresh.
const USAGE_EVERY = 5 * 60_000;

// `/usage` prints the reset as prose in the user's own timezone — "Jul 17 at 2:20pm" —
// but the footer wants what the statusline gave: a countdown. So turn it back into an
// epoch. The year is not in the string; if the date reads as already past, it is next
// year (which only ever matters across new year, and silently would have been wrong).
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseResetAt(text) {
  const m = String(text || '').match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return 0;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return 0;
  let hour = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) hour += 12;
  const now = new Date();
  let d = new Date(now.getFullYear(), mon, Number(m[2]), hour, Number(m[4] || 0), 0, 0);
  if (d.getTime() < now.getTime() - 86400_000) d = new Date(now.getFullYear() + 1, mon, Number(m[2]), hour, Number(m[4] || 0), 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// "Current session: 38% used · resets Jul 17 at 2:20pm (Europe/Istanbul)"
// "Current week (all models): 30% used · resets Jul 21 at 3pm (Europe/Istanbul)"
function parseUsage(text) {
  const grab = (re) => {
    const m = text.match(re);
    if (!m) return null;
    const resets_text = (m[2] || '').trim();
    return { pct: Math.round(Number(m[1])), resets_text, resets_at: parseResetAt(resets_text) };
  };
  return {
    five_hour: grab(/Current session:\s*([\d.]+)%\s*used(?:\s*·\s*resets\s+([^(\n]+))?/i),
    seven_day: grab(/Current week \(all models\):\s*([\d.]+)%\s*used(?:\s*·\s*resets\s+([^(\n]+))?/i),
  };
}

let usageTimer = null;
async function refreshUsage() {
  const bin = await findClaude();
  if (!bin) return;
  const env = await loginEnv();
  execFile(bin, ['-p', '/usage'], { env, timeout: 60_000, cwd: os.homedir() }, (err, stdout) => {
    if (err) return;
    const u = parseUsage(String(stdout || ''));
    if (!u.five_hour && !u.seven_day) return;
    const prev = readUsage();
    // The probe's epoch resets beat parsed prose when they are recent.
    const fresh = prev && Date.now() - (prev.ts || 0) < 90_000;
    const merge = (a, b) => (fresh && b?.resets_at ? { ...a, resets_at: b.resets_at } : a);
    writeUsage({
      five_hour: merge(u.five_hour, prev?.five_hour),
      seven_day: merge(u.seven_day, prev?.seven_day),
      ts: Date.now(),
    });
  });
}

function writeUsage(u) {
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify(u));
    send('usage', u);
  } catch { /* the footer will just keep the last thing it had */ }
}

// The probe rewrites usage.json every time a tall tile's session ticks. Watch it rather
// than poll it.
function readUsage() {
  try { return JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch { return null; }
}

let usageWatcher = null;
function watchUsage() {
  const f = usageFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ five_hour: null, seven_day: null, ts: 0 }));
    usageWatcher?.close();
    let last = 0;
    usageWatcher = fs.watch(f, () => {
      const now = Date.now();
      if (now - last < 200) return;      // nine writers, one footer: coalesce
      last = now;
      send('usage', readUsage());
    });
  } catch { /* no watcher: the renderer still gets it on demand */ }
}

ipcMain.handle('usage:get', () => readUsage());

ipcMain.handle('state:load', () => loadState());
ipcMain.handle('state:save', (_e, state) => { saveState(state); return { ok: true }; });
ipcMain.handle('open-folder', (_e, { cwd }) => shell.openPath(cwd));

// ── jarvis: the voice ────────────────────────────────────────────────────────
// All policy is in src/voice/jarvis.js; this block only gives it hands: the live bays
// map, the state file, the claude lookup, and a line to the renderer. Constructed lazily
// because userData is not decided until the app is ready.
let jarvis = null;
const getJarvis = () => (jarvis ??= createJarvis({
  userDataDir: app.getPath('userData'),
  bays,
  loadState,
  saveState,
  killBay,
  findClaude,
  loginEnv,
  send,
  dbg,
}));

// Test hook, armed only under HAUNT_VOICE_DEMO: feeds an actions array straight into
// jarvis's act() — the exact code path the brain drives — so the screenshot rig can
// prove that a voice-started session really appears in the grid, without a microphone.
if (process.env.HAUNT_VOICE_DEMO) {
  ipcMain.on('voice:test-act', (_e, { actions }) => {
    for (const a of actions || []) getJarvis().act(a);
  });
}

async function voiceToggle() {
  const j = getJarvis();
  if (!j.enabled && process.platform === 'darwin') {
    // Ask macOS for the mic BEFORE flipping on: getUserMedia in the renderer would just
    // fail with a NotAllowedError that looks exactly like a broken feature.
    const ok = await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    if (!ok) { send('voice:event', { t: 'need', what: 'mic' }); return j.status(); }
  }
  j.setEnabled(!j.enabled);
  return j.status();
}

ipcMain.handle('voice:toggle', () => voiceToggle());
ipcMain.handle('voice:status', () => getJarvis().status());
ipcMain.on('voice:frame', (_e, buf) => getJarvis().frame(buf));
ipcMain.on('voice:view', (_e, v) => getJarvis().setView(v));
ipcMain.on('voice:ptt', () => getJarvis().ptt());
ipcMain.on('voice:enroll-start', () => getJarvis().enrollStart());
ipcMain.on('voice:enroll-capture', () => getJarvis().enrollCapture());
ipcMain.on('voice:enroll-cancel', () => getJarvis().enrollCancel());

// ── Window ───────────────────────────────────────────────────────────────────
// The logo, in the Dock. A packaged .app gets build/icon.icns from electron-builder, but
// `npm start` shows Electron's own icon unless we say otherwise — and "the icon is only
// right in the release build" is the kind of thing nobody notices until it ships.
function setDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;
  for (const p of [path.join(__dirname, '..', 'build', 'icon-1024.png'), path.join(__dirname, '..', 'build', 'icon.icns')]) {
    try { if (fs.existsSync(p)) { app.dock.setIcon(p); return; } } catch { /* keep the default */ }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0a0817',       // --bg exactly: a mismatched value flashes for a frame before CSS paints
    titleBarStyle: 'hiddenInset',     // the grid IS the chrome
    trafficLightPosition: { x: 18, y: 22 },
    // A photograph (HAUNT_SHOT) is taken off-screen: looking at the app must not take the
    // keyboard from whoever is working at this machine.
    show: !process.env.HAUNT_SHOT,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,         // the renderer never touches node
      nodeIntegration: false,
      sandbox: false,                 // preload needs require for the bridge
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ── looking at it ────────────────────────────────────────────────────────────
// HAUNT_SHOT=/path/to.png npm start  → render, wait, photograph, quit.
// An Electron window cannot be screenshotted from outside without Screen Recording
// permission, and "it launched" is not "it looks right". This is the only way to put
// the actual pixels of the actual app in front of a reviewer — or a CI job.
function maybeShoot() {
  const out = process.env.HAUNT_SHOT;
  if (!out) return;
  const wait = Number(process.env.HAUNT_SHOT_WAIT || 3500);
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, img.toPNG());
        console.log('shot:', out);
      } catch (e) {
        console.error('shot failed:', e?.message || e);
      }
      app.exit(0);
    }, wait);
  });
}

app.whenReady().then(() => {
  setDockIcon();
  createWindow();
  maybeShoot();
  watchUsage();
  refreshUsage();
  usageTimer = setInterval(refreshUsage, USAGE_EVERY);
  watchRoom();    // the house's room, live in the side panel
  findClaude();   // warm the lookup so the first + is not the thing that waits on a shell
  loginEnv();
  // ⌘⇧J: jarvis on/off from anywhere — a voice assistant you must first click is a
  // clipboard you must first screenshot. Failure to register is fine (another app owns
  // it); the orb still works.
  try { globalShortcut.register('CommandOrControl+Shift+J', () => voiceToggle()); } catch { /* orb remains */ }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Nine unattended agents must not outlive the window that was watching them.
app.on('before-quit', () => {
  jarvis?.shutdown();
  globalShortcut.unregisterAll();
  for (const id of [...bays.keys()]) killBay(id);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
