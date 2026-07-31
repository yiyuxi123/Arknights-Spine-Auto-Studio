// Minimal CDP (Chrome DevTools Protocol) harness with zero dependencies:
// static file server + headless Chrome launcher + WebSocket client.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.skel': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function startStaticServer(rootDir, port = 0) {
  const root = path.resolve(rootDir);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const filePath = path.resolve(root, '.' + pathname);
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found: ' + pathname);
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        origin: `http://127.0.0.1:${actual}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome/Edge not found; set CHROME_PATH');
}

function killTree(child) {
  if (!child || !child.pid) return;
  try { child.kill(); } catch {}
  // Windows: kill the whole tree (launcher + browser children) so no zombie lingers
  if (process.platform === 'win32') {
    setTimeout(() => {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }, 800);
  }
}

// Windows: 删除目录时 Chrome 进程可能仍抱有文件锁，重试几次直到成功
export async function rmrfRetry(dir, tries = 6, delayMs = 600) {
  if (!dir) return;
  for (let i = 0; i < tries; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* still locked */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}
export function launchChrome({ chromePath = findChrome(), userDataDir, width = 800, height = 800, extraArgs = [], timeoutMs = 30000 } = {}) {
  let child = null;
  let stderr = '';
  const makeArgs = (port) => [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ...extraArgs,
    'about:blank',
  ];
  const wsUrlPromise = new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const deadline = Date.now() + timeoutMs;

    const attempt = (tryCount) => {
      const port = 30000 + Math.floor(Math.random() * 20000);
      let earlyError = null;
      child = spawn(chromePath, makeArgs(port), { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match && !settled) done(resolve, match[1]);
      });
      child.once('error', (err) => {
        earlyError = new Error(`Failed to launch Chrome (${chromePath}): ${err.message}`);
      });
      child.once('exit', (code) => {
        if (!earlyError && code !== 0) {
          earlyError = new Error(`Chrome exited early (code ${code}): ${stderr.slice(-500)}`);
        }
      });
      const poll = async () => {
        if (settled) return;
        if (earlyError) {
          if (tryCount < 2 && Date.now() < deadline) {
            setTimeout(() => attempt(tryCount + 1), 300);
          } else {
            done(reject, earlyError);
          }
          return;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`);
          if (res.ok) {
            const info = await res.json();
            if (info && info.webSocketDebuggerUrl) {
              done(resolve, info.webSocketDebuggerUrl);
              return;
            }
          }
        } catch { /* Chrome not ready yet; keep polling */ }
        if (Date.now() > deadline) {
          killTree(child);
          done(reject, new Error(`Timed out waiting for DevTools endpoint (port ${port}): ${stderr.slice(-500)}`));
          return;
        }
        setTimeout(poll, 200);
      };
      poll();
    };
    attempt(1);
  });
  return {
    get child() { return child; },
    wsUrl: () => wsUrlPromise,
    close: async () => {
      killTree(child);
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

// ---------------------------------------------------------------------------
// CDP WebSocket client (Node >= 21 global WebSocket).
// ---------------------------------------------------------------------------
export class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
          else pending.resolve(msg.result || {});
        }
      } else if (msg.method) {
        const handlers = this.listeners.get(msg.method);
        if (handlers) for (const fn of handlers) fn(msg.params || {});
      }
    });
  }
  send(method, params = {}, sessionId = null) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

export async function evalJs(send, expression, { sessionId = null } = {}) {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error('page error: ' + detail);
  }
  return result.result?.value;
}

export async function newPageSession(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  // wait for the real page: readyState complete AND navigated away from about:blank
  const hrefPrefix = new URL(url).origin + new URL(url).pathname;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await evalJs(
      (m, p) => cdp.send(m, p, sessionId),
      'document.readyState === "complete" && location.href.startsWith(' + JSON.stringify(hrefPrefix) + ')',
    ).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // small settle delay for scripts executed at load
  await new Promise((r) => setTimeout(r, 300));
  return { targetId, sessionId };
}
