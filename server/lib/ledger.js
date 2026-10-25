import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);

export function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

export function hashOf(ev) {
  const material = [ev.seq, ev.at, ev.type, ev.actor, stable(ev.data || {}), ev.prev].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}

export function newId(prefix) {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${t}${r}`;
}

export class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'events.jsonl');
    this.events = [];
    this.lastSeq = 0;
    this.lastHash = GENESIS;
    this.gaps = [];
    this.corruptLines = 0;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const raw = fs.readFileSync(this.file, 'utf8');
    const lines = raw.split('\n');
    let prev = GENESIS;
    let prevSeq = 0;
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        this.corruptLines += 1;
        this.gaps.push({ seq: prevSeq + 1, at: null, reason: 'corrupt-line', line: index + 1 });
        return;
      }
      const expected = hashOf(ev);
      if (ev.prev !== prev) {
        this.gaps.push({ seq: ev.seq, at: ev.at, reason: 'hash-chain-mismatch' });
      } else if (ev.hash !== expected) {
        this.gaps.push({ seq: ev.seq, at: ev.at, reason: 'hash-mismatch' });
      }
      if (ev.seq !== prevSeq + 1) {
        this.gaps.push({ seq: ev.seq, at: ev.at, reason: 'seq-gap', expected: prevSeq + 1 });
      }
      this.events.push(ev);
      prev = ev.hash;
      prevSeq = ev.seq;
    });
    this.lastHash = prev;
    this.lastSeq = prevSeq;
  }

  append(type, data = {}, actor = 'hub') {
    const seq = this.lastSeq + 1;
    const at = new Date().toISOString();
    const ev = { seq, at, type, actor, data };
    ev.prev = this.lastHash;
    ev.hash = hashOf(ev);
    fs.appendFileSync(this.file, JSON.stringify(ev) + '\n', 'utf8');
    this.events.push(ev);
    this.lastSeq = seq;
    this.lastHash = ev.hash;
    for (const fn of this.subscribers) fn(ev);
    return ev;
  }

  subscribers = new Set();
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  integrity() {
    return {
      events: this.events.length,
      lastSeq: this.lastSeq,
      lastHash: this.lastHash,
      gaps: this.gaps,
      corruptLines: this.corruptLines,
      ok: this.gaps.length === 0,
    };
  }
}
