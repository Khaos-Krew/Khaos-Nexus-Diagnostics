'use strict';

(() => {
  const api = window.khaosDiagnostics;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let busy = false;

  function toast(message) {
    const element = $('toast');
    element.textContent = String(message || '').slice(0, 700);
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 4500);
  }

  function errorMessage(error) {
    return String(error?.message || error || 'The diagnostic action failed.').replace(/^Error invoking remote method '[^']+':\s*/i, '').slice(0, 900);
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  }

  function formatTime(value) {
    if (!value) return '—';
    try { return new Date(value).toLocaleString(); }
    catch { return String(value); }
  }

  function checkSymbol(status) {
    return ({ passed: '✓', warning: '!', failed: '×', info: 'i' })[status] || '•';
  }

  function renderChecks(checks = []) {
    const list = $('checkList');
    list.replaceChildren();
    if (!checks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No report is available yet. Run diagnostics to create one.';
      list.appendChild(empty);
      return;
    }
    for (const item of checks) {
      const row = document.createElement('article');
      row.className = `check ${item.status}`;
      const icon = document.createElement('div');
      icon.className = 'check-icon';
      icon.textContent = checkSymbol(item.status);
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = item.id.replace(/-/g, ' ');
      const summary = document.createElement('p');
      summary.textContent = item.summary;
      body.append(title, summary);
      row.append(icon, body);
      list.appendChild(row);
    }
  }

  function render(next) {
    state = next || state;
    if (!state) return;
    const latest = state.latest;
    const summary = latest?.summary || { passed: 0, warnings: 0, failed: 0, info: 0 };
    const total = summary.passed + summary.warnings + summary.failed + summary.info;
    const score = total ? Math.max(0, Math.round(((summary.passed + summary.info * .5) / total) * 100)) : 0;
    $('healthScore').textContent = `${score}%`;
    $('healthOrb').className = `health-orb ${summary.failed ? 'failed' : summary.warnings ? 'warning' : 'good'}`;
    $('buildMode').textContent = state.installMode === 'installed' ? 'Installer build' : `${state.installMode} build`;
    $('appVersion').textContent = `Desktop ${state.appVersion}`;
    $('runtimeVersion').textContent = state.runtimeVersion || 'embedded';
    $('warningCount').textContent = summary.warnings;
    $('failedCount').textContent = summary.failed;
    $('reportId').textContent = latest?.reportId || 'None';
    $('reportTime').textContent = formatTime(latest?.createdAt);
    $('reportTrigger').textContent = latest?.trigger?.type?.replace(/-/g, ' ') || '—';
    $('outboxCount').textContent = state.outboxCount || 0;
    $('endpointInput').value = state.settings?.endpoint || '';
    $('uploadToggle').checked = Boolean(state.settings?.automaticUploadEnabled);
    $('uploadButton').disabled = busy || !latest || !state.settings?.endpointConfigured;
    $('packageButton').disabled = busy || !latest;
    $('copyButton').disabled = busy || !latest;
    $('statusText').textContent = state.previousSessionUnclean
      ? 'The previous app session ended unexpectedly; a report was retained.'
      : 'Diagnostics are local-first. Runtime updates are verified before activation.';
    renderChecks(latest?.checks || []);
  }

  async function action(work, success) {
    if (busy) return;
    try {
      setBusy(true);
      const result = await work();
      state = await api.getState();
      render(state);
      if (success) toast(typeof success === 'function' ? success(result) : success);
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      setBusy(false);
      render(state);
    }
  }

  $('runButton').addEventListener('click', () => action(() => api.run(), 'Diagnostic report captured.'));
  $('packageButton').addEventListener('click', () => action(() => api.packageLatest(), (result) => result.zipPath ? 'Redacted ZIP support bundle created.' : 'Redacted support bundle folder created.'));
  $('copyButton').addEventListener('click', () => action(() => api.copySummary(), 'Diagnostic summary copied.'));
  $('folderButton').addEventListener('click', () => action(() => api.openFolder(), 'Diagnostics folder opened.'));
  $('saveSettingsButton').addEventListener('click', () => action(() => api.setSettings({
    endpoint: $('endpointInput').value,
    automaticUploadEnabled: $('uploadToggle').checked
  }), 'Diagnostics settings saved.'));
  $('uploadButton').addEventListener('click', () => action(() => api.uploadLatest(), (result) => result.uploaded ? 'Diagnostic report uploaded.' : 'Upload failed; the report remains queued locally.'));
  $('closeButton').addEventListener('click', () => api.close());

  api.onUpdate(render);
  api.getState().then(render).catch((error) => toast(errorMessage(error)));
})();
