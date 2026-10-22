#!/usr/bin/env node
/**
 * chaoxing-work-cua 安装器（零依赖）
 * 把 SKILL.md + cdp-client.mjs 安装到 Agent 的技能目录。
 *
 * 安全机制：
 *   - 必需文件（SKILL.md / cdp-client.mjs）缺失 → 立即失败，且失败发生在写入任何
 *     文件之前（先全量校验，后写入）。
 *   - 覆盖已存在的任何文件前一律备份为 <原名>.bak-<时间戳>。
 *   - 若目标 SKILL.md 不是本 skill（frontmatter 的 name 不是 chaoxing-work-cua）
 *     → 视为外来文件，默认跳过覆盖并提示；--force 才覆盖（覆盖前同样备份）。
 *
 * 用法：不带参数自动检测技能目录；--target <目录> 指定安装位置；--force 允许覆盖外来文件。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL_NAME = "chaoxing-work-cua";
const REQUIRED_FILES = ["SKILL.md", "cdp-client.mjs"]; // 必需文件，缺一即失败

const args = process.argv.slice(2);

let customTarget = null;
const tIdx = args.indexOf("--target");
if (tIdx > -1) {
  const val = args[tIdx + 1];
  if (!val || val.startsWith("--")) {
    console.error("✗ --target 需要一个目录参数（如 --target \"D:\\my-agent\\skills\"）");
    process.exit(1);
  }
  customTarget = path.resolve(val);
}
const FLAG_FORCE = "--force";
const force = args.includes(FLAG_FORCE);

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

/** 仅识别 frontmatter 里 name 恰为本 skill 的文件（整行精确匹配，防超串/嵌入伪造） */
const isOurs = (filePath) => {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines[0].trim() !== "---") return false; // 无 frontmatter 一律视为外来文件
    const end = lines.indexOf("---", 1);
    if (end < 0) return false;
    const nameLine = `name: ${SKILL_NAME}`;
    return lines.slice(1, end).some((l) => l.trim() === nameLine);
  } catch {
    return false;
  }
};

// ---- 第 2 步：逐目录安装（先备份决策，后写入）----
console.log(`安装 ${SKILL_NAME} skill ...`);
let hadError = false;
let skippedSkillCount = 0;
for (const t of targets) {
  const dir = path.join(t, SKILL_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });

    const destSkill = path.join(dir, "SKILL.md");
    let skillWritten = true;
    if (fs.existsSync(destSkill)) {
      if (!isOurs(destSkill) && !force) {
        console.warn(`  ! 跳过 SKILL.md（外来文件保护）: ${destSkill} 确认要覆盖请使用 force 开关。`);
        skillWritten = false;
        skippedSkillCount++;
      } else {
        const bak = backup(destSkill);
        console.log(`  ⧗ 已备份原 SKILL.md → ${path.basename(bak)}`);
        fs.copyFileSync(srcFiles[0].path, destSkill);
      }
    } else {
      fs.copyFileSync(srcFiles[0].path, destSkill);
    }

    // 其余必需文件（cdp-client.mjs）无条件安装；覆盖前同样备份
    for (const s of srcFiles.slice(1)) {
      const dest = path.join(dir, s.name);
      if (fs.existsSync(dest)) {
        const bak = backup(dest);
        console.log(`  ⧗ 已备份原 ${s.name} → ${path.basename(bak)}`);
      }
      fs.copyFileSync(s.path, dest);
    }
    console.log(skillWritten ? `  ✓ ${dir}` : `  ◐ ${dir}（SKILL.md 因外来文件保护未覆盖，其余文件已安装）`);
  } catch (e) {
    console.error(`  ✗ ${dir} : ${e.message}`);
    hadError = true;
  }
}
if (hadError) process.exitCode = 1;

// 唯一目标也被外来保护跳过 → 明确失败（调用方必须看到"没装上"，而不是"完成！"）
if (!hadError && targets.length === 1 && skippedSkillCount === 1) {
  console.error("✗ SKILL.md 未安装（外来文件保护生效）。确认覆盖请使用 force 开关。");
  process.exitCode = 1;
}

console.log("");
console.log("完成！重启你的 Agent 后，skill 即被识别。");
console.log("免责声明：仅供学习 Computer Use 自动化技术，请遵守所在学校/平台规定，勿用于违反学术诚信的行为。");
