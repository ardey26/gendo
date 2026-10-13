// app/test/cdp.mjs: open a URL in headless Chrome, wait for [data-ready] or [data-error], print the page text.
// Usage: node cdp.mjs <url> [timeoutMs]   (CHROME env var overrides the binary path)
import { spawn } from "node:child_process";
const [url, timeout = "120000"] = process.argv.slice(2);
const bin = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(bin, ["--headless=new", "--disable-gpu", "--remote-debugging-port=9334", `--user-data-dir=/tmp/gendo-cdp-${process.pid}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.navigate", { url });
  const end = Date.now() + Number(timeout);
  let text = "";
  while (Date.now() < end) {
    const r = await send("Runtime.evaluate", { expression: "document.querySelector('[data-ready],[data-error]') ? document.body.innerText : ''", returnByValue: true });
    text = r?.result?.value ?? "";
    if (text) break;
    await sleep(500);
  }
  console.log(text || "TIMEOUT");
  process.exitCode = text ? 0 : 1;
} finally {
  ws?.close();
  chrome.kill();
}
