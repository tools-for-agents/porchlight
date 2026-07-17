'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const pty = require('node-pty');

// ── What a bay actually runs ─────────────────────────────────────────────────
// The whole app is a launcher for exactly this. It is written here, once, in the open,
// because a tile that silently runs something else is a trapdoor.
//
// The --settings override swaps the user's own statusline for hangar's probe, which
// prints nothing and files the rate-limit numbers for the footer instead. It overrides
// ONLY statusLine, for these sessions, and touches no file the user owns.
const CLAUDE_ARGS = ['--dangerously-skip-permissions'];

const BAYS_PER_PAGE = 9;
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

function claudeArgs() {
  const settings = JSON.stringify({
    statusLine: { type: 'command', command: `node ${JSON.stringify(probePath())}`, padding: 0 },
  });
  return [...CLAUDE_ARGS, '--settings', settings];
}

/** @type {Map<string, {proc: import('node-pty').IPty, buf: string, cwd: string, exited: boolean}>} */
const bays = new Map();
let win = null;

const SENTINEL = '__HANGAR_PATH__';
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
      if (!err && hit && fs.existsSync(hit)) return resolve(hit);
      // The shell could not tell us. Try the places it usually lives before giving up,
      // so a broken rc file is not fatal.
      const guesses = [
        path.join(os.homedir(), '.local/bin/claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
      resolve(guesses.find((p) => fs.existsSync(p)) || null);
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
// still launched, because hangar spawns it by absolute path — but the statusline's
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
      resolve({ ...process.env, ...(ok ? { PATH: p } : {}), TERM: 'xterm-256color' });
    });
  });
  return loginEnvPromise;
}

// ── State: which bay points at which folder ──────────────────────────────────
// Only paths and titles. No secrets pass through here — the agent authenticates itself
// with your own ~/.claude, exactly as it does in a terminal.
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

const backupFile = () => path.join(app.getPath('userData'), 'state.bak.json');

// 🔑 A FAILED READ MUST NEVER CAUSE A WRITE.
//
// This lost a real user's bays. loadState() swallowed a parse error and returned an empty
// default; the renderer then stamped ids on that default's pages and called save() — and
// the empty default landed on top of seven bays somebody had actually set up. Two bugs
// holding hands:
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
function loadState() {
  const empty = { pages: [{ id: 'pg_1', bays: Array(BAYS_PER_PAGE).fill(null) }] };
  const read = (f) => {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(s?.pages) || !s.pages.length) throw new Error('no pages');
    return s;
  };

  try {
    return { ...read(stateFile()), ok: true };
  } catch (e) {
    if (!fs.existsSync(stateFile())) return { ...empty, ok: true };   // genuinely a first run
    // The file is there and unreadable. Try the backup before giving up on someone's work.
    try {
      const b = read(backupFile());
      try { fs.copyFileSync(stateFile(), `${stateFile()}.corrupt`); } catch { /* best effort */ }
      return { ...b, ok: true, recovered: true };
    } catch { /* no usable backup either */ }
    try { fs.copyFileSync(stateFile(), `${stateFile()}.corrupt`); } catch { /* best effort */ }
    return { ...empty, ok: false, error: String(e?.message || e) };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    // keep the last good one before replacing it
    try { if (fs.existsSync(stateFile())) fs.copyFileSync(stateFile(), backupFile()); } catch { /* best effort */ }
    const tmp = `${stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile());          // atomic: a reader sees old or new
  } catch { /* a launcher that cannot remember is still a launcher */ }
}

// ── Bays ─────────────────────────────────────────────────────────────────────
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function startBay(id, cwd, cols, rows) {
  killBay(id);

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
        + '  hangar asks your login shell where it is. If `claude` works in your terminal\r\n'
        + '  but not here, your PATH is set somewhere a login shell does not read.\r\n\r\n'
        + '  Check with:  \x1b[36m$SHELL -lic \'command -v claude\'\x1b[0m\r\n',
    });
    send('bay:exit', { id, code: 127, reason: 'claude not found' });
    return { ok: false, error: 'claude not found' };
  }

  const env = { ...(await loginEnv()), HANGAR_USAGE_FILE: usageFile() };
  let proc;
  try {
    proc = pty.spawn(bin, claudeArgs(), {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });
  } catch (e) {
    send('bay:exit', { id, code: -1, reason: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }

  const bay = { proc, buf: '', cwd, exited: false };
  bays.set(id, bay);

  proc.onData((data) => {
    bay.buf += data;
    if (bay.buf.length > MAX_SCROLLBACK) bay.buf = bay.buf.slice(-MAX_SCROLLBACK);
    send('bay:data', { id, data });
  });

  proc.onExit(({ exitCode }) => {
    bay.exited = true;
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

ipcMain.handle('bay:start', (_e, { id, cwd, cols, rows }) => startBay(id, cwd, cols, rows));
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
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',     // the grid IS the chrome
    trafficLightPosition: { x: 18, y: 22 },
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
// HANGAR_SHOT=/path/to.png npm start  → render, wait, photograph, quit.
// An Electron window cannot be screenshotted from outside without Screen Recording
// permission, and "it launched" is not "it looks right". This is the only way to put
// the actual pixels of the actual app in front of a reviewer — or a CI job.
function maybeShoot() {
  const out = process.env.HANGAR_SHOT;
  if (!out) return;
  const wait = Number(process.env.HANGAR_SHOT_WAIT || 3500);
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
  findClaude();   // warm the lookup so the first + is not the thing that waits on a shell
  loginEnv();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Nine unattended agents must not outlive the window that was watching them.
app.on('before-quit', () => { for (const id of [...bays.keys()]) killBay(id); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
