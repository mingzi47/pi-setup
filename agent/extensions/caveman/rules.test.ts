/**
 * Tests for caveman rule generation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCavemanRules } from "./rules.ts";

describe("getCavemanRules", () => {
  describe("英文规则 (lang='en')", () => {
    const rules = getCavemanRules("en");

    it("包含 Drop 冠词指令", () => {
      assert.ok(rules.includes("articles") || rules.includes("a/an/the"), "should mention article dropping");
    });

    it("包含 fragment 允许指令", () => {
      assert.ok(
        rules.includes("fragment") || rules.includes("Fragments"),
        "should allow fragments"
      );
    });

    it("包含箭头因果指令", () => {
      assert.ok(rules.includes("→") || rules.includes("arrow"), "should use → for causality");
    });

    it("不包含中文字符", () => {
      assert.strictEqual(/[\p{Script=Han}]/u.test(rules), false, "en rules should have no Chinese characters");
    });
  });

  describe("中文规则 (lang='zh')", () => {
    const rules = getCavemanRules("zh");

    it("包含去语气助词指令", () => {
      assert.ok(
        rules.includes("吧") || rules.includes("啊") || rules.includes("呢") || rules.includes("嘛"),
        "should mention removing mood particles"
      );
    });

    it("包含 → 因果，但 转折指令", () => {
      assert.ok(rules.includes("→"), "should use → for causality");
      assert.ok(rules.includes("但") || rules.includes("却"), "should keep 但/却 for contrast");
    });

    it("包含保留 已 完成体指令", () => {
      assert.ok(rules.includes("已"), 'should preserve 已 for completion aspect');
    });

    it("不包含英文冠词规则", () => {
      assert.strictEqual(
        rules.includes("a/an/the") || /articles/i.test(rules),
        false,
        "zh rules should not mention English articles"
      );
    });
  });
});
