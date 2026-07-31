'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redactObject, redactText, errorFingerprint } = require('../../shared/redaction.cjs');

const FORMAT = 'khaos-nexus-diagnostic-report';
const FORMAT_VERSION = 1;
const MAX_REPORTS = 50;
const MAX_LOG_BYTES = 512 * 1024;

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const iso = (value = Date.now()) => new Date(value).toISOString();
const safeId = (value, fallback = 'report') => String(value || '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || fallback;

function safeJsonRead(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function atomicJsonWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  try { fs.renameSync(temporary, filePath); }
  catch { fs.rmSync(filePath, { force: true }); fs.renameSync(temporary, filePath); }
}

function tailFile(filePath, maxBytes = MAX_LOG_BYTES) {
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, maxBytes);
    const descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    try { fs.readSync(descriptor, buffer, 0, size, stat.size - size); }
    finally { fs.closeSync(descriptor); }
    return buffer.toString('utf8');
  } catch { return ''; }
}

function normalizeEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const url = new URL(text);
  if (url.protocol !== 'https:') throw new Error('Diagnostics uploads require an HTTPS endpoint.');
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function installMode({ executablePath = process.execPath, isPackaged = false } = {}) {
  if (!isPackaged) return 'development';
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  const normalized = String(executablePath || '').toLowerCase();
  if (normalized.includes('\\appdata\\local\\temp\\') || normalized.includes('/tmp/')) return 'temporary';
  return 'installed';
}

function listFiles(directory, predicate = () => true, limit = 50) {
  try {
    return fs.readdirSync(directory).filter(predicate).map((name) => {
      const filePath = path.join(directory, name);
      const stat = fs.statSync(filePath);
      return { name, filePath, modifiedAt: stat.mtimeMs, size: stat.size };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit);
  } catch { return []; }
}

function writableCheck(directory) {
  const filePath = path.join(directory, `.diagnostic-write-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(filePath, 'ok', 'utf8');
    fs.rmSync(filePath, { force: true });
    return true;
  } catch { return false; }
}

function fileMetadata(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch { return { exists: false, size: 0, modifiedAt: null }; }
}

function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value < 1) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function diskSnapshot(directory) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stat = fs.statfsSync(directory);
    const multiplier = Number(stat.bsize || 0);
    return {
      freeMb: Math.round(Number(stat.bavail || stat.bfree || 0) * multiplier / 1024 / 1024),
      totalMb: Math.round(Number(stat.blocks || 0) * multiplier / 1024 / 1024)
    };
  } catch { return null; }
}

function processSnapshot() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, Math.round(value / 1024 / 1024)]))
  };
}

class DiagnosticSuite {
  constructor(options = {}) {
    if (!options.dataDirectory) throw new Error('DiagnosticSuite requires a dataDirectory.');
    this.dataDirectory = path.resolve(options.dataDirectory);
    this.pid = Number(options.pid || process.pid);
    this.appVersion = String(options.appVersion || 'unknown');
    this.runtimeVersion = String(options.runtimeVersion || 'embedded');
    this.executablePath = String(options.executablePath || process.execPath);
    this.resourcesPath = String(options.resourcesPath || process.resourcesPath || '');
    this.isPackaged = Boolean(options.isPackaged);
    this.mode = options.installMode || installMode({ executablePath: this.executablePath, isPackaged: this.isPackaged });
    this.now = options.now || (() => Date.now());
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.getUploadToken = options.getUploadToken || (() => '');
    this.diagnosticsDirectory = path.join(this.dataDirectory, 'diagnostics');
    this.reportsDirectory = path.join(this.diagnosticsDirectory, 'reports');
    this.bundlesDirectory = path.join(this.diagnosticsDirectory, 'bundles');
    this.outboxDirectory = path.join(this.diagnosticsDirectory, 'outbox');
    this.sessionsDirectory = path.join(this.diagnosticsDirectory, 'active-sessions');
    this.activeSessionPath = path.join(this.sessionsDirectory, `${this.pid}.json`);
    this.settingsPath = path.join(this.diagnosticsDirectory, 'settings.json');
    this.latestPath = path.join(this.diagnosticsDirectory, 'latest.json');
    this.breadcrumbPath = path.join(this.diagnosticsDirectory, 'breadcrumbs.ndjson');
    for (const directory of [this.reportsDirectory, this.bundlesDirectory, this.outboxDirectory, this.sessionsDirectory]) fs.mkdirSync(directory, { recursive: true });
    this.settings = this.loadSettings();
    this.previousSession = this.findUncleanSession();
    this.session = null;
    this.recentCapture = { fingerprint: '', at: 0, report: null };
  }

  loadSettings() {
    const current = safeJsonRead(this.settingsPath, {});
    const settings = {
      formatVersion: 1,
      installationId: String(current.installationId || crypto.randomUUID()),
      automaticCaptureEnabled: current.automaticCaptureEnabled !== false,
      automaticUploadEnabled: current.automaticUploadEnabled === true,
      endpoint: '',
      consentUpdatedAt: current.consentUpdatedAt || null
    };
    try { settings.endpoint = normalizeEndpoint(current.endpoint || ''); } catch {}
    atomicJsonWrite(this.settingsPath, settings);
    return settings;
  }

  publicSettings() {
    return {
      automaticCaptureEnabled: this.settings.automaticCaptureEnabled,
      automaticUploadEnabled: this.settings.automaticUploadEnabled,
      endpoint: this.settings.endpoint,
      endpointConfigured: Boolean(this.settings.endpoint),
      consentUpdatedAt: this.settings.consentUpdatedAt,
      installationId: this.settings.installationId
    };
  }

  setSettings(input = {}) {
    const next = { ...this.settings };
    if ('automaticCaptureEnabled' in input) next.automaticCaptureEnabled = Boolean(input.automaticCaptureEnabled);
    if ('automaticUploadEnabled' in input) next.automaticUploadEnabled = Boolean(input.automaticUploadEnabled);
    if ('endpoint' in input) next.endpoint = normalizeEndpoint(input.endpoint);
    if (next.automaticUploadEnabled && !next.endpoint) throw new Error('Choose an HTTPS diagnostics endpoint before enabling automatic uploads.');
    if ('automaticUploadEnabled' in input || 'endpoint' in input) next.consentUpdatedAt = iso(this.now());
    this.settings = next;
    atomicJsonWrite(this.settingsPath, next);
    this.breadcrumb('settings-updated', { automaticCaptureEnabled: next.automaticCaptureEnabled, automaticUploadEnabled: next.automaticUploadEnabled, endpointConfigured: Boolean(next.endpoint) });
    return this.publicSettings();
  }

  findUncleanSession() {
    for (const file of listFiles(this.sessionsDirectory, (name) => name.endsWith('.json'), 20)) {
      const session = safeJsonRead(file.filePath, null);
      if (!session?.id || Number(session.pid) === this.pid || isProcessAlive(session.pid)) continue;
      return { ...session, filePath: file.filePath };
    }
    return null;
  }

  hadUncleanPreviousSession() { return Boolean(this.previousSession); }

  acknowledgePreviousSession(reason = 'captured') {
    if (!this.previousSession?.filePath) return null;
    const archived = { ...this.previousSession, detectedAt: iso(this.now()), detectionReason: reason };
    atomicJsonWrite(path.join(this.diagnosticsDirectory, 'sessions', `${safeId(this.previousSession.startedAt)}-${this.previousSession.id}-unclean.json`), archived);
    fs.rmSync(this.previousSession.filePath, { force: true });
    this.previousSession = null;
    return archived;
  }

  startSession(detail = {}) {
    if (this.session) return clone(this.session);
    this.session = { format: 'khaos-nexus-diagnostic-session', formatVersion: 1, id: crypto.randomUUID(), startedAt: iso(this.now()), appVersion: this.appVersion, runtimeVersion: this.runtimeVersion, installMode: this.mode, pid: this.pid, detail: redactObject(detail) };
    atomicJsonWrite(this.activeSessionPath, this.session);
    this.breadcrumb('session-started', { sessionId: this.session.id, installMode: this.mode, runtimeVersion: this.runtimeVersion });
    return clone(this.session);
  }

  endSession(reason = 'clean-exit') {
    if (!this.session) return null;
    const completed = { ...this.session, endedAt: iso(this.now()), endReason: reason };
    atomicJsonWrite(path.join(this.diagnosticsDirectory, 'sessions', `${safeId(this.session.startedAt)}-${this.session.id}.json`), completed);
    fs.rmSync(this.activeSessionPath, { force: true });
    this.breadcrumb('session-ended', { sessionId: this.session.id, reason });
    this.session = null;
    return completed;
  }

  breadcrumb(event, detail = {}) {
    const line = JSON.stringify({ time: iso(this.now()), event: safeId(event, 'event'), detail: redactObject(detail) });
    fs.mkdirSync(path.dirname(this.breadcrumbPath), { recursive: true });
    fs.appendFileSync(this.breadcrumbPath, `${line}\n`, 'utf8');
    try {
      if (fs.statSync(this.breadcrumbPath).size > 2 * 1024 * 1024) {
        const retained = tailFile(this.breadcrumbPath, 1024 * 1024);
        fs.writeFileSync(this.breadcrumbPath, retained.slice(retained.indexOf('\n') + 1), 'utf8');
      }
    } catch {}
  }

  runChecks(context = {}) {
    const checks = [];
    const add = (id, status, summary, detail = {}) => checks.push({ id, status, summary, detail: redactObject(detail) });
    add('install-mode', this.mode === 'temporary' ? 'warning' : 'passed', `Running as ${this.mode}.`, { executablePath: redactText(this.executablePath) });
    add('diagnostics-runtime', 'passed', `Diagnostics runtime ${this.runtimeVersion} is active.`, { runtimeVersion: this.runtimeVersion });
    const writable = writableCheck(this.dataDirectory);
    add('data-directory', writable ? 'passed' : 'failed', writable ? 'Application data directory is writable.' : 'Application data directory is not writable.', { path: redactText(this.dataDirectory) });
    const config = fileMetadata(path.join(this.dataDirectory, 'config.json'));
    add('configuration', config.exists ? 'passed' : 'info', config.exists ? 'Configuration file is present.' : 'Configuration file has not been created yet.', config);
    const secrets = fileMetadata(path.join(this.dataDirectory, 'secrets.bin'));
    add('protected-storage', secrets.exists ? 'passed' : 'info', secrets.exists ? 'Protected credential store is present; contents were excluded.' : 'No protected credential file exists yet.', { exists: secrets.exists, size: secrets.size });
    if (context.secureStorageAvailable !== undefined) add('secure-storage-api', context.secureStorageAvailable ? 'passed' : 'warning', context.secureStorageAvailable ? 'Windows protected storage is available.' : 'Windows protected storage is unavailable.');
    add('previous-shutdown', this.hadUncleanPreviousSession() ? 'warning' : 'passed', this.hadUncleanPreviousSession() ? 'A previous Khaos Nexus session ended without a clean shutdown marker.' : 'No unclean previous session was detected.', this.previousSession ? { startedAt: this.previousSession.startedAt, appVersion: this.previousSession.appVersion } : {});
    const disk = diskSnapshot(this.dataDirectory);
    if (disk) add('disk-space', disk.freeMb < 512 ? 'warning' : 'passed', `${disk.freeMb} MB of free space is available.`, disk);
    if (context.windowState) add('desktop-window', Number(context.windowState.unresponsiveCount || 0) > 0 ? 'failed' : 'passed', Number(context.windowState.unresponsiveCount || 0) > 0 ? 'A desktop window is unresponsive.' : 'Desktop windows are responsive.', context.windowState);
    for (const extra of Array.isArray(context.additionalChecks) ? context.additionalChecks : []) add(extra.id || 'additional', extra.status || 'info', extra.summary || 'Additional diagnostic check.', extra.detail || {});
    return checks;
  }

  readEvidence() {
    const logFiles = ['manager.log', 'interface-watchdog.log', 'startup-core-release.log'];
    const logs = logFiles.map((name) => ({ name, text: redactText(tailFile(path.join(this.dataDirectory, 'logs', name))) })).filter((entry) => entry.text);
    const jsonFiles = ['interface-watchdog-state.json', 'interface-watchdog-error.json', 'startup-health.json', 'renderer-action-errors.json'];
    const state = Object.fromEntries(jsonFiles.map((name) => [name, redactObject(safeJsonRead(path.join(this.dataDirectory, name), null))]).filter(([, value]) => value));
    const crashes = listFiles(path.join(this.dataDirectory, 'crash-reports'), (name) => name.endsWith('.json'), 5).map((file) => ({ name: file.name, modifiedAt: new Date(file.modifiedAt).toISOString(), report: redactObject(safeJsonRead(file.filePath, null)) }));
    return { recentLogs: logs.map((entry) => `--- ${entry.name} ---\n${entry.text}`).join('\n'), retainedState: state, crashReports: crashes };
  }

  createReport(trigger = {}, context = {}) {
    const reason = String(trigger.reason || trigger.type || 'manual-diagnostic').slice(0, 500);
    const error = trigger.error instanceof Error ? trigger.error : new Error(reason);
    const fingerprint = errorFingerprint(error);
    const now = this.now();
    if (fingerprint === this.recentCapture.fingerprint && now - this.recentCapture.at < 5000 && this.recentCapture.report) return clone(this.recentCapture.report);
    const createdAt = iso(now);
    const reportId = `KN-${createdAt.slice(0, 10).replace(/-/g, '')}-${createdAt.slice(11, 19).replace(/:/g, '')}-${fingerprint}`;
    const checks = this.runChecks(context);
    const report = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      reportId,
      createdAt,
      trigger: {
        type: safeId(trigger.type, 'manual'),
        reason: redactText(reason),
        severity: ['info', 'warning', 'error', 'fatal'].includes(trigger.severity) ? trigger.severity : 'error',
        automatic: trigger.automatic === true,
        detail: redactObject(trigger.detail && typeof trigger.detail === 'object' ? trigger.detail : {}),
        fingerprint,
        error: trigger.error ? { name: String(error.name || 'Error').slice(0, 120), message: redactText(error.message || reason).slice(0, 2000), stack: redactText(error.stack || '').slice(0, 16000), code: error.code ? String(error.code).slice(0, 120) : null } : null
      },
      application: { name: 'Khaos Nexus', version: this.appVersion, diagnosticsRuntimeVersion: this.runtimeVersion, packaged: this.isPackaged, installMode: this.mode, executablePath: redactText(this.executablePath), resourcesPath: redactText(this.resourcesPath), dataDirectory: redactText(this.dataDirectory) },
      session: { id: this.session?.id || null, startedAt: this.session?.startedAt || null, previousShutdownClean: !this.hadUncleanPreviousSession() },
      system: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpuCount: os.cpus().length, totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024), freeMemoryMb: Math.round(os.freemem() / 1024 / 1024), disk: diskSnapshot(this.dataDirectory) },
      process: processSnapshot(),
      checks,
      summary: { passed: checks.filter((item) => item.status === 'passed').length, warnings: checks.filter((item) => item.status === 'warning').length, failed: checks.filter((item) => item.status === 'failed').length, info: checks.filter((item) => item.status === 'info').length },
      breadcrumbs: tailFile(this.breadcrumbPath, 256 * 1024).split(/\r?\n/).filter(Boolean).slice(-250).map((line) => { try { return redactObject(JSON.parse(line)); } catch { return { time: null, event: 'unparsed', detail: redactText(line) }; } }),
      evidence: this.readEvidence(),
      privacy: { redactedLocally: true, secretsIntentionallyExcluded: true, automaticUploadEnabled: this.settings.automaticUploadEnabled, note: 'Known credential formats are redacted and secrets.bin contents are never copied.' }
    };
    const filePath = path.join(this.reportsDirectory, `${reportId}.json`);
    atomicJsonWrite(filePath, report);
    const publicReport = { ...report, filePath };
    atomicJsonWrite(this.latestPath, { reportId, createdAt, filePath, summary: report.summary, trigger: report.trigger });
    this.recentCapture = { fingerprint, at: now, report: publicReport };
    this.breadcrumb('report-captured', { reportId, trigger: report.trigger.type, summary: report.summary });
    this.pruneReports();
    return clone(publicReport);
  }

  captureAutomatic(trigger = {}, context = {}) {
    if (!this.settings.automaticCaptureEnabled) return { skipped: true, reason: 'automatic-capture-disabled' };
    return this.createReport({ ...trigger, automatic: true }, context);
  }

  latestReport() {
    const latest = safeJsonRead(this.latestPath, null);
    if (!latest?.filePath || !fs.existsSync(latest.filePath)) return null;
    const report = safeJsonRead(latest.filePath, null);
    return report ? { ...report, filePath: latest.filePath } : null;
  }

  reportPath(reportOrId) {
    if (reportOrId && typeof reportOrId === 'object' && reportOrId.filePath) return reportOrId.filePath;
    const id = String((reportOrId && typeof reportOrId === 'object' ? reportOrId.reportId : reportOrId) || this.latestReport()?.reportId || '');
    if (!id) throw new Error('No diagnostic report is available.');
    const filePath = path.join(this.reportsDirectory, `${safeId(id)}.json`);
    if (!fs.existsSync(filePath)) throw new Error(`Diagnostic report ${id} was not found.`);
    return filePath;
  }

  packageReport(reportOrId) {
    const report = safeJsonRead(this.reportPath(reportOrId), null);
    if (!report) throw new Error('The diagnostic report could not be read.');
    const name = safeId(report.reportId, `KN-${Date.now()}`);
    const bundleDirectory = path.join(this.bundlesDirectory, name);
    fs.rmSync(bundleDirectory, { recursive: true, force: true });
    fs.mkdirSync(bundleDirectory, { recursive: true });
    atomicJsonWrite(path.join(bundleDirectory, 'diagnostic-report.json'), report);
    fs.writeFileSync(path.join(bundleDirectory, 'summary.txt'), this.summaryText(report), 'utf8');
    fs.writeFileSync(path.join(bundleDirectory, 'recent-application-logs.txt'), String(report.evidence?.recentLogs || ''), 'utf8');
    fs.writeFileSync(path.join(bundleDirectory, 'diagnostic-breadcrumbs.txt'), (report.breadcrumbs || []).map((item) => JSON.stringify(item)).join('\n'), 'utf8');
    fs.writeFileSync(path.join(bundleDirectory, 'README.txt'), 'Khaos Nexus diagnostic bundle\r\n\r\nKnown credential formats were redacted and secrets.bin was not copied. Review all files before sharing.\r\n', 'utf8');
    let zipPath = null;
    if (process.platform === 'win32') {
      zipPath = path.join(this.bundlesDirectory, `${name}.zip`);
      const source = bundleDirectory.replace(/'/g, "''");
      const destination = zipPath.replace(/'/g, "''");
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Compress-Archive -LiteralPath '${source}\\*' -DestinationPath '${destination}' -CompressionLevel Optimal -Force`], { windowsHide: true, timeout: 60000, encoding: 'utf8' });
      if (result.status !== 0 || !fs.existsSync(zipPath)) zipPath = null;
    }
    this.breadcrumb('report-packaged', { reportId: report.reportId, bundleDirectory, zipCreated: Boolean(zipPath) });
    return { reportId: report.reportId, bundleDirectory, zipPath };
  }

  summaryText(report = this.latestReport()) {
    if (!report) return 'No Khaos Nexus diagnostic report is available.';
    const failed = report.checks.filter((item) => item.status === 'failed');
    const warnings = report.checks.filter((item) => item.status === 'warning');
    return [`Khaos Nexus diagnostic report ${report.reportId}`, `Created: ${report.createdAt}`, `Version: ${report.application.version}`, `Diagnostics runtime: ${report.application.diagnosticsRuntimeVersion || 'embedded'}`, `Build: ${report.application.installMode}`, `Trigger: ${report.trigger.type} — ${report.trigger.reason}`, `Checks: ${report.summary.passed} passed, ${report.summary.warnings} warning(s), ${report.summary.failed} failed`, '', ...failed.map((item) => `FAILED: ${item.summary}`), ...warnings.map((item) => `WARNING: ${item.summary}`), '', 'Known credentials were redacted locally. Review the bundle before sharing.'].join('\r\n').trim();
  }

  async uploadReport(reportOrId, options = {}) {
    if (!this.settings.automaticUploadEnabled && options.force !== true) return { skipped: true, reason: 'automatic-upload-disabled' };
    const endpoint = normalizeEndpoint(options.endpoint || this.settings.endpoint);
    if (!endpoint) throw new Error('A diagnostics API endpoint is not configured.');
    if (typeof this.fetchImpl !== 'function') throw new Error('The diagnostics API client is unavailable in this runtime.');
    const report = safeJsonRead(this.reportPath(reportOrId), null);
    const token = String(await this.getUploadToken() || '');
    try {
      const response = await this.fetchImpl(`${endpoint}/api/v1/diagnostics/reports`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-khaos-installation-id': this.settings.installationId, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(report), signal: AbortSignal.timeout(30000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`Diagnostics API returned HTTP ${response.status}: ${body.slice(0, 500)}`);
      fs.rmSync(path.join(this.outboxDirectory, `${report.reportId}.json`), { force: true });
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      this.breadcrumb('report-uploaded', { reportId: report.reportId, remoteId: parsed.reportId || null });
      return { uploaded: true, reportId: report.reportId, remoteId: parsed.reportId || null };
    } catch (error) {
      atomicJsonWrite(path.join(this.outboxDirectory, `${report.reportId}.json`), report);
      this.breadcrumb('report-upload-failed', { reportId: report.reportId, message: error.message });
      return { uploaded: false, queued: true, reportId: report.reportId, error: redactText(error.message) };
    }
  }

  async flushOutbox() {
    if (!this.settings.automaticUploadEnabled || !this.settings.endpoint) return { skipped: true, reason: 'automatic-upload-disabled' };
    const results = [];
    for (const file of listFiles(this.outboxDirectory, (name) => name.endsWith('.json'), 20).reverse()) results.push(await this.uploadReport(safeJsonRead(file.filePath, null), { force: true }));
    return { processed: results.length, results };
  }

  publicStatus() {
    const latest = this.latestReport();
    return { diagnosticsDirectory: this.diagnosticsDirectory, installMode: this.mode, appVersion: this.appVersion, runtimeVersion: this.runtimeVersion, session: clone(this.session), previousSessionUnclean: this.hadUncleanPreviousSession(), settings: this.publicSettings(), latest: latest ? { reportId: latest.reportId, createdAt: latest.createdAt, trigger: latest.trigger, summary: latest.summary, checks: latest.checks, filePath: latest.filePath } : null, outboxCount: listFiles(this.outboxDirectory, (name) => name.endsWith('.json'), 1000).length };
  }

  pruneReports() {
    for (const file of listFiles(this.reportsDirectory, (name) => name.endsWith('.json'), 1000).slice(MAX_REPORTS)) fs.rmSync(file.filePath, { force: true });
  }
}

module.exports = { DiagnosticSuite, FORMAT, FORMAT_VERSION, normalizeEndpoint, installMode, atomicJsonWrite, safeJsonRead, tailFile, processSnapshot, diskSnapshot, isProcessAlive };
