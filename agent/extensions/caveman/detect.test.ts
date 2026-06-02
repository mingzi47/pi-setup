/**
 * Tests for language detection utilities.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "./detect.ts";

describe("detectLanguage", () => {
  it("纯英文返回 en", () => {
    assert.strictEqual(detectLanguage("Hello world"), "en");
  });

  it("纯中文返回 zh", () => {
    assert.strictEqual(detectLanguage("你好世界"), "zh");
  });

  it("中英混合返回 zh（保守：含 CJK 即中文）", () => {
    assert.strictEqual(detectLanguage("Hello 你好 world"), "zh");
  });

  it("空字符串返回 en", () => {
    assert.strictEqual(detectLanguage(""), "en");
  });

  it("纯符号数字返回 en", () => {
    assert.strictEqual(detectLanguage("123 !@#"), "en");
  });
});
