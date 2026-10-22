// R1：目标身份与操作权限 —— 身份选择部分
// 暴露的缺陷：connectCDP 在 preferUrl 不匹配时静默回退到任意页面（对错页面操作）；
// 子串匹配可被同前缀 URL 欺骗；未校验 wsUrl 主机。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const { selectTarget, connectCDP } = await import(pathToFileURL(join(repoRoot, "cdp-client.mjs")).href);
const { MockCdpServer } = await import(pathToFileURL(join(repoRoot, "tests/helpers/mock-cdp.mjs")).href);

const PAGE = (id, workId) => ({
  type: "page",
  title: "作业作答",                       // 同名标签：标题完全相同
  id: String(id),
  url: `https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=1&workId=${workId}`,
  webSocketDebuggerUrl: `ws://127.0.0.1:1/devtools/page/${id}`,
});

test("selectTarget: url 不匹配任何目标必须抛 ENOTARGET，禁止回退到其他页面", () => {
  const targets = [PAGE(1, "111"), PAGE(2, "222")];
  assert.throws(
    () => selectTarget(targets, { url: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=333" }),
    /ENOTARGET/,
  );
});

test("selectTarget: 同名标签按 workId 精确区分（错误账号防护）", () => {
  const targets = [PAGE(1, "111"), PAGE(2, "222")];
  const t = selectTarget(targets, { url: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=222" });
  assert.equal(t.id, "2");
});

test("selectTarget: 多个目标同时匹配必须抛 EMULTIPLE（歧义即停止）", () => {
  const targets = [PAGE(1, "111"), PAGE(1, "111")]; // 同 URL 双开
  assert.throws(
    () => selectTarget(targets, { url: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=111" }),
    /EMULTIPLE/,
  );
});

test("selectTarget: 未提供 url 且存在多个页面目标必须抛 EMULTIPLE，不得默认取第一个", () => {
  const targets = [PAGE(1, "111"), PAGE(2, "222")];
  assert.throws(() => selectTarget(targets, {}), /EMULTIPLE/);
});

test("selectTarget: 子串匹配不算命中 —— 必须按 origin+path+指定 query 参数精确匹配", () => {
  const targets = [{
    type: "page", id: "9", title: "学生学习页面",
    url: "https://evil.example.com/mooc-ans/mooc2/work/dowork?workId=111", // 同 path，不同 origin
    webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/9",
  }];
  assert.throws(
    () => selectTarget(targets, { url: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=111" }),
    /ENOTARGET/,
  );
});

test("selectTarget: 目标列表里的 wsUrl 指向非环回主机必须拒绝（EHOST）", () => {
  const targets = [{
    type: "page", id: "1", title: "作业作答",
    url: "https://mooc1.chaoxing.com/work/dowork?workId=1",
    webSocketDebuggerUrl: "ws://192.168.1.5:9222/devtools/page/1", // /json/list 是不可信输入
  }];
  assert.throws(() => selectTarget(targets, { url: "https://mooc1.chaoxing.com/work/dowork?workId=1" }), /EHOST/);
});

test("selectTarget: 无任何可用目标抛 ENOTARGET", () => {
  assert.throws(() => selectTarget([], { url: "https://a.b/c" }), /ENOTARGET/);
});

// ---------- 集成：连到模拟服务，验证连接的就是选中的那个目标 ----------
const openServers = [];
test.after?.(async () => { for (const s of openServers) await s.close(); });

test("connectCDP: 严格匹配后连接成功，且 evaluate 在所选页面上下文执行", async () => {
  const { port, server } = await listenWithPages(PAGE(1, "111"), PAGE(2, "222"));
  server.onCommand = (m) => m.method === "Runtime.evaluate"
    ? { result: { value: m.params.expression === "1+1" ? 2 : null } }
    : {};
  const cdp = await connectCDP({
    port,
    url: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=222",
  });
  assert.equal(cdp.target.id, "2");
  const r = await cdp.send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
  assert.equal(r.result.value, 2);
  await cdp.close();
});

test("connectCDP: url 不匹配时整条连接失败（不得静默连到别的页面）", async () => {
  const { port } = await listenWithPages(PAGE(1, "111"));
  await assert.rejects(
    connectCDP({ port, url: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=999" }),
    /ENOTARGET/,
  );
});

async function listenWithPages(...pages) {
  const server = new MockCdpServer({ targets: [] });
  const port = await server.listen();
  // wsUrl 统一指向真实监听端口（服务只有一个，多个目标按 path 区分）
  server.targets = pages.map(p => ({
    ...p, webSocketDebuggerUrl: p.webSocketDebuggerUrl.replace(":1/", `:${port}/`),
  }));
  openServers.push(server);
  return { port, server };
}
