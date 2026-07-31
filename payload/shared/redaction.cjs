'use strict';

const crypto = require('node:crypto');

const TOKEN_PATTERNS = [
  /(?:mfa\.[\w-]{20,})/gi,
  /(?:[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,})/g,
  /(?:bot\s+)[\w.-]{20,}/gi,
  /(?:authorization["'\s:=]+)[^\s,"']+/gi,
  /(?:password|token|secret|api[_-]?key)(["'\s:=]+)([^\s,"']+)/gi
];

function redactText(input, explicitSecrets = []) {
  let text = String(input ?? '');

  for (const secret of explicitSecrets) {
    if (!secret || String(secret).length < 4) continue;
    text = text.split(String(secret)).join('[REDACTED]');
  }

  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (match, separator) => {
      if (separator) {
        const label = match.slice(0, match.indexOf(separator));
        return `${label}${separator}[REDACTED]`;
      }
      if (/^bot\s+/i.test(match)) return 'Bot [REDACTED]';
      if (/^authorization/i.test(match)) return 'authorization: [REDACTED]';
      return '[REDACTED]';
    });
  }

  text = text.replace(/rcon:\/\/([^:@\s]+):([^@\s]+)@/gi, 'rcon://$1:[REDACTED]@');
  return text;
}

function redactObject(value, explicitSecrets = []) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, explicitSecrets);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, explicitSecrets));
  if (typeof value !== 'object') return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|secret|api[_-]?key/i.test(key)) result[key] = item ? '[REDACTED]' : item;
    else result[key] = redactObject(item, explicitSecrets);
  }
  return result;
}

function errorFingerprint(errorLike) {
  const raw = typeof errorLike === 'string'
    ? errorLike
    : [errorLike?.name, errorLike?.message, errorLike?.stack].filter(Boolean).join('\n');
  const normalized = redactText(raw)
    .replace(/\b0x[\da-f]+\b/gi, '0x#')
    .replace(/\b\d{2,}\b/g, '#')
    .replace(/[A-Z]:\\[^\n:]+/gi, '<path>')
    .replace(/\/[^\s:]+\.(?:js|cjs|mjs|json)/g, '<path>')
    .trim()
    .slice(0, 12000);
  return crypto.createHash('sha256').update(normalized || 'unknown-error').digest('hex').slice(0, 12);
}

module.exports = { redactText, redactObject, errorFingerprint };
