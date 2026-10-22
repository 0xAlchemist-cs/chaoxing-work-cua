#!/usr/bin/env node
/**
 * chaoxing-work-cua 安装器（零依赖）
 * 把 SKILL.md + cdp-client.mjs 安装到 Agent 的技能目录。
 *
 * 安全机制：
 *   - 必需文件（SKILL.md / cdp-client.mjs / bin/install.js 自身存在性）缺失 → 立即失败，
 *     且失败发生在写入任何文件之前（先全量校验，后写入）。
 *   - 覆盖已存在的 SKILL.md 前一律备份为 SKILL.md.bak-<时间戳>。
 *   - 若目标 SKILL.md 不是本 skill（无 name: chaoxing-work-cua 标识）→ 视为外来文件，
 *     默认跳过覆盖并提示；--force 才覆盖（覆盖前同样备份）。
 *
 * 用法：
 *   npx chaoxing-work-cua                 # 自动检测已存在的技能目录并安装
 *   npx chaoxing-work-cua --target <dir>  # 安装到指定目录
 *   npx chaoxing-work-cua --force         # 允许覆盖外来 SKILL.md
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL_NAME = "chaoxing-work-cua";
const SKILL_MARKER = `name: ${SKILL_NAME}`; // frontmatter 标识，用于识别"是否我们装的"
const REQUIRED_FILES = ["SKILL.md", "cdp-client.mjs"]; // 必需文件，缺一即失败

const args = process.argv.slice(2);

let customTarget = null;
const tIdx = args.indexOf("--target");
if (tIdx > -1 && args[tIdx + 1]) customTarget = path.resolve(args[tIdx + 1]);
const force = args.includes("--force");

// 候选技能目录（存在哪个装哪个；都没有则装到默认目录）
const candidates = [".agents/skills", ".zcode/skills", ".claude/skills"];
let targets = candidates
  .map((c) => path.join(os.homedir(), c))
  .filter((p) => fs.existsSync(p));

if (customTarget) {
  targets = [customTarget];
} else if (targets.length === 0) {
  targets = [path.join(os.homedir(), ".agents", "skills")];
}

// ---- 第 1 步：全量校验（任何失败都发生在写入之前）----
const pkgRoot = path.join(__dirname, "..");
const srcFiles = REQUIRED_FILES.map((f) => ({ name: f, path: path.join(pkgRoot, f) }));
const missing = srcFiles.filter((s) => !fs.existsSync(s.path)).map((s) => s.name);
if (missing.length) {
  console.error(`✗ 安装包损坏：缺少必需文件 ${missing.join("、")}。请重新 npx 或 npm i -g 后重试。`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = (filePath) => {
  const bak = `${filePath}.bak-${timestamp}`;
  fs.copyFileSync(filePath, bak);
  return bak;
};

const isOurs = (filePath) => {
  try {
    const head = fs.readFileSync(filePath, "utf8").slice(0, 500);
    return head.includes(SKILL_MARKER);
  } catch {
    return false;
  }
};

// ---- 第 2 步：逐目录安装（先备份决策，后写入）----
console.log(`安装 ${SKILL_NAME} skill ...`);
let hadError = false;
for (const t of targets) {
  const dir = path.join(t, SKILL_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });

    const destSkill = path.join(dir, "SKILL.md");
    if (fs.existsSync(destSkill)) {
      if (!isOurs(destSkill) && !force) {
        console.warn(`  ! 跳过 ${destSkill}：已存在非本 skill 的文件（外来文件保护）。确认要覆盖请加 --force。`);
        continue; // 外来文件不动，但其余文件（cdp-client.mjs）仍安装
      }
      const bak = backup(destSkill);
      console.log(`  ⧗ 已备份原文件 → ${path.basename(bak)}`);
      fs.copyFileSync(srcFiles[0].path, destSkill);
    } else {
      fs.copyFileSync(srcFiles[0].path, destSkill);
    }

    for (const s of srcFiles.slice(1)) {
      fs.copyFileSync(s.path, path.join(dir, s.name));
    }
    console.log(`  ✓ ${dir}`);
  } catch (e) {
    console.error(`  ✗ ${dir} : ${e.message}`);
    hadError = true;
  }
}
if (hadError) process.exitCode = 1;

console.log("");
console.log("完成！重启你的 Agent 后，skill 即被识别。");
console.log("免责声明：仅供学习 Computer Use 自动化技术，请遵守所在学校/平台规定，勿用于违反学术诚信的行为。");
