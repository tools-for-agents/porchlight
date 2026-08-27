'use strict';

// The renderer runs with contextIsolation and no node integration. This is the entire
// surface it gets: a folder picker, a pty it can write to, and a state file. Nothing
// here takes a command to run — a bay runs `claude` and only `claude`, decided in
// main.js, so a bug in the UI cannot turn a tile into an arbitrary shell.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
  // 🔑 THE ONLY WAY TO GET A DROPPED FILE'S PATH ON ELECTRON ≥32.
  //
  // `File.path` — the property every drag-and-drop snippet on the internet uses — was
  // REMOVED in Electron 32, and it does not throw: it reads back `undefined`, so the
  // naive version writes "undefined" into somebody's prompt and looks like a quoting bug.
  // `webUtils.getPathForFile` is the replacement and it lives in the PRELOAD only (it is
  // absent from the main process entirely — verified against this Electron before use).
  // A File object cannot cross the context bridge, so the renderer hands it in and gets a
  // string back; nothing else about the file is exposed.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  // test hook: HANGAR_ZOOM=<bayId> npm start  → boots with that bay zoomed, so the
  // screenshot harness can photograph a state that otherwise needs a click.
  zoomAtBoot: process.env.HANGAR_ZOOM || null,

  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  start: (id, cwd, cols, rows) => ipcRenderer.invoke('bay:start', { id, cwd, cols, rows }),
  kill: (id) => ipcRenderer.invoke('bay:kill', { id }),
  write: (id, data) => ipcRenderer.send('bay:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('bay:resize', { id, cols, rows }),
  buffer: (id) => ipcRenderer.invoke('bay:buffer', { id }),
  isRunning: (id) => ipcRenderer.invoke('bay:running', { id }),

  usage: () => ipcRenderer.invoke('usage:get'),
  onUsage: (fn) => ipcRenderer.on('usage', (_e, p) => fn(p)),

  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  openFolder: (cwd) => ipcRenderer.invoke('open-folder', { cwd }),

  onData: (fn) => ipcRenderer.on('bay:data', (_e, p) => fn(p)),
  onExit: (fn) => ipcRenderer.on('bay:exit', (_e, p) => fn(p)),

  // jarvis — the voice. The renderer contributes the microphone (getUserMedia lives
  // there) and the orb; every decision — whose voice, which bay, what to type — is made
  // in main. Raw audio goes DOWN this bridge; only status events ever come back up.
  voice: {
    toggle: () => ipcRenderer.invoke('voice:toggle'),
    status: () => ipcRenderer.invoke('voice:status'),
    frame: (buf) => ipcRenderer.send('voice:frame', buf),
    view: (v) => ipcRenderer.send('voice:view', v),
    ptt: () => ipcRenderer.send('voice:ptt'),
    enrollStart: () => ipcRenderer.send('voice:enroll-start'),
    enrollCapture: () => ipcRenderer.send('voice:enroll-capture'),
    enrollCancel: () => ipcRenderer.send('voice:enroll-cancel'),
    onEvent: (fn) => ipcRenderer.on('voice:event', (_e, p) => fn(p)),
  },
});
