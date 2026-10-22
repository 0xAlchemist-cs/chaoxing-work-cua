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
