#!/usr/bin/env node
/**
 * chaoxing-work-cua 安装器（零依赖）
 * 把 SKILL.md + cdp-client.mjs 安装到 Agent 的技能目录。
 *
 * 安全机制：
 *   - 必需文件（SKILL.md / cdp-client.mjs）缺失 → 立即失败，且失败发生在写入任何
 *     文件之前（先全量校验，后写入）。
 *   - 安装采用「决策备份 → 暂存写入 → 原子换入」三段式；任一段失败整体回滚，
 *     目标目录保持安装前状态（不出现新旧混合的半成品）。
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

// ---- 第 2 步：逐目录安装（决策备份 → 暂存 → 换入；任一步失败整体回滚）----
console.log(`安装 ${SKILL_NAME} skill ...`);
let hadError = false;
let skippedSkillCount = 0;
for (const t of targets) {
  const dir = path.join(t, SKILL_NAME);
  const plan = srcFiles.map((s) => ({
    ...s,
    dest: path.join(dir, s.name),
    staged: path.join(dir, `${s.name}.staged-${timestamp}`),
  }));
  let skipSkill = false;
  const backups = [];   // 换入前已存在的文件 → {name, dest, bak}
  const swapped = [];   // 已换入的 dest
  try {
    fs.mkdirSync(dir, { recursive: true });

    // 决策 + 备份（此阶段不写任何目标文件）
    if (fs.existsSync(plan[0].dest) && !isOurs(plan[0].dest) && !force) {
      skipSkill = true;
      skippedSkillCount++;
      console.warn(`  ! 跳过 SKILL.md（外来文件保护）: ${plan[0].dest} 确认要覆盖请使用 force 开关。`);
    }
    for (const p of plan) {
      if (p.name === "SKILL.md" && skipSkill) continue;
      if (fs.existsSync(p.dest)) {
        const bak = backup(p.dest);
        backups.push({ name: p.name, dest: p.dest, bak });
        console.log(`  ⧗ 已备份原 ${p.name} → ${path.basename(bak)}`);
      }
    }

    // 暂存写入（失败在此阶段发生时目标文件尚未被动过）
    for (const p of plan) {
      if (p.name === "SKILL.md" && skipSkill) continue;
      fs.copyFileSync(p.path, p.staged);
    }
    // 换入（rename 原子替换）
    for (const p of plan) {
      if (p.name === "SKILL.md" && skipSkill) continue;
      fs.renameSync(p.staged, p.dest);
      swapped.push(p.dest);
    }
    console.log(skipSkill ? `  ◐ ${dir}（SKILL.md 因外来文件保护未覆盖，其余文件已安装）` : `  ✓ ${dir}`);
  } catch (e) {
    // 整体回滚：有备份的恢复备份；无备份但已换入的删除；清理暂存
    for (const b of backups) { try { fs.copyFileSync(b.bak, b.dest); } catch {} }
    for (const dest of swapped) {
      if (!backups.some((b) => b.dest === dest)) { try { fs.rmSync(dest, { force: true }); } catch {} }
    }
    for (const p of plan) { try { fs.rmSync(p.staged, { force: true }); } catch {} }
    console.error(`  ✗ ${dir} : ${e.message}（已回滚，目标目录保持安装前状态）`);
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
