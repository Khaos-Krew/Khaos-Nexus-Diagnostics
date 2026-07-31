'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const payload = path.join(root, 'payload');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimeJson = JSON.parse(fs.readFileSync(path.join(payload, 'runtime.json'), 'utf8'));
const { DiagnosticSuite, normalizeEndpoint, installMode } = require('../payload/main/services/diagnostic-suite.cjs');
const { redactText, redactObject } = require('../payload/shared/redaction.cjs');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khaos-diagnostics-runtime-'));
}

test('runtime metadata and required payload files are consistent', () => {
  assert.equal(runtimeJson.version, packageJson.version);
  assert.equal(runtimeJson.runtimeApiVersion, 1);
  assert.match(runtimeJson.desktopCompatibility.minVersion, /^\d+\.\d+\.\d+$/);
  assert.match(runtimeJson.desktopCompatibility.maxExclusiveVersion, /^\d+\.\d+\.\d+$/);
  for (const relativePath of [
    runtimeJson.entry,
    runtimeJson.service,
    'main/diagnostic-tool-preload.cjs',
    'renderer/diagnostics.html',
    'renderer/diagnostics.css',
    'renderer/diagnostics.js',
    'shared/redaction.cjs'
  ]) {
    assert.equal(fs.existsSync(path.join(payload, relativePath)), true, `${relativePath} must exist`);
  }
});

test('diagnostics uploads stay HTTPS-only and opt-in', () => {
  assert.equal(normalizeEndpoint('https://diagnostics.example.com/'), 'https://diagnostics.example.com');
  assert.throws(() => normalizeEndpoint('http://diagnostics.example.com'), /HTTPS endpoint/i);
  const suite = new DiagnosticSuite({ dataDirectory: tempDirectory(), appVersion: '0.22.1', runtimeVersion: packageJson.version });
  assert.equal(suite.publicSettings().automaticCaptureEnabled, true);
  assert.equal(suite.publicSettings().automaticUploadEnabled, false);
  assert.equal(suite.publicSettings().endpointConfigured, false);
  assert.throws(() => suite.setSettings({ automaticUploadEnabled: true }), /Choose an HTTPS diagnostics endpoint/i);
});

test('known credentials are redacted before report storage', () => {
  const directory = tempDirectory();
  fs.mkdirSync(path.join(directory, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    discord: { token: 'super-secret-discord-token-value' },
    servers: [{ password: 'rcon-secret-value' }]
  }), 'utf8');
  fs.writeFileSync(path.join(directory, 'logs', 'manager.log'), 'authorization: bearer-value\npassword=rcon-secret-value\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'secrets.bin'), Buffer.from('must-never-be-copied'));
  const suite = new DiagnosticSuite({ dataDirectory: directory, appVersion: '0.22.1', runtimeVersion: packageJson.version, installMode: 'installed' });
  suite.startSession();
  const report = suite.createReport({ type: 'test', reason: 'redaction test', severity: 'info' });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /super-secret-discord-token-value/);
  assert.doesNotMatch(serialized, /rcon-secret-value/);
  assert.doesNotMatch(serialized, /must-never-be-copied/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(report.application.diagnosticsRuntimeVersion, packageJson.version);
  const bundle = suite.packageReport(report);
  assert.equal(fs.existsSync(path.join(bundle.bundleDirectory, 'diagnostic-report.json')), true);
  assert.equal(fs.existsSync(path.join(bundle.bundleDirectory, 'secrets.bin')), false);
});

test('a live process session is not misclassified as an unclean shutdown', () => {
  const directory = tempDirectory();
  const main = new DiagnosticSuite({ dataDirectory: directory, appVersion: '0.22.1', runtimeVersion: packageJson.version, pid: process.pid });
  main.startSession({ source: 'live-main-process' });
  const tool = new DiagnosticSuite({ dataDirectory: directory, appVersion: '0.22.1', runtimeVersion: packageJson.version, pid: process.pid + 100000 });
  assert.equal(tool.hadUncleanPreviousSession(), false);
  main.endSession('test-cleanup');
});

test('redaction helpers cover text and nested objects', () => {
  assert.doesNotMatch(redactText('password=do-not-share'), /do-not-share/);
  assert.deepEqual(redactObject({ token: 'abc', nested: { apiKey: 'def' } }), { token: '[REDACTED]', nested: { apiKey: '[REDACTED]' } });
});

test('install mode distinguishes installed, portable, and development builds', () => {
  const oldPortable = process.env.PORTABLE_EXECUTABLE_DIR;
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  assert.equal(installMode({ executablePath: 'C:\\Program Files\\Khaos Nexus\\Khaos Nexus.exe', isPackaged: true }), 'installed');
  process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\Tools\\Khaos Nexus';
  assert.equal(installMode({ executablePath: 'C:\\Tools\\Khaos Nexus.exe', isPackaged: true }), 'portable');
  if (oldPortable === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
  else process.env.PORTABLE_EXECUTABLE_DIR = oldPortable;
  assert.equal(installMode({ isPackaged: false }), 'development');
});

test('release preparation creates a complete file-hash manifest', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'release.cjs'), 'prepare'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'manifest.partial.json'), 'utf8'));
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.runtimeApiVersion, 1);
  assert.equal(manifest.files.length >= 8, true);
  assert.equal(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.size > 0), true);
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
});
