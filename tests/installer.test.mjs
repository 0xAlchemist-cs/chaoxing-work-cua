// R2：npm 安装链路 —— 全新安装 / 重复安装 / 升级 / 外来文件保护 / 缺文件失败 / npm pack 清单
// 全程使用临时目录，不触碰真实技能目录，不访问网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = join(import.meta.dirname, "..");
const installer = join(repoRoot, "bin", "install.js");

function runInstaller(pkgRoot, targetDir, extraArgs = []) {
  const r = spawnSync(process.execPath, [join(pkgRoot, "bin", "install.js"), "--target", targetDir, ...extraArgs],
    { encoding: "utf8" });
  if (r.status !== 0) {
    const e = new Error(`installer exited ${r.status}\n${r.stderr || r.stdout}`);
    e.stderr = r.stderr || "";
    throw e;
  }
  return r.stdout + "\n" + r.stderr; // 合并输出，提示可能在 stderr
}

/** 构造一个"完整包"目录（模拟 npm 包内容） */
function makePkgDir() {
  const dir = mkdtempSync(join(tmpdir(), "cx-pkg-"));
  mkdirSync(join(dir, "bin"));
  for (const f of ["SKILL.md", "README.md", "LICENSE", "package.json", "cdp-client.mjs"]) {
    copyFileSync(join(repoRoot, f), join(dir, f));
  }
  copyFileSync(installer, join(dir, "bin", "install.js"));
  return dir;
}

test("全新安装：SKILL.md 与 cdp-client.mjs 都必须落盘", () => {
  const pkg = makePkgDir();
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  const out = runInstaller(pkg, target);
  assert.match(out, /✓/);
  assert.ok(existsSync(join(target, "chaoxing-work-cua", "SKILL.md")), "SKILL.md 未安装");
  assert.ok(existsSync(join(target, "chaoxing-work-cua", "cdp-client.mjs")), "cdp-client.mjs 未安装");
});

test("重复安装（升级）：旧 SKILL.md 必须先备份再覆盖，备份内容可找回", () => {
  const pkg = makePkgDir();
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  runInstaller(pkg, target);
  // 用户改动过已安装的 SKILL.md（内容与包内不同）
  const installed = join(target, "chaoxing-work-cua", "SKILL.md");
  const modified = readFileSync(installed, "utf8") + "\n<!-- my-local-note -->\n";
  writeFileSync(installed, modified);
  runInstaller(pkg, target);
  const dir = join(target, "chaoxing-work-cua");
  const baks = readdirSync(dir).filter(f => /^SKILL\.md\.bak/.test(f));
  assert.ok(baks.length >= 1, "未生成备份文件");
  const bak = readFileSync(join(dir, baks[0]), "utf8");
  assert.ok(bak.includes("my-local-note"), "备份里没有用户改动");
  assert.ok(!readFileSync(installed, "utf8").includes("my-local-note"), "覆盖后不应残留旧内容");
});

test("外来文件保护：目标 SKILL.md 不是本 skill（无 name 标识）时不得覆盖，除非 --force", () => {
  const pkg = makePkgDir();
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  const dir = join(target, "chaoxing-work-cua");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: someone-else-skill\n---\n重要内容，不可覆盖");
  const out = runInstaller(pkg, target);
  assert.match(out, /跳过|skip/i);
  assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /不可覆盖/);
  // --force 才允许覆盖（覆盖前同样备份）
  runInstaller(pkg, target, ["--force"]);
  assert.ok(!readFileSync(join(dir, "SKILL.md"), "utf8").includes("不可覆盖"), "--force 未覆盖");
  const baks = readdirSync(dir).filter(f => /^SKILL\.md\.bak/.test(f));
  assert.ok(baks.length >= 1, "强制覆盖前未备份");
  assert.match(readFileSync(join(dir, baks[0]), "utf8"), /不可覆盖/);
});

test("缺必需文件（cdp-client.mjs 不在包里）：安装必须失败退出且不写任何文件", () => {
  const pkg = makePkgDir();
  rmSync(join(pkg, "cdp-client.mjs"));
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  let failed = false, stderr = "";
  try { runInstaller(pkg, target); } catch (e) { failed = true; stderr = e.stderr || e.message; }
  assert.ok(failed, "缺文件时安装未失败");
  assert.match(stderr, /cdp-client\.mjs/, "错误信息未指明缺失文件");
  assert.ok(!existsSync(join(target, "chaoxing-work-cua", "SKILL.md")), "失败时不应写入部分文件");
});

test("中途失败不留半成品：目标目录在失败后不存在 skill 子目录", () => {
  const pkg = makePkgDir();
  rmSync(join(pkg, "SKILL.md"));
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  let failed = false;
  try { runInstaller(pkg, target); } catch { failed = true; }
  assert.ok(failed);
  assert.ok(!existsSync(join(target, "chaoxing-work-cua")), "失败后残留了不完整目录");
});

test("npm pack 清单：发布包必须包含 cdp-client.mjs / SKILL.md / bin/install.js / README / LICENSE", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" });
  const files = JSON.parse(out.slice(out.indexOf("[")))[0].files.map(f => f.path);
  const want = ["package.json", "SKILL.md", "cdp-client.mjs", "README.md", "LICENSE", join("bin", "install.js")];
  for (const must of want) {
    assert.ok(files.some(f => f.replaceAll("\\", "/") === must.replaceAll("\\", "/")),
      `npm 包缺少 ${must}，实际：${files.join(", ")}`);
  }
  assert.ok(!files.some(f => f.replaceAll("\\", "/").startsWith("tests/")), "tests/ 不应入包");
});
