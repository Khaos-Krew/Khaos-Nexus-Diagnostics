'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const payloadDirectory = path.join(root, 'payload');
const distDirectory = path.join(root, 'dist');
const runtimeDirectory = path.join(distDirectory, 'runtime');
const partialManifestPath = path.join(distDirectory, 'manifest.partial.json');
const manifestPath = path.join(distDirectory, 'manifest.json');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimeJson = JSON.parse(fs.readFileSync(path.join(payloadDirectory, 'runtime.json'), 'utf8'));
const version = String(packageJson.version || '').trim();
const archiveName = `Khaos-Nexus-Diagnostics-Runtime-${version}.zip`;
const archivePath = path.join(distDirectory, archiveName);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function filesRecursively(directory, relative = '') {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const nextRelative = path.posix.join(relative, entry.name);
    const nextPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursively(nextPath, nextRelative));
    else if (entry.isFile()) files.push(nextRelative);
  }
  return files.sort();
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
  }
}

function validate() {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid package version: ${version}`);
  if (runtimeJson.version !== version) throw new Error('payload/runtime.json version must match package.json.');
  if (runtimeJson.runtimeApiVersion !== 1) throw new Error('This release workflow currently supports runtime API version 1.');
  for (const required of [runtimeJson.entry, runtimeJson.service, 'main/diagnostic-tool-preload.cjs', 'renderer/diagnostics.html', 'renderer/diagnostics.css', 'renderer/diagnostics.js', 'shared/redaction.cjs']) {
    const normalized = String(required || '').replace(/\\/g, '/');
    if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) throw new Error(`Unsafe runtime path: ${required}`);
    if (!fs.existsSync(path.join(payloadDirectory, normalized))) throw new Error(`Missing runtime file: ${normalized}`);
  }
}

function prepare() {
  validate();
  fs.rmSync(distDirectory, { recursive: true, force: true });
  copyDirectory(payloadDirectory, runtimeDirectory);
  const files = filesRecursively(runtimeDirectory).map((relativePath) => {
    const filePath = path.join(runtimeDirectory, relativePath);
    const stat = fs.statSync(filePath);
    return { path: relativePath, sha256: sha256(filePath), size: stat.size };
  });
  const manifest = {
    format: 'khaos-nexus-diagnostics-release',
    formatVersion: 1,
    version,
    runtimeApiVersion: runtimeJson.runtimeApiVersion,
    desktopCompatibility: runtimeJson.desktopCompatibility,
    entry: runtimeJson.entry,
    service: runtimeJson.service,
    files,
    archive: { name: archiveName, sha256: null, size: null }
  };
  fs.writeFileSync(partialManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  process.stdout.write(`Prepared ${files.length} runtime files for v${version}.\n`);
}

function finalize() {
  if (!fs.existsSync(partialManifestPath)) throw new Error('Run release:prepare before release:finalize.');
  if (!fs.existsSync(archivePath)) throw new Error(`Expected archive was not found: ${archiveName}`);
  const manifest = JSON.parse(fs.readFileSync(partialManifestPath, 'utf8'));
  const stat = fs.statSync(archivePath);
  manifest.archive = { name: archiveName, sha256: sha256(archivePath), size: stat.size };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.rmSync(partialManifestPath, { force: true });
  process.stdout.write(`Finalized ${archiveName} (${stat.size} bytes).\n`);
}

const mode = process.argv[2];
if (mode === 'prepare') prepare();
else if (mode === 'finalize') finalize();
else throw new Error('Usage: node scripts/release.cjs <prepare|finalize>');
