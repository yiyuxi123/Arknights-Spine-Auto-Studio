import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { launchChrome, CdpClient, newPageSession, evalJs } from '../src/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'http://127.0.0.1:4879/ui/';
const errors = [];
const logs = [];

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdxr-ui-'));
const chrome = launchChrome({ width: 1280, height: 900, userDataDir });
const wsUrl = await chrome.wsUrl();
const cdp = new CdpClient(wsUrl);
await cdp.open();
const { sessionId } = await newPageSession(cdp, url);

// capture console + exceptions
cdp.on('Runtime.consoleAPICalled', (p) => {
  const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
  logs.push('[console] ' + text);
  if (p.type === 'error') errors.push('[console.error] ' + text);
});
cdp.on('Runtime.exceptionThrown', (p) => {
  errors.push('[exception] ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown'));
});
cdp.on('Log.entryAdded', (p) => {
  if (p.entry?.level === 'error') errors.push('[log] ' + p.entry.text);
});
try { await cdp.send('Log.enable', {}, sessionId); } catch {}

const send = (m, p) => cdp.send(m, p, sessionId);
await new Promise((r) => setTimeout(r, 2500));

const checks = {};
checks.title = await evalJs(send, 'document.title');
checks.tabs = await evalJs(send, 'document.querySelectorAll(".tab-btn").length');
checks.cards = await evalJs(send, 'document.querySelectorAll(".model-card").length');
checks.chromeChip = await evalJs(send, 'document.getElementById("chip-chrome").textContent');
checks.srvChip = await evalJs(send, 'document.getElementById("chip-srv").textContent');
checks.animChips = await evalJs(send, 'document.querySelectorAll("#gen-anims .chip-anim").length');

// settings panel
await evalJs(send, "(() => { document.getElementById('btn-settings').click(); return true; })()");
await new Promise((r) => setTimeout(r, 800));
checks.settingsOpen = await evalJs(send, '!document.getElementById("settings-overlay").hidden');
checks.cfgCurrent = await evalJs(send, 'document.getElementById("cfg-current").textContent');
checks.cfgModel = await evalJs(send, 'document.getElementById("cfg-model").value');
await evalJs(send, "(() => { document.getElementById('btn-settings-close').click(); return true; })()");

// guard: run with prompt but no model -> inline error + jump to models tab
await evalJs(send, "(() => { document.getElementById('g-prompt').value = '\u6D4B\u8BD5\u52A8\u4F5C'; document.getElementById('btn-run').click(); return true; })()");
await new Promise((r) => setTimeout(r, 500));
checks.guardRun = await evalJs(send, 'document.getElementById("run-status").textContent.includes("\u9009\u62E9\u4E00\u4E2A\u6A21\u578B")');
checks.guardTab = await evalJs(send, 'document.querySelector(".tab-btn.active").dataset.tab === "models"');

// steps bar exists
checks.steps = await evalJs(send, 'document.querySelectorAll(".steps .step").length');

// simulate resolve of an enemy (network)
await evalJs(send, `(() => {
  document.querySelector('input[name=kind][value=enemy]').checked = true;
  document.getElementById('f-name').value = '霜星';
  document.getElementById('btn-resolve').click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 6000));
checks.resolveText = await evalJs(send, 'document.getElementById("resolve-out").textContent');
checks.skinRow = await evalJs(send, '!document.getElementById("skin-row").hidden');
checks.skins = await evalJs(send, 'document.getElementById("f-skin").options.length');
checks.views = await evalJs(send, 'document.getElementById("f-view").options.length');

console.log('CHECKS:');
for (const [k, v] of Object.entries(checks)) console.log('  ' + k + ' = ' + JSON.stringify(v));
console.log('ERRORS (' + errors.length + '):');
for (const e of errors.slice(0, 20)) console.log('  ' + e);
console.log('LOGS tail:');
for (const l of logs.slice(-8)) console.log('  ' + l);

await chrome.close();
try { cdp.close(); } catch {}
try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
const fail = errors.length > 0;
process.exit(fail ? 1 : 0);