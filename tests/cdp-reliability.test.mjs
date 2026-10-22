// R3：CDP 通信可靠性 —— 全部经本地模拟服务注入故障（127.0.0.1，无外网）
// 暴露的缺陷：send 无超时（服务不回包即永久挂起）；断线/异常后 pending 不清理；
// 无消息大小/事件队列上限；Runtime.evaluate 的 exceptionDetails 被吞。
import { test, after as afterHook } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const { connectCDP, connectWsUrl } = await import(pathToFileURL(join(repoRoot, "cdp-client.mjs")).href);
const { MockCdpServer } = await import(pathToFileURL(join(repoRoot, "tests/helpers/mock-cdp.mjs")).href);

const PAGE = {
  type: "page", id: "1", title: "作业作答",
  url: "https://mooc1.chaoxing.com/work/dowork?workId=1",
};
const openServers = [];
async function serverFor(opts = {}) {
  const server = new MockCdpServer(opts);
  const port = await server.listen();
  server.targets = [{ ...PAGE, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }];
  openServers.push(server);
  return { port, server };
}
const connect = (port) => connectCDP({ port, url: PAGE.url, timeoutMs: 400 });
afterHook(async () => { for (const s of openServers) await s.close(); });

test("send 超时：服务端不回包时必须在 timeoutMs 内拒绝（ETIMEOUT），不得永久挂起", async () => {
  const { port, server } = await serverFor();
  server.onCommand = () => new Promise(() => {}); // 注入：永不响应
  const cdp = await connect(port);
  const t0 = Date.now();
  await assert.rejects(cdp.send("Runtime.evaluate", { expression: "1" }), /ETIMEOUT/);
  assert.ok(Date.now() - t0 < 5000, "超时过晚");
  await cdp.close();
});

test("断线清理：服务端中途断开连接时，所有 pending 请求必须拒绝（ECLOSED）", async () => {
  const { port, server } = await serverFor();
  server.onCommand = (m, conn) => { conn.destroy(); return new Promise(() => {}); }; // 收到命令即断线
  const cdp = await connect(port);
  await assert.rejects(cdp.send("Page.enable"), /ECLOSED/);
});

test("异常断线：服务端销毁 socket（RST）时 pending 必须拒绝，不得挂起", async () => {
  const { port, server } = await serverFor();
  server.onCommand = (m, conn) => { conn.socket.destroy(); return new Promise(() => {}); };
  const cdp = await connect(port);
  await assert.rejects(cdp.send("Page.enable"), /ECLOSED|ECONN|socket/i);
});

test("握手校验：Sec-WebSocket-Accept 错误的服务必须被拒绝（EHANDSHAKE）", async () => {
  const { port } = await serverFor({ badAccept: true });
  await assert.rejects(connect(port), /EHANDSHAKE/);
});

test("握手拒绝：非 101 响应必须报 EHANDSHAKE", async () => {
  const { port } = await serverFor({ rejectUpgrade: true });
  await assert.rejects(connect(port), /EHANDSHAKE/);
});

test("非法帧：保留 opcode / RSV 位必须导致连接失败（EWS），后续请求不得静默挂起", async () => {
  const { port, server } = await serverFor();
  server.onConnection = (conn) => {
    conn.sendBytes(Buffer.from([0x83, 0x01, 0x00])); // opcode 0x3 保留位
  };
  const cdp = await connect(port);
  await assert.rejects(cdp.send("Page.enable"), /EWS|ECLOSED/i);
});

test("evaluate 异常透出：Runtime.evaluate 返回 exceptionDetails 时必须抛 EPAGEERR 并含异常文本", async () => {
  const { port, server } = await serverFor();
  server.onCommand = () => ({ result: { type: "object" }, exceptionDetails: {
    exception: { description: "ReferenceError: x is not defined\n    at eval" },
  } });
  const cdp = await connect(port);
  await assert.rejects(cdp.evaluate("x"), (e) => /EPAGEERR/.test(e.message) && /ReferenceError/.test(e.message));
  await cdp.close();
});

test("evaluate 帮助方法：正常返回值直接给出 value", async () => {
  const { port, server } = await serverFor();
  server.onCommand = () => ({ result: { type: "number", value: 42 } });
  const cdp = await connect(port);
  assert.equal(await cdp.evaluate("6*7"), 42);
  await cdp.close();
});

test("大消息分片：服务器分片发送的 64 位长度大消息必须完整重组", async () => {
  const { port, server } = await serverFor();
  const big = "A".repeat(300000); // >64KB，走 8 字节长度；分两片发
  server.onConnection = (conn) => {
    conn.pendingBig = big;
  };
  server.onCommand = (m, conn) => {
    if (m.method === "Runtime.evaluate") {
      const buf = Buffer.from(JSON.stringify({ id: m.id, result: { result: { value: conn.pendingBig } } }));
      const half = Math.floor(buf.length / 2);
      conn.sendTextFrame(buf.slice(0, half), { fin: false, opcode: 0x1 });
      conn.sendTextFrame(buf.slice(half), { fin: true, opcode: 0x0 });
      return new Promise(() => {}); // 已手动回包
    }
    return {};
  };
  const cdp = await connect(port);
  const v = await cdp.evaluate("big");
  assert.equal(v.length, 300000);
  await cdp.close();
});

test("事件队列上限：事件洪峰不得无限占用内存（洪峰在订阅后触发，精确断言上限）", async () => {
  const { port, server } = await serverFor();
  server.onCommand = (m, conn) => {
    if (m.method === "Page.enable") {
      for (let i = 0; i < 1200; i++) conn.sendObj({ method: "Console.messageAdded", params: { i } });
      return {}; // 洪峰之后回包
    }
    return {};
  };
  const cdp = await connect(port);
  await cdp.send("Page.enable"); // 订阅已就绪，洪峰必然进入队列路径
  const events = cdp.drain();
  assert.equal(events.length, 500, `事件队列应精确截断在 500，实际 ${events.length}`);
  await cdp.close();
});

test("connectWsUrl：可连接 listTargets 里的 iframe 目标（OOPIF 场景）", async () => {
  const { port, server } = await serverFor();
  server.onCommand = () => ({ result: { value: "frame-doc" } });
  const cdp = await connectWsUrl(`ws://127.0.0.1:${port}/devtools/page/1`);
  assert.equal(await cdp.evaluate("document.title"), "frame-doc");
  await cdp.close();
});

test("close 后 send：必须立即拒绝而非挂起或写入死连接", async () => {
  const { port } = await serverFor();
  const cdp = await connect(port);
  await cdp.close();
  await assert.rejects(cdp.send("Page.enable"), /ECLOSED|closed/i);
});

test("协议违规：新数据帧打断未完成分片必须中止连接（EWS），不得静默截断消息", async () => {
  const { port, server } = await serverFor();
  server.onConnection = (conn) => {
    conn.sendTextFrame(Buffer.from('{"method":"x","par'), { fin: false, opcode: 0x1 });
    conn.sendTextFrame(Buffer.from('"partial"'), { fin: true, opcode: 0x0 }); // 正常完成
    conn.sendTextFrame(Buffer.from('{"method":"y","par'), { fin: false, opcode: 0x1 });
    conn.sendTextFrame(Buffer.from('{"method":"z"'), { fin: true, opcode: 0x1 }); // 新数据帧打断 → 违规
  };
  const cdp = await connect(port);
  await assert.rejects(cdp.send("Page.enable"), /EWS|ECLOSED/i);
});

test("握手同包消息不丢失：与服务端 101 同批到达的事件必须在连接后可见", async () => {
  const { port, server } = await serverFor();
  server.onConnection = (conn) => {
    conn.sendObj({ method: "Target.attachedToTarget", params: { hello: 1 } });
  };
  const cdp = await connect(port);
  const events = cdp.drain();
  assert.equal(events.length, 1, "握手同包事件被丢弃");
  assert.equal(events[0].method, "Target.attachedToTarget");
  await cdp.close();
});

test("并发连接互不串扰：两个连接各自拿到自己页面的应答（回包必须发给请求方）", async () => {
  const { port, server } = await serverFor();
  server.onCommand = (m, conn) => ({ result: { value: conn.pageId } });
  const [a, b] = await Promise.all([
    connectWsUrl(`ws://127.0.0.1:${port}/devtools/page/AAA`),
    connectWsUrl(`ws://127.0.0.1:${port}/devtools/page/BBB`),
  ]);
  const [va, vb] = await Promise.all([a.evaluate("1"), b.evaluate("2")]);
  assert.equal(va, "AAA", "连接 A 收到了别的连接的应答（串扰）");
  assert.equal(vb, "BBB", "连接 B 收到了别的连接的应答（串扰）");
  await Promise.all([a.close(), b.close()]);
});

// ---------- R5：连接建立阶段的断连不得永久等待 ----------

test("HTTP 阶段断连：服务接受 TCP 后立即关闭（无响应头），连接必须报错而非挂起", { timeout: 4000 }, async () => {
  const { port } = await serverFor({ dropHttp: true });
  await assert.rejects(
    connectCDP({ port, url: PAGE.url }),
    /ECLOSED|ETIMEDOUT|ECONN/i,
  );
});

test("WS 握手阶段断连：服务端在 101 前关闭连接，connectWsUrl 必须报错而非挂起", { timeout: 4000 }, async () => {
  const { port } = await serverFor({ dropUpgrade: true });
  await assert.rejects(
    connectWsUrl(`ws://127.0.0.1:${port}/devtools/page/1`),
    /ECLOSED|EHANDSHAKE|ECONN/i,
  );
});
