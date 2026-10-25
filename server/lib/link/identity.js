// 榫卯 Tenon v2 · 本机设备身份（持久化在 data/link/device.json）
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, atomicWriteJson, sha256Hex } from './util.js';

export function loadOrCreateIdentity(dataDir, opts = {}) {
  const file = path.join(dataDir, 'link', 'device.json');
  const saved = readJson(file, null);
  if (saved && typeof saved.deviceId === 'string' && saved.deviceId) {
    return {
      ...saved,
      name: saved.name || opts.name || defaultName(),
      platform: saved.platform || opts.platform || platformLabel(),
      fingerprint: saved.fingerprint || defaultFingerprint(dataDir),
    };
  }
  const identity = {
    deviceId: 'dev_' + crypto.randomBytes(5).toString('hex'),
    name: opts.name || defaultName(),
    platform: opts.platform || platformLabel(),
    fingerprint: defaultFingerprint(dataDir),
    createdAt: new Date().toISOString(),
    note: '榫卯 v2 本机设备身份，请勿删除',
  };
  atomicWriteJson(file, identity);
  return identity;
}

function defaultName() {
  const env = process.env.TENON_DEVICE_NAME;
  if (env && env.trim()) return env.trim();
  try {
    const host = os.hostname();
    if (host) return host.length > 24 ? host.slice(0, 24) : host;
  } catch {
    /* ignore */
  }
  return '本机';
}

export function platformLabel() {
  const raw = process.platform + '-' + process.arch;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return raw;
}

function defaultFingerprint(dataDir) {
  let host = '';
  try {
    host = os.hostname();
  } catch {
    /* ignore */
  }
  return sha256Hex([host, process.platform, process.arch, String(dataDir)].join('|')).slice(0, 16);
}