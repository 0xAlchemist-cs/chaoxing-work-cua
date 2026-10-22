// 校验 npm pack 清单：发布包必须含全部必需文件，且不含 tests。
// CI 与本地共用（node scripts/check-pack.mjs），exit 1 = 清单不合格。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repo, encoding: "utf8", shell: process.platform === "win32",
});
const files = JSON.parse(out.slice(out.indexOf("[")))[0].files.map((f) => f.path.replaceAll("\\", "/"));
const need = ["package.json", "SKILL.md", "cdp-client.mjs", "bin/install.js", "README.md", "LICENSE"];
const missing = need.filter((n) => !files.includes(n));
const leaked = files.filter((f) => f.startsWith("tests/") || f.startsWith(".github/"));
if (missing.length) { console.error("missing from tarball:", missing); process.exit(1); }
if (leaked.length) { console.error("should not be in tarball:", leaked); process.exit(1); }
console.log("tarball OK:", files.join(" "));
