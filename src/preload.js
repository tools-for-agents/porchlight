'use strict';

// The renderer runs with contextIsolation and no node integration. This is the entire
// surface it gets: a folder picker, a pty it can write to, and a state file. Nothing
// here takes a command to run — a bay runs `claude` and only `claude`, decided in
// main.js, so a bug in the UI cannot turn a tile into an arbitrary shell.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  start: (id, cwd, cols, rows) => ipcRenderer.invoke('bay:start', { id, cwd, cols, rows }),
  kill: (id) => ipcRenderer.invoke('bay:kill', { id }),
  write: (id, data) => ipcRenderer.send('bay:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('bay:resize', { id, cols, rows }),
  buffer: (id) => ipcRenderer.invoke('bay:buffer', { id }),
  isRunning: (id) => ipcRenderer.invoke('bay:running', { id }),

  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  openFolder: (cwd) => ipcRenderer.invoke('open-folder', { cwd }),

  onData: (fn) => ipcRenderer.on('bay:data', (_e, p) => fn(p)),
  onExit: (fn) => ipcRenderer.on('bay:exit', (_e, p) => fn(p)),
});
