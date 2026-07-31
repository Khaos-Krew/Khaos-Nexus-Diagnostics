'use strict';

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { DiagnosticSuite } = require('./services/diagnostic-suite.cjs');

let windowRef = null;
let service = null;
let running = false;

function iconPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar', 'assets', 'icon.png'),
    path.join(process.resourcesPath || '', 'assets', 'icon.png'),
    path.join(__dirname, '..', '..', 'assets', 'icon.png')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function diagnosticContext() {
  return {
    secureStorageAvailable: (() => {
      try { return electron.safeStorage.isEncryptionAvailable(); }
      catch { return false; }
    })(),
    windowState: { count: 1, visibleCount: windowRef?.isVisible() ? 1 : 0, focusedCount: windowRef?.isFocused() ? 1 : 0, unresponsiveCount: 0 }
  };
}

function state() {
  return service?.publicStatus() || null;
}

function sendState() {
  if (windowRef && !windowRef.isDestroyed() && !windowRef.webContents.isDestroyed()) {
    windowRef.webContents.send('diagnostic-tool:update', state());
  }
}

function registerIpc() {
  const { ipcMain, clipboard, shell } = electron;
  ipcMain.handle('diagnostic-tool:get-state', () => state());
  ipcMain.handle('diagnostic-tool:run', () => {
    const report = service.createReport({
      type: 'standalone-health-check',
      reason: 'Standalone installer diagnostics health check.',
      severity: 'info',
      automatic: false
    }, diagnosticContext());
    sendState();
    return report;
  });
  ipcMain.handle('diagnostic-tool:package', () => {
    const result = service.packageReport(service.latestReport());
    sendState();
    return result;
  });
  ipcMain.handle('diagnostic-tool:copy-summary', () => {
    const text = service.summaryText();
    clipboard.writeText(text);
    return { copied: true, text };
  });
  ipcMain.handle('diagnostic-tool:open-folder', async () => {
    fs.mkdirSync(service.diagnosticsDirectory, { recursive: true });
    const result = await shell.openPath(service.diagnosticsDirectory);
    if (result) throw new Error(result);
    return { opened: true, path: service.diagnosticsDirectory };
  });
  ipcMain.handle('diagnostic-tool:set-settings', (_event, payload = {}) => {
    const settings = service.setSettings(payload);
    sendState();
    return settings;
  });
  ipcMain.handle('diagnostic-tool:upload-latest', async () => {
    const result = await service.uploadReport(service.latestReport(), { force: true });
    sendState();
    return result;
  });
  ipcMain.handle('diagnostic-tool:close', () => electron.app.quit());
}

function createWindow() {
  windowRef = new electron.BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#08090d',
    icon: iconPath(),
    title: 'Khaos Nexus Diagnostics',
    webPreferences: {
      preload: path.join(__dirname, 'diagnostic-tool-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowRef.removeMenu();
  windowRef.loadFile(path.join(__dirname, '..', 'renderer', 'diagnostics.html'));
  windowRef.once('ready-to-show', () => windowRef.show());
  windowRef.on('closed', () => { windowRef = null; });
}

function run(options = {}) {
  if (running) return;
  running = true;
  electron.app.whenReady().then(() => {
    electron.app.setAppUserModelId('com.khaosnexus.desktop.diagnostics');
    service = new DiagnosticSuite({
      dataDirectory: electron.app.getPath('userData'),
      appVersion: options.desktopVersion || electron.app.getVersion(),
      runtimeVersion: options.runtimeVersion || 'embedded',
      executablePath: process.execPath,
      resourcesPath: process.resourcesPath,
      isPackaged: electron.app.isPackaged
    });
    service.startSession({ source: 'standalone-diagnostic-tool', runtimeVersion: options.runtimeVersion || 'embedded' });
    registerIpc();
    const report = service.createReport({
      type: 'standalone-startup-baseline',
      reason: 'Khaos Nexus Diagnostics was launched.',
      severity: 'info',
      automatic: true
    }, diagnosticContext());
    if (service.hadUncleanPreviousSession()) service.acknowledgePreviousSession('standalone-baseline-captured');
    service.breadcrumb('standalone-tool-ready', { reportId: report.reportId, runtimeVersion: options.runtimeVersion || 'embedded' });
    createWindow();
  }).catch((error) => {
    electron.dialog.showErrorBox('Khaos Nexus Diagnostics', error.message || String(error));
    electron.app.quit();
  });

  electron.app.on('before-quit', () => {
    try { service?.endSession('diagnostic-tool-exit'); } catch {}
  });
  electron.app.on('window-all-closed', () => electron.app.quit());
}

module.exports = { run };
