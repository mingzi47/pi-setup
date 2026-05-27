/**
 * Tests for skill-manager helper functions.
 *
 * These test pure functions extracted into helpers.ts.
 * Functions involving filesystem (setSkillTrigger, discoverSkills, etc.)
 * are tested via integration tests using temporary directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseFrontmatter,
  isManualTrigger,
  matchesSkillFilter,
  resolvePackagePathSpec,
  parseSkillContent,
  toggleSkillVisibility,
  getSkillVisibilityEntry,
  updateSkillFilterArray,
  groupSkillsByPackage,
} from "../helpers";

// =============================================================================
// parseFrontmatter
// =============================================================================

describe("parseFrontmatter", () => {
  it("returns empty fields and full content as rest when no frontmatter exists", () => {
    const content = "Just some text\nNo frontmatter here";
    const result = parseFrontmatter(content);
    expect(result.fields.size).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.rest).toBe(content);
  });

  it("parses a simple frontmatter block with one field", () => {
    const content = `---
name: my-skill
---
# Body content`;
    const result = parseFrontmatter(content);
    expect(result.fields.get("name")).toBe("my-skill");
    expect(result.lines).toEqual(["name: my-skill"]);
    expect(result.rest).toBe("# Body content");
  });

  it("parses multiple fields in frontmatter", () => {
    const content = `---
name: my-skill
description: Does something useful
disable-model-invocation: true
---
Body text here`;
    const result = parseFrontmatter(content);
    expect(result.fields.get("name")).toBe("my-skill");
    expect(result.fields.get("description")).toBe("Does something useful");
    expect(result.fields.get("disable-model-invocation")).toBe("true");
    expect(result.fields.size).toBe(3);
    expect(result.rest).toBe("Body text here");
  });

  it("handles fields with hyphens in names", () => {
    const content = `---
name: my-skill
disable-model-invocation: true
---
body`;
    const result = parseFrontmatter(content);
    expect(result.fields.get("disable-model-invocation")).toBe("true");
    expect(result.fields.get("name")).toBe("my-skill");
  });

  it("handles fields with numeric values", () => {
    const content = `---
name: v2
version: 2
count: 42
---
body`;
    const result = parseFrontmatter(content);
    expect(result.fields.get("version")).toBe("2");
    expect(result.fields.get("count")).toBe("42");
  });

  it("handles fields with colons in values", () => {
    const content = `---
name: my-skill
description: Use when: something happens
---
body`;
    const result = parseFrontmatter(content);
    expect(result.fields.get("description")).toBe("Use when: something happens");
  });

  it("returns empty for malformed frontmatter (no closing ---)", () => {
    const content = `---
name: my-skill
description: bad
Body without closing ---`;
    const result = parseFrontmatter(content);
    expect(result.fields.size).toBe(0);
    expect(result.rest).toBe(content);
  });

  it("handles frontmatter with empty values", () => {
    const content = `---
name:
description:
---
body`;
    const result = parseFrontmatter(content);
    expect(result.fields.get("name")).toBe("");
    expect(result.fields.get("description")).toBe("");
  });

  it("handles frontmatter with indentation in values", () => {
    const content = `---
name: my-skill
description: Does something
  very useful
---
body`;
    const result = parseFrontmatter(content);
    // Only first line of value is captured (simple regex doesn't handle multiline)
    expect(result.fields.get("description")).toBe("Does something");
  });

  it("handles empty content", () => {
    const content = "";
    const result = parseFrontmatter(content);
    expect(result.fields.size).toBe(0);
    expect(result.rest).toBe("");
  });

  it("handles content starting with --- on line 0 but no body", () => {
    const content = "---\nname: test\n---";
    const result = parseFrontmatter(content);
    expect(result.fields.get("name")).toBe("test");
    expect(result.rest).toBe("");
  });

  it("handles frontmatter with extra whitespace around ---", () => {
    const content = `  ---
name: test
  ---
body`;
    const result = parseFrontmatter(content);
    // lines[0].trim() === "---" so the frontmatter IS detected
    // (whitespace is trimmed before checking)
    expect(result.fields.get("name")).toBe("test");
    expect(result.rest).toBe("body");
  });

  it("handles multiple --- separators in body after frontmatter", () => {
    const content = `---
name: test
---
# Section 1
---
# Section 2`;
    const result = parseFrontmatter(content);
    expect(result.fields.get("name")).toBe("test");
    expect(result.rest).toBe("# Section 1\n---\n# Section 2");
  });

  it("skips lines in frontmatter that don't match key: value pattern", () => {
    const content = `---
name: test
# a comment
description: hello
---
body`;
    const result = parseFrontmatter(content);
    expect(result.fields.size).toBe(2);
    expect(result.fields.get("name")).toBe("test");
    expect(result.fields.get("description")).toBe("hello");
  });
});

// =============================================================================
// isManualTrigger
// =============================================================================

describe("isManualTrigger", () => {
  it("returns true when disable-model-invocation is 'true'", () => {
    const fields = new Map([["disable-model-invocation", "true"]]);
    expect(isManualTrigger(fields)).toBe(true);
  });

  it("returns false when disable-model-invocation is 'false'", () => {
    const fields = new Map([["disable-model-invocation", "false"]]);
    expect(isManualTrigger(fields)).toBe(false);
  });

  it("returns false when disable-model-invocation is not present", () => {
    const fields = new Map([["name", "test"]]);
    expect(isManualTrigger(fields)).toBe(false);
  });

  it("returns false for empty map", () => {
    const fields = new Map();
    expect(isManualTrigger(fields)).toBe(false);
  });

  it("returns false for case-sensitive value 'True'", () => {
    const fields = new Map([["disable-model-invocation", "True"]]);
    expect(isManualTrigger(fields)).toBe(false);
  });

  it("returns false for value '1'", () => {
    const fields = new Map([["disable-model-invocation", "1"]]);
    expect(isManualTrigger(fields)).toBe(false);
  });
});

// =============================================================================
// matchesSkillFilter
// =============================================================================

describe("matchesSkillFilter", () => {
  describe("force-include patterns (+)", () => {
    it("includes skill matching a + pattern exactly", () => {
      expect(matchesSkillFilter("skill-a", ["+skill-a"])).toBe(true);
    });

    it("includes skill whose path starts with a + pattern", () => {
      expect(matchesSkillFilter("productivity/skill-a", ["+productivity"])).toBe(true);
    });

    it("excludes skill that doesn't match any + pattern", () => {
      expect(matchesSkillFilter("skill-b", ["+skill-a"])).toBe(false);
    });

    it("excludes skill that doesn't match any + pattern even with no excludes", () => {
      expect(
        matchesSkillFilter("skill-c", ["+skill-a", "+skill-b"]),
      ).toBe(false);
    });
  });

  describe("force-exclude patterns (-)", () => {
    it("excludes skill matching a - pattern exactly", () => {
      expect(matchesSkillFilter("deprecated", ["-deprecated"])).toBe(false);
    });

    it("excludes skill whose path starts with a - pattern", () => {
      expect(
        matchesSkillFilter("deprecated/old-skill", ["-deprecated"]),
      ).toBe(false);
    });

    it("includes skill not matching any - pattern", () => {
      expect(
        matchesSkillFilter("active/skill", ["-deprecated"]),
      ).toBe(true);
    });
  });

  describe("mixed + and - patterns", () => {
    it("skill matching + but also excluded by - is excluded", () => {
      expect(
        matchesSkillFilter("productivity/broken", [
          "+productivity",
          "-productivity/broken",
        ]),
      ).toBe(false);
    });

    it("skill not matching + is excluded regardless of -", () => {
      expect(
        matchesSkillFilter("other/skill", [
          "+productivity",
          "-deprecated",
        ]),
      ).toBe(false);
    });

    it("skill matching + and not excluded by - is included", () => {
      expect(
        matchesSkillFilter("productivity/good", [
          "+productivity",
          "-productivity/broken",
        ]),
      ).toBe(true);
    });
  });

  describe("no patterns", () => {
    it("empty filter array includes everything", () => {
      expect(matchesSkillFilter("anything", [])).toBe(true);
    });
  });

  describe("non-prefixed patterns (neither + nor -)", () => {
    it("non-prefixed patterns are ignored and skill is included", () => {
      // Without + or -, the pattern is neither include nor exclude
      expect(matchesSkillFilter("some/skill", ["some"])).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("exact match works with slashes", () => {
      expect(matchesSkillFilter("a/b/c", ["+a/b/c"])).toBe(true);
    });

    it("partial dir name matches prefix correctly", () => {
      // "productivity/something" should NOT match "+product" because "product"
      // is not a prefix of "productivity/" — but "product" is a prefix of
      // "productivity/something" via startsWith("product/")? No.
      // startsWith("product/") checks "productivity/something".startsWith("product/")
      // which is false because "productivity" doesn't start with "product/"
      expect(
        matchesSkillFilter("productivity/something", ["+product"]),
      ).toBe(false);
    });

    it("filter patterns don't accidentally partial-match", () => {
      // "ab" should not match "abc/skill" unless explicitly "abc"
      expect(matchesSkillFilter("abc/skill", ["+ab"])).toBe(false);
    });
  });
});

// =============================================================================
// resolvePackagePathSpec
// =============================================================================

describe("resolvePackagePathSpec", () => {
  const home = "/home/testuser";

  describe("npm packages", () => {
    it("resolves npm:package-name", () => {
      expect(resolvePackagePathSpec("npm:pi-skills", home)).toBe(
        "/home/testuser/.pi/agent/npm/pi-skills",
      );
    });

    it("resolves npm:package-name with version", () => {
      expect(resolvePackagePathSpec("npm:pi-skills@1.2.3", home)).toBe(
        "/home/testuser/.pi/agent/npm/pi-skills",
      );
    });

    it("resolves npm:@scope/package-name", () => {
      expect(resolvePackagePathSpec("npm:@scope/pkg", home)).toBe(
        "/home/testuser/.pi/agent/npm/@scope/pkg",
      );
    });
  });

  describe("git packages via https", () => {
    it("resolves https://github.com/user/repo", () => {
      expect(
        resolvePackagePathSpec("https://github.com/user/repo", home),
      ).toBe("/home/testuser/.pi/agent/git/github.com/user/repo");
    });

    it("resolves https://github.com/user/repo.git", () => {
      expect(
        resolvePackagePathSpec("https://github.com/user/repo.git", home),
      ).toBe("/home/testuser/.pi/agent/git/github.com/user/repo");
    });
  });

  describe("git packages via git: prefix", () => {
    it("resolves git:github.com/user/repo", () => {
      expect(resolvePackagePathSpec("git:github.com/user/repo", home)).toBe(
        "/home/testuser/.pi/agent/git/github.com/user/repo",
      );
    });

    it("resolves git:https://github.com/user/repo", () => {
      expect(
        resolvePackagePathSpec("git:https://github.com/user/repo", home),
      ).toBe("/home/testuser/.pi/agent/git/github.com/user/repo");
    });
  });

  describe("git packages with @ref", () => {
    it("strips @main ref suffix", () => {
      expect(
        resolvePackagePathSpec(
          "https://github.com/user/repo@main",
          home,
        ),
      ).toBe("/home/testuser/.pi/agent/git/github.com/user/repo");
    });

    it("strips @v1.0.0 ref suffix", () => {
      expect(
        resolvePackagePathSpec(
          "git:github.com/user/repo@v1.0.0",
          home,
        ),
      ).toBe("/home/testuser/.pi/agent/git/github.com/user/repo");
    });
  });

  describe("git packages via SSH shorthand", () => {
    it("resolves git@github.com:user/repo", () => {
      expect(
        resolvePackagePathSpec("git@github.com:user/repo", home),
      ).toBe("/home/testuser/.pi/agent/git/github.com/user/repo");
    });
  });

  describe("git packages via shorthand domain", () => {
    it("resolves github.com/user/repo shorthand", () => {
      expect(
        resolvePackagePathSpec("github.com/user/repo", home),
      ).toBe("/home/testuser/.pi/agent/git/github.com/user/repo");
    });
  });

  describe("invalid sources", () => {
    it("returns null for a plain string without hostname", () => {
      expect(resolvePackagePathSpec("just-a-name", home)).toBeNull();
    });

    it("resolves relative paths containing dots as git shorthand", () => {
      // "./local/path" has "." as first part, triggers git shorthand path
      const result = resolvePackagePathSpec("./local/path", home);
      expect(result).not.toBeNull();
    });
  });
});

// =============================================================================
// toggleSkillVisibility
// =============================================================================

describe("toggleSkillVisibility", () => {
  const skillPath = "skills/engineering/grill-with-docs";

  it("toggles from undefined (default visible) to -path (hidden)", () => {
    expect(toggleSkillVisibility(undefined, skillPath)).toBe(`-${skillPath}`);
  });

  it("toggles from -path (hidden) to +path (force visible)", () => {
    expect(toggleSkillVisibility(`-${skillPath}`, skillPath)).toBe(`+${skillPath}`);
  });

  it("toggles from +path (force visible) to -path (hidden)", () => {
    expect(toggleSkillVisibility(`+${skillPath}`, skillPath)).toBe(`-${skillPath}`);
  });

  it("never returns undefined after first toggle", () => {
    let result = toggleSkillVisibility(undefined, skillPath);
    expect(result).toBe(`-${skillPath}`);

    result = toggleSkillVisibility(result, skillPath);
    expect(result).toBe(`+${skillPath}`);

    result = toggleSkillVisibility(result, skillPath);
    expect(result).toBe(`-${skillPath}`);

    result = toggleSkillVisibility(result, skillPath);
    expect(result).toBe(`+${skillPath}`);
  });

  it("preserves the skill path in the entry", () => {
    const path = "productivity/caveman";
    expect(toggleSkillVisibility(undefined, path)).toBe("-productivity/caveman");
    expect(toggleSkillVisibility("-productivity/caveman", path)).toBe("+productivity/caveman");
  });
});

// =============================================================================
// getSkillVisibilityEntry / updateSkillFilterArray
// =============================================================================

describe("getSkillVisibilityEntry", () => {
  const skillPath = "skills/engineering/triage";

  it("returns undefined when skill has no entry in filters", () => {
    expect(getSkillVisibilityEntry(skillPath, ["+skills/other"])).toBeUndefined();
  });

  it("returns undefined for empty filters", () => {
    expect(getSkillVisibilityEntry(skillPath, [])).toBeUndefined();
  });

  it("returns matching + entry", () => {
    const filters = ["+skills/engineering/triage"];
    expect(getSkillVisibilityEntry(skillPath, filters)).toBe("+skills/engineering/triage");
  });

  it("returns matching - entry", () => {
    const filters = ["-skills/engineering/triage"];
    expect(getSkillVisibilityEntry(skillPath, filters)).toBe("-skills/engineering/triage");
  });

  it("matches by prefix (parent directory)", () => {
    const filters = ["-skills/engineering"];
    expect(getSkillVisibilityEntry(skillPath, filters)).toBe("-skills/engineering");
  });

  it("returns first matching entry when multiple match", () => {
    const filters = ["-skills/engineering", "+skills/engineering/triage"];
    expect(getSkillVisibilityEntry(skillPath, filters)).toBe("-skills/engineering");
  });

  it("does not match partial directory name", () => {
    expect(getSkillVisibilityEntry("skills/engineer", ["-skills/engineering"])).toBeUndefined();
  });

  it("ignores non-prefixed patterns", () => {
    expect(getSkillVisibilityEntry(skillPath, ["skills/engineering/triage"])).toBeUndefined();
  });
});

describe("updateSkillFilterArray", () => {
  const skillPath = "skills/engineering/diagnose";

  it("adds a - entry to empty filters", () => {
    expect(updateSkillFilterArray(skillPath, [], `-${skillPath}`)).toEqual([
      `-${skillPath}`,
    ]);
  });

  it("replaces existing entry for the same skill", () => {
    const filters = [`-${skillPath}`, "+skills/other"];
    expect(updateSkillFilterArray(skillPath, filters, `+${skillPath}`)).toEqual([
      "+skills/other",
      `+${skillPath}`,
    ]);
  });

  it("replaces prefix-matched entry for the skill", () => {
    const filters = ["-skills/engineering", "-skills/deprecated"];
    expect(updateSkillFilterArray(skillPath, filters, `+${skillPath}`)).toEqual([
      "-skills/deprecated",
      `+${skillPath}`,
    ]);
  });

  it("adds new entry while keeping unrelated entries", () => {
    const filters = ["+skills/other", "-skills/deprecated"];
    expect(updateSkillFilterArray(skillPath, filters, `-${skillPath}`)).toEqual([
      "+skills/other",
      "-skills/deprecated",
      `-${skillPath}`,
    ]);
  });

  it("handles skill not in any filters", () => {
    const filters = ["+skills/unrelated"];
    expect(updateSkillFilterArray(skillPath, filters, `-${skillPath}`)).toEqual([
      "+skills/unrelated",
      `-${skillPath}`,
    ]);
  });
});

// =============================================================================
// groupSkillsByPackage
// =============================================================================

describe("groupSkillsByPackage", () => {
  const makeSkill = (name: string, path: string): { name: string; path: string; location: string; trigger: string; description: string } => ({
    name,
    path,
    location: path,
    trigger: "auto",
    description: "",
  });

  it("groups skills into a single package", () => {
    const pkgConfigs = [{ skillsDir: "/home/.pi/agent/git/github.com/user/myskills/skills" }];
    const skills = [
      makeSkill("skill-a", "/home/.pi/agent/git/github.com/user/myskills/skills/a/SKILL.md"),
      makeSkill("skill-b", "/home/.pi/agent/git/github.com/user/myskills/skills/b/SKILL.md"),
    ];

    const groups = groupSkillsByPackage(skills, pkgConfigs);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("myskills");
    expect(groups[0].skills).toHaveLength(2);
    expect(groups[0].skills.map((s) => s.name)).toEqual(["skill-a", "skill-b"]);
  });

  it("puts skills without a package into Local group", () => {
    const pkgConfigs = [{ skillsDir: "/home/.pi/agent/git/github.com/user/pkg/skills" }];
    const skills = [
      makeSkill("local-skill", "/home/.pi/agent/skills/local-skill/SKILL.md"),
      makeSkill("pkg-skill", "/home/.pi/agent/git/github.com/user/pkg/skills/pkg-skill/SKILL.md"),
    ];

    const groups = groupSkillsByPackage(skills, pkgConfigs);
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("pkg");
    expect(groups[1].name).toBe("Local");
    expect(groups[1].skills.map((s) => s.name)).toEqual(["local-skill"]);
  });

  it("sorts groups alphabetically, Local last", () => {
    const pkgConfigs = [
      { skillsDir: "/home/.pi/agent/git/github.com/user/zebra/skills" },
      { skillsDir: "/home/.pi/agent/git/github.com/user/alpha/skills" },
    ];
    const skills = [
      makeSkill("z-skill", "/home/.pi/agent/git/github.com/user/zebra/skills/z-skill/SKILL.md"),
      makeSkill("a-skill", "/home/.pi/agent/git/github.com/user/alpha/skills/a-skill/SKILL.md"),
      makeSkill("local", "/home/.pi/agent/skills/local/SKILL.md"),
    ];

    const groups = groupSkillsByPackage(skills, pkgConfigs);
    expect(groups.map((g) => g.name)).toEqual(["alpha", "zebra", "Local"]);
  });

  it("sorts skills within groups alphabetically", () => {
    const pkgConfigs = [{ skillsDir: "/home/.pi/agent/git/github.com/user/pkg/skills" }];
    const skills = [
      makeSkill("z-skill", "/home/.pi/agent/git/github.com/user/pkg/skills/z-skill/SKILL.md"),
      makeSkill("a-skill", "/home/.pi/agent/git/github.com/user/pkg/skills/a-skill/SKILL.md"),
      makeSkill("m-skill", "/home/.pi/agent/git/github.com/user/pkg/skills/m-skill/SKILL.md"),
    ];

    const groups = groupSkillsByPackage(skills, pkgConfigs);
    expect(groups[0].skills.map((s) => s.name)).toEqual(["a-skill", "m-skill", "z-skill"]);
  });

  it("does not include Local group when all skills are in packages", () => {
    const pkgConfigs = [{ skillsDir: "/home/.pi/agent/git/github.com/user/pkg/skills" }];
    const skills = [
      makeSkill("s1", "/home/.pi/agent/git/github.com/user/pkg/skills/s1/SKILL.md"),
    ];

    const groups = groupSkillsByPackage(skills, pkgConfigs);
    expect(groups.map((g) => g.name)).not.toContain("Local");
  });

  it("returns only Local group when no package configs", () => {
    const skills = [
      makeSkill("standalone", "/home/.pi/agent/skills/standalone/SKILL.md"),
    ];

    const groups = groupSkillsByPackage(skills, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Local");
  });
});

// =============================================================================
// parseSkillContent
// =============================================================================

describe("parseSkillContent", () => {
  it("parses a skill with name and description from frontmatter", () => {
    const content = `---
name: my-skill
description: A test skill
---
# Body`;
    const result = parseSkillContent(content, "default-name");
    expect(result).toEqual({
      name: "my-skill",
      description: "A test skill",
      trigger: "auto",
    });
  });

  it("falls back to dirname when name is not in frontmatter", () => {
    const content = `---
description: A test skill
---
# Body`;
    const result = parseSkillContent(content, "fallback-name");
    expect(result!.name).toBe("fallback-name");
    expect(result!.description).toBe("A test skill");
  });

  it("returns manual trigger when disable-model-invocation is true", () => {
    const content = `---
name: manual-skill
disable-model-invocation: true
---
# Body`;
    const result = parseSkillContent(content, "fallback");
    expect(result!.trigger).toBe("manual");
  });

  it("returns auto trigger when disable-model-invocation is false", () => {
    const content = `---
name: auto-skill
disable-model-invocation: false
---
# Body`;
    const result = parseSkillContent(content, "fallback");
    expect(result!.trigger).toBe("auto");
  });

  it("returns auto trigger by default", () => {
    const content = `---
name: default-skill
---
# Body`;
    const result = parseSkillContent(content, "fallback");
    expect(result!.trigger).toBe("auto");
  });

  it("handles missing description gracefully", () => {
    const content = `---
name: no-desc
---
# Body`;
    const result = parseSkillContent(content, "fallback");
    expect(result!.description).toBe("");
  });

  it("returns empty description if frontmatter has no description field", () => {
    const content = `---
name: test
version: 1
---
body`;
    const result = parseSkillContent(content, "test");
    expect(result!.description).toBe("");
  });

  it("handles content without frontmatter", () => {
    const content = "# No frontmatter";
    const result = parseSkillContent(content, "my-default");
    expect(result).toEqual({
      name: "my-default",
      description: "",
      trigger: "auto",
    });
  });
});
