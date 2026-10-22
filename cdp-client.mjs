// 零依赖 CDP（Chrome DevTools Protocol）客户端：仅用 node:net/node:crypto。
// 适用于 WebSocket/fetch 全局被剥离的 Agent JS 沙箱（手写 WebSocket 帧协议）。
// 用法（把 <repo> 换成仓库实际路径）：
//   const { connectCDP, listTargets } = await import(pathToFileURL("<repo>/cdp-client.mjs").href);
//   const cdp = await connectCDP();          // 自动找 9222 端口第一个 page
//   await cdp.send("Page.navigate", { url });
//   const r = await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
import net from "node:net";
import crypto from "node:crypto";

const httpGet = (url) => new Promise((resolve, reject) => {
  httpGetRaw(url).then(resolve).catch(reject);
});
function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = net.connect(+u.port, u.hostname, () => {
      req.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nConnection: close\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), headerDone = false, need = -1;
    const finish = (val) => { try { req.destroy(); } catch {}; resolve(val); };
    req.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (!headerDone) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        headerDone = true;
        const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, i).toString());
        need = m ? +m[1] : -1;
        if (need === 0) return finish("");
      }
      if (need >= 0) {
        const body = buf.slice(buf.indexOf("\r\n\r\n") + 4);
        if (body.length >= need) finish(body.slice(0, need).toString());
      }
    });
    req.on("error", (e) => reject(e));
    req.on("close", () => { if (headerDone) finish(buf.slice(buf.indexOf("\r\n\r\n") + 4).toString()); });
  });
}

async function listTargets(port = 9222) {
  const body = await httpGet(`http://127.0.0.1:${port}/json/list`);
  return JSON.parse(body);
}

// 极简 WebSocket：掩码发送、处理文本帧/64位长度/ping/关闭；不分片重组（CDP 单帧足够）
function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.hostname}:${u.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), handshaken = false, closed = false;
    const handlers = { message: [], close: [] };
    sock.on("error", (e) => { if (!handshaken) reject(e); });
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (!handshaken) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = buf.slice(0, i).toString();
        if (!/ 101 /.test(head.split("\r\n")[0])) return reject(new Error("handshake failed: " + head.split("\r\n")[0]));
        buf = buf.slice(i + 4); handshaken = true;
        resolve({
          send: (obj) => sendFrame(JSON.stringify(obj)),
          on: (ev, fn) => handlers[ev].push(fn),
          close: () => { closed = true; try { sock.end(); } catch {} },
        });
      }
      pump();
    });
    sock.on("close", () => { if (handshaken && !closed) handlers.close.forEach((f) => f()); });
    function pump() {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f, off = 2, masked = b1 & 0x80;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        const maskKey = masked ? buf.slice(off, off + 4) : null; off += masked ? 4 : 0;
        let payload = Buffer.from(buf.slice(off, off + len)); buf = buf.slice(off + len);
        if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
        if (opcode === 1 || opcode === 2) {
          const txt = payload.toString();
          handlers.message.forEach((f) => { try { f(txt); } catch {} });
        } else if (opcode === 9) sendFrameRaw(0x8a, payload);          // ping -> pong
        else if (opcode === 8) { closed = true; try { sock.end(); } catch {} handlers.close.forEach((f) => f()); }
      }
    }
    function sendFrame(str) { sendFrameRaw(0x81, Buffer.from(str)); }
    function sendFrameRaw(opcode, payload) {
      const mask = crypto.randomBytes(4);
      let head;
      if (payload.length < 126) head = Buffer.from([opcode, 0x80 | payload.length]);
      else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = opcode; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
      else { head = Buffer.alloc(10); head[0] = opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      sock.write(Buffer.concat([head, mask, masked]));
    }
  });
}

export async function connectCDP(port = 9222, preferUrl) {
  const targets = await listTargets(port);
  let page = targets.find((t) => t.type === "page" && (!preferUrl || t.url.includes(preferUrl)))
          || targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map(); const events = [];
  ws.on("message", (txt) => {
    const m = JSON.parse(txt);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    else if (m.method) events.push(m);
  });
  ws.on("close", () => { for (const [, p] of pending) p.reject(new Error("cdp closed")); pending.clear(); });
  return {
    target: page,
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send({ id, method, params });
      });
    },
    drain: () => events.splice(0),
    close: () => ws.close(),
  };
}
export { listTargets };
