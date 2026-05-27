/**
 * Regression tests for theme color keys used in the skill-manager TUI.
 *
 * Ensures that all th.fg("xxx", ...) and th.bg("xxx", ...) calls in
 * render methods use valid theme color keys. Prevents crashes like:
 *   Error: Unknown theme background color: selection
 *
 * Update KNOWN_FG_COLORS / KNOWN_BG_COLORS when pi adds new theme colors.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Known valid theme color keys (from pi TUI docs and theme definition)
// =============================================================================

const KNOWN_FG_COLORS = new Set([
  "text",
  "accent",
  "muted",
  "dim",
  "success",
  "error",
  "warning",
  "border",
  "borderAccent",
  "borderMuted",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
]);

const KNOWN_BG_COLORS = new Set([
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);

// =============================================================================
// Extract theme key usages from source
// =============================================================================

interface ThemeKeyUsage {
  type: "fg" | "bg";
  key: string;
  line: number;
  context: string;
}

/**
 * Parse theme key usages from skill-manager/index.ts.
 * Looks for patterns: th.fg("key", ...) and th.bg("key", ...)
 */
function extractThemeKeyUsages(): ThemeKeyUsage[] {
  const filePath = join(__dirname, "..", "index.ts");
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const usages: ThemeKeyUsage[] = [];

  // Match th.fg("key" and th.bg("key"
  const fgRegex = /\bth\.fg\(\s*["']([^"']+)["']/g;
  const bgRegex = /\bth\.bg\(\s*["']([^"']+)["']/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    let match: RegExpExecArray | null;

    // Reset regex state and search
    fgRegex.lastIndex = 0;
    while ((match = fgRegex.exec(line)) !== null) {
      usages.push({
        type: "fg",
        key: match[1],
        line: lineNo,
        context: line.trim(),
      });
    }

    bgRegex.lastIndex = 0;
    while ((match = bgRegex.exec(line)) !== null) {
      usages.push({
        type: "bg",
        key: match[1],
        line: lineNo,
        context: line.trim(),
      });
    }
  }

  return usages;
}

// =============================================================================
// Tests
// =============================================================================

// Extract once, use across all tests in this file
let _usagesCache: ThemeKeyUsage[] | undefined;
function getUsages(): ThemeKeyUsage[] {
  if (!_usagesCache) _usagesCache = extractThemeKeyUsages();
  return _usagesCache;
}

describe("theme color key validation", () => {

  it("should find theme key usages in the source", () => {
    expect(getUsages().length).toBeGreaterThan(0);
  });

  it("should only use known foreground color keys", () => {
    const invalid = getUsages().filter(
      (u) => u.type === "fg" && !KNOWN_FG_COLORS.has(u.key),
    );

    if (invalid.length > 0) {
      const details = invalid
        .map((u) => `  line ${u.line}: th.${u.type}("${u.key}", ...)`)
        .join("\n");
      throw new Error(
        `Found ${invalid.length} unknown foreground theme color key(s):\n${details}`,
      );
    }

    expect(invalid).toEqual([]);
  });

  it("should only use known background color keys", () => {
    const invalid = getUsages().filter(
      (u) => u.type === "bg" && !KNOWN_BG_COLORS.has(u.key),
    );

    if (invalid.length > 0) {
      const details = invalid
        .map((u) => `  line ${u.line}: th.${u.type}("${u.key}", ...)`)
        .join("\n");
      throw new Error(
        `Found ${invalid.length} unknown background theme color key(s):\n${details}`,
      );
    }

    expect(invalid).toEqual([]);
  });

  it("should include the specific 'selection' → 'selectedBg' regression case", () => {
    // This key caused the crash: th.bg("selection", ...)
    // It should NOT appear in the source.
    const selectionUsages = getUsages().filter((u) => u.key === "selection");
    expect(selectionUsages).toEqual([]);
  });

  it("should use 'selectedBg' as the background key for selected items", () => {
    // Ensure the fix is in place: at least one usage of th.bg("selectedBg", ...)
    const selectedBgUsages = getUsages().filter(
      (u) => u.type === "bg" && u.key === "selectedBg",
    );
    expect(selectedBgUsages.length).toBeGreaterThanOrEqual(2);
  });
});

describe("theme key usage snapshot", () => {

  it("should have the expected set of theme keys (snapshot)", () => {
    const fgKeys = [...new Set(getUsages().filter((u) => u.type === "fg").map((u) => u.key))].sort();
    const bgKeys = [...new Set(getUsages().filter((u) => u.type === "bg").map((u) => u.key))].sort();

    // Snapshot: if a key is added/removed, this test fails and prompts review.
    // Adding new keys is fine — just update the expectations.
    expect(fgKeys).toEqual([
      "accent",
      "borderMuted",
      "dim",
      "muted",
      "text",
      "warning",
    ]);

    expect(bgKeys).toEqual([
      "selectedBg",
    ]);
  });
});
