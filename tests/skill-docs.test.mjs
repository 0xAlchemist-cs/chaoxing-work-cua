// R1：SKILL.md 权限边界一致性 —— 防止文档回退到"自动提交"表述
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dirname, "..", "SKILL.md"), "utf8");

test("SKILL.md 含唯一权限边界章节（perm-boundary 锚点）", () => {
  assert.match(skill, /<!-- perm-boundary -->/);
  assert.match(skill, /## 操作权限边界/);
});

test("权限边界明确覆盖 保存/提交/取消/关闭 四类操作", () => {
  const section = skill.split("<!-- perm-boundary -->")[1].split("##")[0];
  for (const word of ["暂时保存", "提交", "取消", "关闭标签页"]) {
    assert.ok(section.includes(word), `权限边界缺少：${word}`);
  }
  assert.match(section, /授权不继承/);
});

test("授权不继承：文档中不存在'提交后自动进入下一节提交'类无授权流程", () => {
  assert.ok(!/提交成功后.{0,20}(自动|直接).{0,10}(提交|下一节.{0,6}提交)/.test(skill),
    "发现未授权连续提交的表述");
});

test("CDP 用法已切换到严格身份 API（不存在子串式 connectCDP(9222, \"片段\") 示例）", () => {
  assert.ok(!/connectCDP\(9222,\s*"/.test(skill), "仍存在子串匹配式 connectCDP 示例");
  assert.match(skill, /ENOTARGET/);
  assert.match(skill, /EMULTIPLE/);
});

// ---------- R4：架构分离与统一安全基线 ----------

test("历史事故表已移出 SKILL.md，归档在 INCIDENTS.md", () => {
  assert.ok(!skill.includes("今日问题清单复盘"), "事故表应移至 INCIDENTS.md");
  assert.match(skill, /INCIDENTS\.md/, "SKILL.md 应保留指向 INCIDENTS.md 的链接");
  const incidents = readFileSync(join(import.meta.dirname, "..", "INCIDENTS.md"), "utf8");
  assert.match(incidents, /R1 目标身份/, "INCIDENTS.md 缺少审计轮记录");
  assert.match(incidents, /\| 13 \|/, "INCIDENTS.md 应保留 13 起事故全表");
});

test("三模式统一安全基线存在且覆盖 停止条件/状态核验/恢复指导", () => {
  assert.match(skill, /<!-- safety-baseline -->/);
  const section = skill.split("<!-- safety-baseline -->")[1].split("\n## ")[0];
  for (const key of ["停止条件", "状态核验", "恢复指导"]) {
    assert.ok(section.includes(key), `安全基线缺少：${key}`);
  }
  assert.match(section, /连续 2 次/, "熔断阈值应写入基线");
});

test("三个模式章节都引用统一基线（真实统一，而非仅 CDP）", () => {
  const chapters = skill.split("\n## ");
  const find = (kw) => chapters.find((c) => c.startsWith(kw)) || "";
  for (const [name, kw] of [["CDP", "CDP 直连模式"], ["IAB", "内置浏览器高效模式"], ["CUA", "外部浏览器 CUA 模式实战补充"]]) {
    const ch = find(kw);
    assert.ok(ch, `章节不存在：${name}`);
    assert.match(ch, /三模式统一安全基线/, `${name} 章节应引用统一安全基线`);
    assert.match(ch, /操作权限边界/, `${name} 章节应引用权限边界`);
  }
});

test("CI workflow 存在且跑测试与包清单校验", () => {
  const ci = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /node --test/);
  assert.match(ci, /scripts\/check-pack\.mjs/);
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /windows-latest/, "安装器涉及路径处理，应覆盖 Windows");
});
