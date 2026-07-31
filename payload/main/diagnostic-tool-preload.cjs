'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('khaosDiagnostics', {
  getState: () => invoke('diagnostic-tool:get-state'),
  run: () => invoke('diagnostic-tool:run'),
  packageLatest: () => invoke('diagnostic-tool:package'),
  copySummary: () => invoke('diagnostic-tool:copy-summary'),
  openFolder: () => invoke('diagnostic-tool:open-folder'),
  setSettings: (payload) => invoke('diagnostic-tool:set-settings', payload),
  uploadLatest: () => invoke('diagnostic-tool:upload-latest'),
  close: () => invoke('diagnostic-tool:close'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('diagnostic-tool:update', listener);
    return () => ipcRenderer.removeListener('diagnostic-tool:update', listener);
  }
});
