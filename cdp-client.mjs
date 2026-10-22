// 零依赖 CDP（Chrome DevTools Protocol）客户端：仅用 node:net/node:crypto。
// 适用于 WebSocket/fetch 全局被剥离的 Agent JS 沙箱（手写 WebSocket 帧协议）。
//
// 安全模型（R1 审计后确立）：
//   1. 目标选择是严格的：url 不匹配 / 多目标歧义 → 抛错停止，绝不回退到其他页面。
//      url 匹配规则 = origin 相同 + pathname 相同 + pattern 里给出的每个 query 参数值相同。
//   2. /json/list 属于不可信输入：其中 wsUrl 的主机必须是环回地址，否则拒绝（EHOST）。
//   3. 所有发送的 JS 表达式必须由 Agent 自己构造，页面内容只能作为数据读取。
//
// 用法（把 <repo> 换成仓库实际路径）：
//   const { connectCDP, listTargets } = await import(pathToFileURL("<repo>/cdp-client.mjs").href);
//   const cdp = await connectCDP({
//     port: 9222,
//     url: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=12345", // 严格身份
//   });
//   await cdp.send("Page.enable");
//   const r = await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
import net from "node:net";
import crypto from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 15000;   // 单个 CDP 命令的默认超时
const MAX_EVENT_QUEUE = 500;        // 事件队列上限（防事件洪峰占内存）
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024; // 单条消息上限（防恶意服务撑爆内存）

function assertLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return h;
  throw new Error(`EHOST: CDP 端点必须是环回地址（localhost/127.0.0.1），收到 ${hostname}。` +
    `调试端口只应监听本机；如确需连接远程主机请人工评估后修改 LOOPBACK_HOSTS。`);
}

// ---------- HTTP（/json/*） ----------

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    assertLoopbackHost(u.hostname);
    const req = net.connect(+u.port, u.hostname, () => {
      req.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nConnection: close\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), headerDone = false, need = -1, settled = false;
    const finish = (val) => { if (settled) return; settled = true; try { req.destroy(); } catch {} resolve(val); };
    const fail = (e) => { if (settled) return; settled = true; try { req.destroy(); } catch {} reject(e); };
    req.setTimeout(8000, () => fail(new Error("ETIMEOUT-HTTP: /json 请求超时")));
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
    req.on("error", (e) => fail(e));
    // 无响应头即关闭（干净 FIN、无 error）：必须拒绝，否则 Promise 永久 pending
    req.on("close", () => {
      if (headerDone) return finish(buf.slice(buf.indexOf("\r\n\r\n") + 4).toString());
      fail(new Error("ECLOSED-HTTP: 连接在响应头到达前关闭"));
    });
  });
}

export async function listTargets(port = 9222) {
  const body = await httpGetRaw(`http://127.0.0.1:${port}/json/list`);
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) throw new Error("EBADTARGETS: /json/list 返回非数组");
  return arr;
}

// ---------- 目标身份：严格选择（R1 核心） ----------

function parseUrlStrict(url) {
  try { return new URL(url); }
  catch { throw new Error(`EINVALIDURL: 无法解析目标 url "${url}"；必须给完整 URL（含 origin），` +
    `例如 https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=123`); }
}

/** pattern 的 origin+pathname 与 target 相同，且 pattern 指明的每个 query 参数值相等 */
export function urlMatches(targetUrl, patternUrl) {
  const t = parseUrlStrict(targetUrl), p = parseUrlStrict(patternUrl);
  if (t.origin !== p.origin) return false;
  if (t.pathname !== p.pathname) return false;
  for (const [k, v] of p.searchParams) {
    if (t.searchParams.get(k) !== v) return false;
  }
  return true;
}

/**
 * 从 /json/list 结果中唯一确定目标。任何不唯一/不匹配都抛错，绝不静默回退。
 * @param {Array} targets  /json/list 原始数组（不可信输入）
 * @param {{url?: string, type?: string}} opts
 */
export function selectTarget(targets, { url, type = "page" } = {}) {
  const pool = targets.filter(t => t && t.type === type && typeof t.webSocketDebuggerUrl === "string");
  const list = () => pool.map(t => `  - ${t.url}  ws=${t.webSocketDebuggerUrl}`).join("\n");
  if (!pool.length) throw new Error(`ENOTARGET: 没有 type=${type} 且带 webSocketDebuggerUrl 的目标`);
  if (!url) {
    if (pool.length === 1) return pool[0];
    throw new Error(`EMULTIPLE: 存在 ${pool.length} 个 ${type} 目标，必须用 url 指明操作对象：\n${list()}`);
  }
  parseUrlStrict(url); // 尽早校验格式
  const matches = pool.filter(t => urlMatches(t.url, url));
  if (!matches.length) throw new Error(`ENOTARGET: 没有 ${type} 目标匹配 ${url}。当前目标：\n${list()}`);
  if (matches.length > 1) throw new Error(`EMULTIPLE: ${matches.length} 个目标同时匹配 ${url}（歧义即停止）：\n${list()}`);
  assertLoopbackHost(new URL(matches[0].webSocketDebuggerUrl).hostname); // 连接前校验，EHOST
  return matches[0];
}

// ---------- WebSocket（手写帧协议） ----------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    try { assertLoopbackHost(u.hostname); } catch (e) { return reject(e); }
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.hostname}:${u.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.setTimeout(10000, () => failInit(new Error("ETIMEOUT-WS: WebSocket 握手超时")));
    let buf = Buffer.alloc(0), handshaken = false, closed = false;
    let fragments = null;                  // 分片重组缓冲 {chunks, bytes}
    const handlers = { message: [], close: [] };
    const earlyMessages = [];              // 订阅前到达的消息（握手同包竞态），首次订阅时补投
    const failInit = (e) => { if (!handshaken) { try { sock.destroy(); } catch {} reject(e); } };
    const failConn = (e) => {              // 握手后的致命错误：通知 close 监听者（会拒绝所有 pending）
      if (!handshaken) return failInit(e);
      try { sock.destroy(); } catch {}
      closed = true;
      const err = e instanceof Error ? e : new Error("ECLOSED: CDP 连接已断开");
      handlers.close.forEach((f) => { try { f(err); } catch {} });
    };
    sock.on("error", (e) => failConn(new Error(`ECONN: ${e.message}`)));
    // 握手完成前连接被关闭（干净 FIN）：必须拒绝，否则 Promise 永久 pending
    sock.on("close", () => {
      if (!handshaken) return failInit(new Error("ECLOSED: 握手完成前连接被关闭"));
      if (!closed) { closed = true; handlers.close.forEach((f) => { try { f(); } catch {} }); }
    });
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > MAX_MESSAGE_BYTES) return failConn(new Error("EWS: 缓冲区超过消息上限"));
      if (!handshaken) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = buf.slice(0, i).toString();
        if (!/ 101 /.test(head.split("\r\n")[0])) return failInit(new Error("EHANDSHAKE: 握手失败 " + head.split("\r\n")[0]));
        // 校验 Sec-WebSocket-Accept（防中间人/伪服务）
        const expected = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        const got = /sec-websocket-accept:\s*(.+)/i.exec(head);
        if (!got || got[1].trim() !== expected) return failInit(new Error("EHANDSHAKE: Sec-WebSocket-Accept 不匹配"));
        buf = buf.slice(i + 4); handshaken = true;
        sock.setTimeout(0); // 握手完成，交由上层 send 超时管理
        resolve({
          send: (obj) => sendFrame(JSON.stringify(obj)),
          // 订阅晚于事件（同一批数据里既有握手又有后续帧的竞态）：close 立即补发，message 先缓存再补投
          on: (ev, fn) => {
            if (ev === "close") {
              if (closed) queueMicrotask(() => { try { fn(); } catch {} });
              else handlers.close.push(fn);
              return;
            }
            if (ev === "message") {
              handlers.message.push(fn);
              if (earlyMessages.length) {
                const backlog = earlyMessages.splice(0);
                queueMicrotask(() => backlog.forEach((t) => { try { fn(t); } catch {} }));
              }
            }
          },
          close: () => { closed = true; try { sock.end(); } catch {} },
        });
      }
      pump();
    });
    function pump() {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = !!(b0 & 0x80), opcode = b0 & 0x0f;
        if (b0 & 0x70) return failConn(new Error("EWS: RSV 位被置位，非法帧"));   // rsv1-3
        let len = b1 & 0x7f, off = 2, masked = b1 & 0x80;
        if (masked) return failConn(new Error("EWS: 服务端帧不允许带掩码（RFC 6455）"));
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (len > MAX_MESSAGE_BYTES) return failConn(new Error("EWS: 帧长度超过上限"));
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        const maskKey = masked ? buf.slice(off, off + 4) : null; off += masked ? 4 : 0;
        const payload = Buffer.from(buf.slice(off, off + len)); buf = buf.slice(off + len);
        if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

        if (opcode === 0) {                                    // continuation
          if (!fragments) return failConn(new Error("EWS: 意外的 continuation 帧"));
          fragments.chunks.push(payload); fragments.bytes += payload.length;
          if (fragments.bytes > MAX_MESSAGE_BYTES) return failConn(new Error("EWS: 分片消息超过上限"));
          if (fin) { const full = Buffer.concat(fragments.chunks); fragments = null; deliver(full); }
          continue;
        }
        if (opcode === 1 || opcode === 2) {                    // 文本/二进制
          if (fragments) return failConn(new Error("EWS: 数据帧打断未完成的分片消息"));
          if (!fin) { fragments = { chunks: [payload], bytes: payload.length }; continue; }
          deliver(payload);
          continue;
        }
        if (opcode === 9) { sendFrameRaw(0x8a, payload); continue; }   // ping -> pong
        if (opcode === 0xa) continue;                                  // 未请求的 pong：忽略（RFC 6455）
        if (opcode === 8) {                                    // close
          closed = true; try { sock.end(); } catch {}
          handlers.close.forEach((f) => { try { f(); } catch {} });
          return;
        }
        return failConn(new Error(`EWS: 未处理的 opcode ${opcode}`));   // 0x3-0x7 / 0xB-0xF
      }
    }
    function deliver(payload) {
      const txt = payload.toString();
      if (!handlers.message.length) {  // 尚无订阅者：缓存待补投（上限防洪）
        earlyMessages.push(txt);
        if (earlyMessages.length > MAX_EVENT_QUEUE) earlyMessages.shift();
        return;
      }
      handlers.message.forEach((f) => { try { f(txt); } catch {} });
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

// ---------- 连接封装 ----------

/**
 * 严格模式连接 CDP。
 * @param {{port?: number, url?: string, type?: string, timeoutMs?: number}} opts
 *        url=目标页面完整 URL（含区分参数如 workId）；timeoutMs=单命令超时（默认 15s）
 */
export async function connectCDP(opts = {}) {
  const port = opts.port ?? 9222;
  const targets = await listTargets(port);
  const target = selectTarget(targets, { url: opts.url, type: opts.type });
  return openConnection(target, opts);
}

/** 直接用 wsUrl 建连（用于 iframe 等 /json/list 里列出的非 page 目标）；同样校验环回主机 */
export async function connectWsUrl(wsUrl, opts = {}) {
  const u = new URL(wsUrl);
  assertLoopbackHost(u.hostname);
  return openConnection({ webSocketDebuggerUrl: wsUrl, url: wsUrl }, opts);
}

async function openConnection(target, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ws = await wsConnect(target.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map(); const events = [];
  let closed = false;
  const failAll = (err) => {
    closed = true;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  };
  ws.on("message", (txt) => {
    let m;
    try { m = JSON.parse(txt); } catch { return; } // 非 JSON 消息丢弃（无法对应请求）
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(`ECDP: ${m.error.message}`)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
      if (events.length > MAX_EVENT_QUEUE) events.splice(0, events.length - MAX_EVENT_QUEUE);
    }
  });
  ws.on("close", (err) => failAll(err instanceof Error ? err : new Error("ECLOSED: CDP 连接已断开")));
  return {
    target,
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error("ECLOSED: 连接已关闭，禁止再发送"));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ETIMEOUT: ${method} 在 ${timeoutMs}ms 内未收到响应`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try { ws.send({ id, method, params }); }
        catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    },
    /**
     * Runtime.evaluate 封装：页面抛出的异常透出为 EPAGEERR，正常时直接返回 value。
     * 默认 returnByValue + awaitPromise（promise 表达式会等到解析值，非 promise 不受影响）。
     */
    async evaluate(expression, evalOpts = {}) {
      const r = await this.send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true, ...evalOpts,
      });
      if (r && r.exceptionDetails) {
        const desc = r.exceptionDetails.exception?.description
          ?? r.exceptionDetails.text ?? "unknown page error";
        throw new Error(`EPAGEERR: ${desc}`);
      }
      return r && r.result ? r.result.value : undefined;
    },
    drain: () => events.splice(0),
    close: () => {
      if (!closed) { closed = true; }
      ws.close();
      failAll(new Error("ECLOSED: 连接已关闭"));
    },
  };
}
