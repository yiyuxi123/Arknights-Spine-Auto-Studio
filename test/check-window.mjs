// Diagnostic: attach to Electron CDP, reload page, collect console errors, snapshot UI, screenshot.
const fs = await import('node:fs');
const PORT = process.env.CDP_PORT || '9333';
const SHOT = process.env.SHOT_PATH || 'E:/desktop/zdxr/electron-check.png';

async function main() {
  const list = await fetch('http://127.0.0.1:' + PORT + '/json').then(r => r.json());
  const page = list.find(t => t.type === 'page');
  if (!page) { console.log('NO_PAGE_TARGET'); process.exit(2); }
  console.log('PAGE: ' + JSON.stringify({ title: page.title, url: page.url }));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });

  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result || {});
    } else if (msg.method) {
      if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        events.push({ t: msg.params.type, args: msg.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        events.push({ t: 'exception', args: msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text });
      }
      if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
        events.push({ t: 'http-' + msg.params.response.status, args: msg.params.response.url });
      }
      if (msg.method === 'Network.loadingFailed') {
        events.push({ t: 'net-fail', args: msg.params.errorText + ' | ' + (msg.params.canceled ? 'canceled' : '') });
      }
      if (msg.method === 'Log.entryAdded' && (msg.params.entry.level === 'error' || msg.params.entry.level === 'warning')) {
        events.push({ t: 'log-' + msg.params.entry.level, args: msg.params.entry.text });
      }
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++msgId;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 5000));

  const state = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({ title: document.title, ready: document.readyState, bodyLen: (document.body.innerText||"").length, errorEls: Array.from(document.querySelectorAll(".error, .err, [class*=error]")).map(e => e.className + "|" + (e.innerText||"").slice(0,120)).slice(0,10), bodyHead: (document.body.innerText||"").slice(0,800) })',
    returnByValue: true,
  });
  console.log('EVAL_FULL: ' + JSON.stringify(state));
  console.log('STATE: ' + (state.result?.value ?? 'N/A'));
  console.log('EVENTS(' + events.length + '): ' + JSON.stringify(events, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.data) { fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64')); console.log('SHOT: ' + SHOT); }
  ws.close();
}
main().catch(e => { console.error('CHECK_FAILED', e); process.exit(1); });
