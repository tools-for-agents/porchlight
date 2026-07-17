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
const CLAUDE_ARGS = ['--dangerously-skip-permissions'];

const BAYS_PER_PAGE = 9;
const MAX_SCROLLBACK = 200_000;   // chars kept per bay, so a chatty agent cannot eat the heap

/** @type {Map<string, {proc: import('node-pty').IPty, buf: string, cwd: string, exited: boolean}>} */
const bays = new Map();
let win = null;

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
    execFile(sh, ['-lic', 'command -v claude'], { timeout: 8000 }, (err, stdout) => {
      const hit = String(stdout || '').trim().split('\n').filter(Boolean).pop();
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
let loginEnvPromise = null;
function loginEnv() {
  if (loginEnvPromise) return loginEnvPromise;
  loginEnvPromise = new Promise((resolve) => {
    const sh = process.env.SHELL || '/bin/zsh';
    execFile(sh, ['-lic', 'printf %s "$PATH"'], { timeout: 8000 }, (err, stdout) => {
      const p = String(stdout || '').trim();
      resolve({ ...process.env, ...(p ? { PATH: p } : {}), TERM: 'xterm-256color' });
    });
  });
  return loginEnvPromise;
}

// ── State: which bay points at which folder ──────────────────────────────────
// Only paths and titles. No secrets pass through here — the agent authenticates itself
// with your own ~/.claude, exactly as it does in a terminal.
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Array.isArray(s?.pages) && s.pages.length) return s;
  } catch { /* first run, or a file we cannot read: start clean rather than crash */ }
  return { pages: [{ bays: Array(BAYS_PER_PAGE).fill(null) }] };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
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

  const env = await loginEnv();
  let proc;
  try {
    proc = pty.spawn(bin, CLAUDE_ARGS, {
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
    if (process.env.HANGAR_DEBUG) console.log(`[${id}] +${data.length}b`, JSON.stringify(data.slice(0, 60)));
    bay.buf += data;
    if (bay.buf.length > MAX_SCROLLBACK) bay.buf = bay.buf.slice(-MAX_SCROLLBACK);
    send('bay:data', { id, data });
  });

  proc.onExit(({ exitCode }) => {
    bay.exited = true;
    send('bay:exit', { id, code: exitCode });
  });

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

ipcMain.handle('state:load', () => loadState());
ipcMain.handle('state:save', (_e, state) => { saveState(state); return { ok: true }; });
ipcMain.handle('open-folder', (_e, { cwd }) => shell.openPath(cwd));

// ── Window ───────────────────────────────────────────────────────────────────
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
  createWindow();
  maybeShoot();
  findClaude();   // warm the lookup so the first + is not the thing that waits on a shell
  loginEnv();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Nine unattended agents must not outlive the window that was watching them.
app.on('before-quit', () => { for (const id of [...bays.keys()]) killBay(id); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
