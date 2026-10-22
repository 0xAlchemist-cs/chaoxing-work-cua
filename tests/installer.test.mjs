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
  return { status: r.status, out: (r.stdout || "") + "\n" + (r.stderr || "") };
}
function runInstallerOk(pkgRoot, targetDir, extraArgs = []) {
  const { status, out } = runInstaller(pkgRoot, targetDir, extraArgs);
  if (status !== 0) throw new Error(`installer exited ${status}\n${out}`);
  return out;
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
  const out = runInstallerOk(pkg, target);
  assert.match(out, /✓/);
  assert.ok(existsSync(join(target, "chaoxing-work-cua", "SKILL.md")), "SKILL.md 未安装");
  assert.ok(existsSync(join(target, "chaoxing-work-cua", "cdp-client.mjs")), "cdp-client.mjs 未安装");
});

test("重复安装（升级）：旧 SKILL.md 必须先备份再覆盖，备份内容可找回", () => {
  const pkg = makePkgDir();
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  runInstallerOk(pkg, target);
  // 用户改动过已安装的 SKILL.md（内容与包内不同）
  const installed = join(target, "chaoxing-work-cua", "SKILL.md");
  const modified = readFileSync(installed, "utf8") + "\n<!-- my-local-note -->\n";
  writeFileSync(installed, modified);
  runInstallerOk(pkg, target);
  const dir = join(target, "chaoxing-work-cua");
  const baks = readdirSync(dir).filter(f => /^SKILL\.md\.bak/.test(f));
  assert.ok(baks.length >= 1, "未生成备份文件");
  const bak = readFileSync(join(dir, baks[0]), "utf8");
  assert.ok(bak.includes("my-local-note"), "备份里没有用户改动");
  assert.ok(!readFileSync(installed, "utf8").includes("my-local-note"), "覆盖后不应残留旧内容");
});

test("外来文件保护：目标 SKILL.md 不是本 skill 时不得覆盖；库文件仍安装；唯一目标被跳过须失败退出", () => {
  const pkg = makePkgDir();
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  const dir = join(target, "chaoxing-work-cua");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: someone-else-skill\n---\n重要内容，不可覆盖");
  const r1 = runInstaller(pkg, target);
  assert.equal(r1.status, 1, "唯一目标被外来保护跳过时应失败退出，而非静默成功");
  assert.match(r1.out, /跳过/);
  assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /不可覆盖/, "外来文件被覆盖了");
  assert.ok(existsSync(join(dir, "cdp-client.mjs")), "跳过 SKILL.md 时库文件仍应安装");
  // --force 才允许覆盖（覆盖前同样备份）
  runInstallerOk(pkg, target, ["--force"]);
  assert.ok(!readFileSync(join(dir, "SKILL.md"), "utf8").includes("不可覆盖"), "force 未覆盖");
  const baks = readdirSync(dir).filter(f => /^SKILL\.md\.bak/.test(f));
  assert.ok(baks.length >= 1, "强制覆盖前未备份");
  assert.match(readFileSync(join(dir, baks[0]), "utf8"), /不可覆盖/);
});

test("标记伪造防护：name 为超串（-v2）或正文中嵌入标记，都不算本 skill", () => {
  const pkg = makePkgDir();
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  const dir = join(target, "chaoxing-work-cua");
  mkdirSync(dir, { recursive: true });
  const spoof1 = "---\nname: chaoxing-work-cua-v2\n---\n伪造内容A";
  writeFileSync(join(dir, "SKILL.md"), spoof1);
  assert.equal(runInstaller(pkg, target).status, 1, "超串 name 应被视为外来文件");
  assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /伪造内容A/);
  const spoof2 = "正文里提到 name: chaoxing-work-cua 但没有 frontmatter";
  writeFileSync(join(dir, "SKILL.md"), spoof2);
  assert.equal(runInstaller(pkg, target).status, 1, "无 frontmatter 的嵌入标记应被视为外来文件");
  assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /没有 frontmatter/);
});

test("缺必需文件（cdp-client.mjs 不在包里）：安装必须失败退出且不写任何文件", () => {
  const pkg = makePkgDir();
  rmSync(join(pkg, "cdp-client.mjs"));
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  const r = runInstaller(pkg, target);
  assert.notEqual(r.status, 0, "缺文件时安装未失败");
  assert.match(r.out, /cdp-client\.mjs/, "错误信息未指明缺失文件");
  assert.ok(!existsSync(join(target, "chaoxing-work-cua", "SKILL.md")), "失败时不应写入部分文件");
});

test("写入前失败（缺源文件）：失败发生在任何写入之前，不留半成品", () => {
  const pkg = makePkgDir();
  rmSync(join(pkg, "SKILL.md"));
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  const r = runInstaller(pkg, target);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(join(target, "chaoxing-work-cua")), "失败后残留了不完整目录");
});

test("写入中途失败必须整体回滚：不得留下新旧混合状态", () => {
  const pkg = makePkgDir();
  const target = mkdtempSync(join(tmpdir(), "cx-tgt-"));
  const dir = join(target, "chaoxing-work-cua");
  mkdirSync(dir, { recursive: true });
  // 注入：把第二个文件的落点占成目录 → 前一个文件写入成功、后一个写入必然失败
  mkdirSync(join(dir, "cdp-client.mjs"));
  const r = runInstaller(pkg, target);
  assert.notEqual(r.status, 0, "中途失败必须非零退出");
  assert.ok(!existsSync(join(dir, "SKILL.md")), "回滚后不应残留已写入的 SKILL.md（混合状态）");
  assert.ok(readdirSync(dir).every(f => f !== "SKILL.md"), "目录里不得有半成品文件");
  const staged = readdirSync(dir).filter(f => /\.staged-/.test(f));
  assert.equal(staged.length, 0, "暂存文件未清理");
  // 修复注入后重装应成功（目录占位被人工清除的场景）
  rmSync(join(dir, "cdp-client.mjs"), { recursive: true });
  const r2 = runInstaller(pkg, target);
  assert.equal(r2.status, 0, "排除故障后重装应成功");
  assert.ok(existsSync(join(dir, "SKILL.md")) && existsSync(join(dir, "cdp-client.mjs")));
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
