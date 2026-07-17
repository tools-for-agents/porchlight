'use strict';

// The renderer runs with contextIsolation and no node integration. This is the entire
// surface it gets: a folder picker, a pty it can write to, and a state file. Nothing
// here takes a command to run — a bay runs `claude` and only `claude`, decided in
// main.js, so a bug in the UI cannot turn a tile into an arbitrary shell.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
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
});
