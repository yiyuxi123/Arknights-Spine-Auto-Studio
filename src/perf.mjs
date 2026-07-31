// Perf monitor: app process tree (CPU/memory) + system CPU/memory.
// Windows: one CIM query per sample resolves the Electron process tree.
import os from 'node:os';
import { spawn } from 'node:child_process';

function runPowershell(script) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { resolve(null); return; }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve({ out, err }));
  });
}

function cpuTicks() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

const toProc = (p) => {
  const k = Number(p.KernelModeTime) || 0;
  const u = Number(p.UserModeTime) || 0;
  return { name: String(p.Name || '?'), cpuSec: (k + u) / 1e7, memBytes: Number(p.WorkingSetSize) || 0 };
};

export class PerfMonitor {
  constructor({ intervalMs = 2000 } = {}) {
    this.intervalMs = intervalMs;
    this.last = null;
    this.cached = null;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick(); }, this.intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { this.cached = await this.sample(); } catch { /* keep last */ } finally { this.busy = false; }
  }

  async sample() {
    const now = Date.now();
    const sys = cpuTicks();
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const tree = await this.sampleTree();
    const prev = this.last;
    this.last = { ts: now, tree, sys };
    if (!prev || Object.keys(tree).length === 0) {
      return { ok: true, ts: now, cores: os.cpus().length, app: null, sys: null, procs: [], treeSize: 0, baseline: true };
    }
    const wall = (now - prev.ts) / 1000;
    const cores = os.cpus().length;
    const appMem = Object.values(tree).reduce((s, p) => s + p.memBytes, 0);
    const procs = [];
    let appCpuDelta = 0;
    for (const [pid, p] of Object.entries(tree)) {
      const q = prev.tree[pid];
      const cpuDelta = q ? Math.max(0, p.cpuSec - q.cpuSec) : 0;
      appCpuDelta += cpuDelta;
      procs.push({
        pid,
        name: p.name,
        cpuPct: wall > 0 ? +((cpuDelta / wall / cores) * 100).toFixed(1) : 0,
        memMB: +(p.memBytes / 1048576).toFixed(0),
      });
    }
    const appCpuPct = wall > 0 ? Math.min(100 * cores, (appCpuDelta / wall / cores) * 100) : 0;
    const sysIdleDelta = Math.max(0, sys.idle - prev.sys.idle);
    const sysTotalDelta = Math.max(0, sys.total - prev.sys.total);
    const sysCpuPct = sysTotalDelta > 0 ? Math.min(100, (1 - sysIdleDelta / sysTotalDelta) * 100) : 0;
    return {
      ok: true,
      ts: now,
      cores,
      app: {
        cpuPct: +appCpuPct.toFixed(1),
        memMB: +(appMem / 1048576).toFixed(0),
        cpuTimeSec: +Object.values(tree).reduce((s, p) => s + p.cpuSec, 0).toFixed(1),
      },
      sys: {
        cpuPct: +sysCpuPct.toFixed(1),
        memUsedMB: +((memTotal - memFree) / 1048576).toFixed(0),
        memTotalMB: +(memTotal / 1048576).toFixed(0),
        memPct: +(((memTotal - memFree) / memTotal) * 100).toFixed(1),
      },
      procs: procs.sort((a, b) => b.memMB - a.memMB).slice(0, 10),
      treeSize: Object.keys(tree).length,
    };
  }

  async sampleTree() {
    const res = await runPowershell(
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress',
    );
    if (!res) return {};
    let list = [];
    try {
      const j = JSON.parse(res.out.trim() || '[]');
      list = Array.isArray(j) ? j : [j];
    } catch { return {}; }
    if (!list.length) return {};
    const byId = new Map(list.map((p) => [String(p.ProcessId), p]));
    // ??????? electron ??????????????????????/???
    const ppid = String(process.ppid);
    let root = null;
    if (byId.has(ppid) && /^electron/i.test(String(byId.get(ppid).Name || ''))) root = ppid;
    else root = String(process.pid);
    if (!byId.has(root)) return {};
    const tree = {};
    const walk = (pid) => {
      for (const p of list) {
        if (String(p.ParentProcessId) === String(pid)) {
          const id = String(p.ProcessId);
          tree[id] = toProc(p);
          walk(id);
        }
      }
    };
    tree[root] = toProc(byId.get(root));
    walk(root);
    return tree;
  }
}
