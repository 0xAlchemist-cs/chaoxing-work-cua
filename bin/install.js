#!/usr/bin/env node
/**
 * chaoxing-work-cua 安装器
 * 把 SKILL.md 安装到 Agent 的技能目录（零依赖）。
 *
 * 用法：
 *   npx chaoxing-work-cua                 # 自动检测已存在的技能目录并安装
 *   npx chaoxing-work-cua --target <dir>  # 安装到指定目录
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL_NAME = "chaoxing-work-cua";
const args = process.argv.slice(2);

// --target <dir>
let customTarget = null;
const tIdx = args.indexOf("--target");
if (tIdx > -1 && args[tIdx + 1]) customTarget = path.resolve(args[tIdx + 1]);

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

// 源文件：包根目录下的 SKILL.md
const src = path.join(__dirname, "..", "SKILL.md");
if (!fs.existsSync(src)) {
  console.error("✗ 安装包损坏：找不到 SKILL.md，请重新 npx 或 npm i -g。");
  process.exit(1);
}

console.log(`安装 ${SKILL_NAME} skill ...`);
for (const t of targets) {
  const dir = path.join(t, SKILL_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, "SKILL.md"));
    console.log(`  ✓ ${dir}`);
  } catch (e) {
    console.error(`  ✗ ${dir} : ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("");
console.log("完成！重启你的 Agent 后，skill 即被识别。");
console.log("免责声明：仅供学习 Computer Use 自动化技术，请遵守所在学校/平台规定，勿用于违反学术诚信的行为。");
