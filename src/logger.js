'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function maskApiKey(value) {
  const key = String(value ?? '');
  if (!key) return '';
  if (key.length <= 8) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function maskAddress(value) {
  const address = String(value ?? '');
  if (address.length <= 10) return '***';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function maskUserId(value) {
  const id = String(value ?? '');
  if (!id) return '';
  if (id.length <= 4) return '***';
  return `*${id.slice(-4)}`;
}

class Logger {
  constructor(level = 'info') {
    this.level = LEVELS[level] ?? LEVELS.info;
  }

  _write(level, event, fields) {
    if (LEVELS[level] < this.level) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(fields || {}),
    });
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }

  error(event, fields) {
    this._write('error', event, fields);
  }

  warn(event, fields) {
    this._write('warn', event, fields);
  }

  info(event, fields) {
    this._write('info', event, fields);
  }

  debug(event, fields) {
    this._write('debug', event, fields);
  }
}

module.exports = { Logger, maskApiKey, maskAddress, maskUserId };
