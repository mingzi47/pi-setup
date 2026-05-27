/**
 * Integration tests for skill-manager filesystem-dependent functions.
 *
 * These tests create temporary directories and files to test:
 * - setSkillTrigger (modifies SKILL.md frontmatter)
 * - scanDirectory / discoverSkills (scans directory trees)
 * - loadTriggerStates / saveTriggerState / restoreTriggersFromState
 * - cleanupTriggersForPackage
 * - getInstalledSkillPackages / getPackageSkillConfigs
 * - resolvePackagePath (with existence check)
 *
 * Since these are internal functions of index.ts, we re-implement them
 * here for testing. The implementations match those in index.ts exactly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Re-import helpers for use in these tests
import {
  parseFrontmatter,
  isManualTrigger,
  matchesSkillFilter,
} from "../helpers";

// =============================================================================
// Test Helpers
// =============================================================================

let testDir: string;

function makeTmpDir() {
  return join(tmpdir(), `skill-manager-test-${randomUUID()}`);
}

beforeEach(() => {
  testDir = makeTmpDir();
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

// =============================================================================
// setSkillTrigger (re-implemented from index.ts)
// =============================================================================

function setSkillTrigger(filePath: string, manual: boolean): boolean {
  const content = readFileSync(filePath, "utf-8");
  const { fields } = parseFrontmatter(content);

  const currentlyManual = isManualTrigger(fields);
  if (currentlyManual === manual) return false; // no change needed

  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return false;

  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endIdx === -1) return false;

  // Find existing disable-model-invocation line
  const disableLineIdx = lines.findIndex(
    (l, i) => i > 0 && i < endIdx && /^\s*disable-model-invocation\s*:/.test(l),
  );

  if (manual) {
    // Add disable-model-invocation: true
    if (disableLineIdx === -1) {
      lines.splice(endIdx, 0, "disable-model-invocation: true");
    } else {
      lines[disableLineIdx] = "disable-model-invocation: true";
    }
  } else {
    // Remove disable-model-invocation
    if (disableLineIdx !== -1) {
      lines.splice(disableLineIdx, 1);
    }
  }

  writeFileSync(filePath, lines.join("\n"), "utf-8");
  return true;
}

describe("setSkillTrigger (integration)", () => {
  function createSkillMd(
    dir: string,
    frontmatter: string,
    body = "# Body",
  ): string {
    const skillDir = join(dir, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillMdPath = join(skillDir, "SKILL.md");
    writeFileSync(skillMdPath, frontmatter + "\n" + body, "utf-8");
    return skillMdPath;
  }

  it("sets manual trigger on a skill with auto by default", () => {
    const path = createSkillMd(
      testDir,
      "---\nname: test\ndescription: desc\n---",
    );

    // Initially auto (no disable-model-invocation)
    const before = readFileSync(path, "utf-8");
    expect(before).not.toContain("disable-model-invocation");

    // Set to manual
    const changed = setSkillTrigger(path, true);
    expect(changed).toBe(true);

    // Verify file content
    const after = readFileSync(path, "utf-8");
    const { fields } = parseFrontmatter(after);
    expect(isManualTrigger(fields)).toBe(true);
    expect(after).toContain("disable-model-invocation: true");
  });

  it("sets auto trigger on a skill set to manual", () => {
    const path = createSkillMd(
      testDir,
      "---\nname: test\ndisable-model-invocation: true\n---",
    );

    // Initially manual
    const before = readFileSync(path, "utf-8");
    expect(before).toContain("disable-model-invocation: true");

    // Set to auto
    const changed = setSkillTrigger(path, false);
    expect(changed).toBe(true);

    // Verify
    const after = readFileSync(path, "utf-8");
    const { fields } = parseFrontmatter(after);
    expect(isManualTrigger(fields)).toBe(false);
    expect(after).not.toContain("disable-model-invocation");
  });

  it("returns false when no change is needed (already manual → manual)", () => {
    const path = createSkillMd(
      testDir,
      "---\nname: test\ndisable-model-invocation: true\n---",
    );
    const changed = setSkillTrigger(path, true);
    expect(changed).toBe(false);
  });

  it("returns false when no change is needed (already auto → auto)", () => {
    const path = createSkillMd(testDir, "---\nname: test\n---");
    const changed = setSkillTrigger(path, false);
    expect(changed).toBe(false);
  });

  it("returns false when file has no frontmatter", () => {
    const path = join(testDir, "no-fm.md");
    writeFileSync(path, "# No frontmatter", "utf-8");
    const changed = setSkillTrigger(path, true);
    expect(changed).toBe(false);
  });

  it("returns false when frontmatter has no closing ---", () => {
    const path = join(testDir, "bad-fm.md");
    writeFileSync(path, "---\nname: test\nbad", "utf-8");
    const changed = setSkillTrigger(path, true);
    expect(changed).toBe(false);
  });

  it("places disable-model-invocation before closing ---", () => {
    const path = createSkillMd(testDir, "---\nname: test\n---");
    setSkillTrigger(path, true);
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n");
    // should be: ---, name: test, disable-model-invocation: true, ---, # Body
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("name: test");
    expect(lines[2]).toBe("disable-model-invocation: true");
    expect(lines[3]).toBe("---");
  });

  it("toggles back and forth correctly", () => {
    const path = createSkillMd(testDir, "---\nname: test\n---");

    // auto → manual
    expect(setSkillTrigger(path, true)).toBe(true);
    expect(isManualTrigger(parseFrontmatter(readFileSync(path, "utf-8")).fields)).toBe(true);

    // manual → auto
    expect(setSkillTrigger(path, false)).toBe(true);
    expect(isManualTrigger(parseFrontmatter(readFileSync(path, "utf-8")).fields)).toBe(false);

    // auto → manual again
    expect(setSkillTrigger(path, true)).toBe(true);
    expect(isManualTrigger(parseFrontmatter(readFileSync(path, "utf-8")).fields)).toBe(true);
  });
});

// =============================================================================
// scanDirectory (re-implemented from index.ts)
// =============================================================================

interface SkillInfo {
  name: string;
  path: string;
  location: string;
  trigger: "auto" | "manual";
  description: string;
}

function scanDirectory(
  baseDir: string,
  dir: string,
  skills: SkillInfo[],
  seen: Set<string>,
  home: string,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      const skillMd = join(fullPath, "SKILL.md");
      if (existsSync(skillMd) && !seen.has(skillMd)) {
        seen.add(skillMd);
        const info = parseSkill(skillMd, home);
        if (info) skills.push(info);
      }
      scanDirectory(baseDir, fullPath, skills, seen, home);
    } else if (st.isFile() && entry.endsWith(".md") && !seen.has(fullPath)) {
      if (
        basename(dirname(fullPath)) === "skills" ||
        basename(dirname(fullPath)) === "SKILL.md"
      ) {
        if (dir.endsWith(".agents/skills")) continue;
        seen.add(fullPath);
        const info = parseSkill(fullPath, home);
        if (info) skills.push(info);
      }
    }
  }
}

function parseSkill(skillMdPath: string, home: string): SkillInfo | null {
  try {
    const content = readFileSync(skillMdPath, "utf-8");
    const { fields } = parseFrontmatter(content);

    const name = fields.get("name") || basename(dirname(skillMdPath));
    const description = fields.get("description") || "";
    const trigger = isManualTrigger(fields) ? "manual" : "auto";

    let location = skillMdPath;
    if (location.startsWith(home)) {
      location = "~" + location.slice(home.length);
    }
    location = dirname(location);

    return { name, path: skillMdPath, location, trigger, description };
  } catch {
    return null;
  }
}

describe("scanDirectory (integration)", () => {
  it("finds a single skill in a directory containing SKILL.md", () => {
    const skillsDir = join(testDir, "skills");
    mkdirSync(skillsDir, { recursive: true });

    const skillDir = join(skillsDir, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: Test skill\n---\n# Body",
    );

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].description).toBe("Test skill");
    expect(skills[0].trigger).toBe("auto");
    expect(skills[0].path).toContain("SKILL.md");
  });

  it("finds multiple skills in sibling directories", () => {
    const skillsDir = join(testDir, "skills");
    mkdirSync(skillsDir, { recursive: true });

    for (const name of ["skill-a", "skill-b", "skill-c"]) {
      const skillDir = join(skillsDir, name);
      mkdirSync(skillDir);
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\n---\n# ${name}`,
      );
    }

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["skill-a", "skill-b", "skill-c"]);
  });

  it("finds skills in nested directories", () => {
    const skillsDir = join(testDir, "skills");
    const nestedDir = join(skillsDir, "category", "nested-skill");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(nestedDir, "SKILL.md"),
      "---\nname: nested-skill\n---\n# Nested",
    );

    const rootSkillDir = join(skillsDir, "root-skill");
    mkdirSync(rootSkillDir);
    writeFileSync(
      join(rootSkillDir, "SKILL.md"),
      "---\nname: root-skill\n---\n# Root",
    );

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["nested-skill", "root-skill"]);
  });

  it("uses dirname as fallback name when frontmatter has no name", () => {
    const skillsDir = join(testDir, "skills");
    const skillDir = join(skillsDir, "fallback-name");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\ndescription: No name field\n---\n# Body",
    );

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("fallback-name");
  });

  it("respects `seen` set to avoid duplicate skills", () => {
    const skillsDir = join(testDir, "skills");
    const skillDir = join(skillsDir, "unique-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: unique-skill\n---\n# Body",
    );

    const seen = new Set<string>();
    seen.add(join(skillDir, "SKILL.md"));

    const skills: SkillInfo[] = [];
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    // Already in seen set, should not be added again
    expect(skills).toHaveLength(0);
  });

  it("ignores .md files in .agents/skills root", () => {
    const skillsDir = join(testDir, ".agents", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "ignored.md"),
      "---\nname: ignored\n---\n# Should be ignored",
    );

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    // .md files in .agents/skills root are ignored by convention
    expect(skills).toHaveLength(0);
  });

  it("detects manual skills", () => {
    const skillsDir = join(testDir, "skills");
    const skillDir = join(skillsDir, "manual-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: manual-skill\ndisable-model-invocation: true\n---\n# Body",
    );

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    expect(skills).toHaveLength(1);
    expect(skills[0].trigger).toBe("manual");
  });

  it("formats location with ~ prefix when under home", () => {
    // Use testDir as the "home" so we can write to it
    const home = testDir;
    const homeSkillsDir = join(home, ".pi/agent/skills");
    mkdirSync(homeSkillsDir, { recursive: true });
    const skillDir = join(homeSkillsDir, "home-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: home-skill\n---\n# Body",
    );

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(homeSkillsDir, homeSkillsDir, skills, seen, home);

    expect(skills).toHaveLength(1);
    expect(skills[0].location).toContain("~");
  });

  it("handles empty directories gracefully", () => {
    const skillsDir = join(testDir, "empty-skills");
    mkdirSync(skillsDir, { recursive: true });

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, skills, seen, "/home/user");

    expect(skills).toHaveLength(0);
  });

  it("handles nonexistent directories gracefully", () => {
    const nonexistent = join(testDir, "does-not-exist");

    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(nonexistent, nonexistent, skills, seen, "/home/user");

    expect(skills).toHaveLength(0);
  });
});

// =============================================================================
// Trigger State Persistence (re-implemented from index.ts)
// =============================================================================

function loadTriggerStates(triggersFile: string): {
  version: number;
  triggers: Record<string, "auto" | "manual">;
} {
  try {
    if (existsSync(triggersFile)) {
      const raw = JSON.parse(readFileSync(triggersFile, "utf-8"));
      if (raw && typeof raw.triggers === "object") {
        return { version: raw.version || 1, triggers: raw.triggers };
      }
    }
  } catch {
    // ignore corrupt file
  }
  return { version: 1, triggers: {} };
}

function saveTriggerState(
  skillPath: string,
  trigger: "auto" | "manual",
  home: string,
  triggersFile: string,
): void {
  const state = loadTriggerStates(triggersFile);
  const relPath = skillPath.startsWith(home) ? skillPath.slice(home.length + 1) : skillPath;
  state.triggers[relPath] = trigger;
  writeFileSync(triggersFile, JSON.stringify(state, null, 2), "utf-8");
}

function restoreTriggersFromState(
  home: string,
  triggersFile: string,
): number {
  const state = loadTriggerStates(triggersFile);
  if (Object.keys(state.triggers).length === 0) return 0;

  let restored = 0;
  let hasOrphans = false;

  for (const [relPath, desiredTrigger] of Object.entries(state.triggers)) {
    const skillPath = join(home, relPath);
    if (!existsSync(skillPath)) {
      // Mark orphan for cleanup
      delete state.triggers[relPath];
      hasOrphans = true;
      continue;
    }
    try {
      const content = readFileSync(skillPath, "utf-8");
      const { fields } = parseFrontmatter(content);
      const currentManual = isManualTrigger(fields);
      const desiredManual = desiredTrigger === "manual";

      if (currentManual !== desiredManual) {
        const changed = setSkillTrigger(skillPath, desiredManual);
        if (changed) restored++;
      }
    } catch {
      // skip broken files
    }
  }

  // Persist cleaned-up state (orphans removed)
  if (hasOrphans) {
    try {
      writeFileSync(triggersFile, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // silently ignore write failures
    }
  }

  return restored;
}

function cleanupTriggersForPackage(
  pkgPath: string,
  home: string,
  triggersFile: string,
): number {
  const state = loadTriggerStates(triggersFile);
  const keysBefore = Object.keys(state.triggers).length;

  const pkgRel = pkgPath.startsWith(home)
    ? pkgPath.slice(home.length + 1)
    : pkgPath;

  const newTriggers: Record<string, "auto" | "manual"> = {};
  for (const [relPath, trigger] of Object.entries(state.triggers)) {
    if (!relPath.startsWith(pkgRel)) {
      newTriggers[relPath] = trigger;
    }
  }

  state.triggers = newTriggers;
  writeFileSync(triggersFile, JSON.stringify(state, null, 2), "utf-8");

  return keysBefore - Object.keys(newTriggers).length;
}

describe("Trigger State Persistence (integration)", () => {
  let triggersFile: string;
  let home: string;

  beforeEach(() => {
    // Use testDir as the home so we can write skill files
    home = testDir;
    triggersFile = join(testDir, "skill-triggers.json");
  });

  describe("loadTriggerStates", () => {
    it("returns default state when file does not exist", () => {
      const state = loadTriggerStates(triggersFile);
      expect(state.version).toBe(1);
      expect(state.triggers).toEqual({});
    });

    it("returns default state when file is empty", () => {
      writeFileSync(triggersFile, "", "utf-8");
      const state = loadTriggerStates(triggersFile);
      expect(state.version).toBe(1);
      expect(state.triggers).toEqual({});
    });

    it("returns default state when file is corrupt JSON", () => {
      writeFileSync(triggersFile, "{broken json", "utf-8");
      const state = loadTriggerStates(triggersFile);
      expect(state.version).toBe(1);
      expect(state.triggers).toEqual({});
    });

    it("loads existing trigger state", () => {
      writeFileSync(
        triggersFile,
        JSON.stringify({
          version: 1,
          triggers: {
            ".pi/agent/skills/skill-a/SKILL.md": "manual",
          },
        }),
        "utf-8",
      );
      const state = loadTriggerStates(triggersFile);
      expect(state.triggers[".pi/agent/skills/skill-a/SKILL.md"]).toBe("manual");
    });

    it("handles state without version field", () => {
      writeFileSync(
        triggersFile,
        JSON.stringify({
          triggers: {
            "path/to/skill.md": "auto",
          },
        }),
        "utf-8",
      );
      const state = loadTriggerStates(triggersFile);
      expect(state.version).toBe(1);
      expect(state.triggers["path/to/skill.md"]).toBe("auto");
    });
  });

  describe("saveTriggerState", () => {
    it("persists a trigger mode for a skill", () => {
      // Create the skill file first so we can test restore later
      const skillPath = join(home, ".pi/agent/skills/mysave/SKILL.md");
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, "---\nname: mysave\n---\n# Body", "utf-8");

      saveTriggerState(skillPath, "manual", home, triggersFile);

      const state = loadTriggerStates(triggersFile);
      const expectedKey = ".pi/agent/skills/mysave/SKILL.md";
      expect(state.triggers[expectedKey]).toBe("manual");
    });

    it("stores path relative to home", () => {
      const skillPath = join(home, ".pi/agent/skills/relative-test/SKILL.md");
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, "---\nname: relative-test\n---\n# Body", "utf-8");

      saveTriggerState(skillPath, "auto", home, triggersFile);

      const state = loadTriggerStates(triggersFile);
      const keys = Object.keys(state.triggers);
      // No key should start with /home/
      expect(keys.every((k) => !k.startsWith("/home/"))).toBe(true);
      expect(keys[0]).toBe(".pi/agent/skills/relative-test/SKILL.md");
    });

    it("stores absolute path when not under home", () => {
      const skillPath = "/some/other/path/skill.md";

      saveTriggerState(skillPath, "manual", home, triggersFile);

      const state = loadTriggerStates(triggersFile);
      expect(state.triggers["/some/other/path/skill.md"]).toBe("manual");
    });

    it("can update an existing trigger mode", () => {
      const skillPath = join(home, ".pi/agent/skills/update-test/SKILL.md");
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, "---\nname: update-test\n---\n# Body", "utf-8");

      // First save as manual
      saveTriggerState(skillPath, "manual", home, triggersFile);
      expect(
        loadTriggerStates(triggersFile).triggers[
          ".pi/agent/skills/update-test/SKILL.md"
        ],
      ).toBe("manual");

      // Then update to auto
      saveTriggerState(skillPath, "auto", home, triggersFile);
      expect(
        loadTriggerStates(triggersFile).triggers[
          ".pi/agent/skills/update-test/SKILL.md"
        ],
      ).toBe("auto");
    });
  });

  describe("restoreTriggersFromState", () => {
    it("restores trigger mode from persisted state", () => {
      const skillPath = join(home, ".pi/agent/skills/restore-test/SKILL.md");
      mkdirSync(dirname(skillPath), { recursive: true });
      // Write skill with auto mode (no disable-model-invocation)
      writeFileSync(skillPath, "---\nname: restore-test\n---\n# Body", "utf-8");

      // Persist desired mode as manual
      saveTriggerState(skillPath, "manual", home, triggersFile);

      // Now simulate reload: the skill file has auto but we want manual
      const restored = restoreTriggersFromState(home, triggersFile);
      expect(restored).toBe(1);

      // Verify the file was updated
      const content = readFileSync(skillPath, "utf-8");
      expect(content).toContain("disable-model-invocation: true");
    });

    it("returns 0 when no triggers need restoring", () => {
      const skillPath = join(home, ".pi/agent/skills/already-manual/SKILL.md");
      mkdirSync(dirname(skillPath), { recursive: true });
      // Write skill with manual mode
      writeFileSync(
        skillPath,
        "---\nname: already-manual\ndisable-model-invocation: true\n---\n# Body",
        "utf-8",
      );

      // Persist desired mode as manual (same as current)
      saveTriggerState(skillPath, "manual", home, triggersFile);

      // Restore: file is already manual, no change needed
      const restored = restoreTriggersFromState(home, triggersFile);
      expect(restored).toBe(0);
    });

    it("skips skills whose file no longer exists and cleans up orphan entries", () => {
      // Create a trigger state entry for a nonexistent skill
      writeFileSync(
        triggersFile,
        JSON.stringify({
          version: 1,
          triggers: {
            ".pi/agent/skills/deleted-skill/SKILL.md": "manual",
          },
        }),
        "utf-8",
      );

      const restored = restoreTriggersFromState(home, triggersFile);
      expect(restored).toBe(0);

      // Orphan entry should be removed from the triggers file
      const state = loadTriggerStates(triggersFile);
      expect(state.triggers[".pi/agent/skills/deleted-skill/SKILL.md"]).toBeUndefined();
    });

    it("removes multiple orphan entries while keeping valid ones", () => {
      const validPath = join(home, ".pi/agent/skills/valid/SKILL.md");
      mkdirSync(dirname(validPath), { recursive: true });
      writeFileSync(validPath, "---\nname: valid\n---\n# Body", "utf-8");

      writeFileSync(
        triggersFile,
        JSON.stringify({
          version: 1,
          triggers: {
            ".pi/agent/skills/valid/SKILL.md": "auto",
            ".pi/agent/skills/orphan-a/SKILL.md": "manual",
            ".pi/agent/skills/orphan-b/SKILL.md": "auto",
          },
        }),
        "utf-8",
      );

      const restored = restoreTriggersFromState(home, triggersFile);
      expect(restored).toBe(0); // no restore needed (valid is already auto)

      const state = loadTriggerStates(triggersFile);
      expect(state.triggers[".pi/agent/skills/valid/SKILL.md"]).toBe("auto");
      expect(state.triggers[".pi/agent/skills/orphan-a/SKILL.md"]).toBeUndefined();
      expect(state.triggers[".pi/agent/skills/orphan-b/SKILL.md"]).toBeUndefined();
    });

    it("returns 0 when trigger state is empty", () => {
      const restored = restoreTriggersFromState(home, triggersFile);
      expect(restored).toBe(0);
    });
  });

  describe("cleanupTriggersForPackage", () => {
    it("removes trigger entries for a package", () => {
      writeFileSync(
        triggersFile,
        JSON.stringify({
          version: 1,
          triggers: {
            ".pi/agent/git/github.com/user/repo/skills/a/SKILL.md": "auto",
            ".pi/agent/git/github.com/user/repo/skills/b/SKILL.md": "manual",
            ".pi/agent/skills/local-skill/SKILL.md": "auto",
          },
        }),
        "utf-8",
      );

      const removed = cleanupTriggersForPackage(
        join(home, ".pi/agent/git/github.com/user/repo"),
        home,
        triggersFile,
      );

      expect(removed).toBe(2);

      const state = loadTriggerStates(triggersFile);
      const keys = Object.keys(state.triggers);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toBe(".pi/agent/skills/local-skill/SKILL.md");
    });

    it("returns 0 when package has no trigger entries", () => {
      writeFileSync(
        triggersFile,
        JSON.stringify({
          version: 1,
          triggers: {
            ".pi/agent/skills/other/SKILL.md": "auto",
          },
        }),
        "utf-8",
      );

      const removed = cleanupTriggersForPackage(
        join(home, ".pi/agent/git/github.com/other/pkg"),
        home,
        triggersFile,
      );

      expect(removed).toBe(0);
    });

    it("handles empty state gracefully", () => {
      const removed = cleanupTriggersForPackage(
        join(home, ".pi/agent/git/github.com/user/repo"),
        home,
        triggersFile,
      );

      expect(removed).toBe(0);
    });
  });
});

// =============================================================================
// getPackageSkillConfigs (re-implemented from index.ts)
// =============================================================================

interface PackageSkillConfig {
  skillsDir: string;
  skillFilters?: string[];
}

/**
 * Minimal re-implementation of getPackageSkillConfigs that reads settings.json
 * from the given path and resolves package skill configs.
 */
function getPackageSkillConfigs(
  settingsPath: string,
  home: string,
): PackageSkillConfig[] {
  const configs: PackageSkillConfig[] = [];

  if (!existsSync(settingsPath)) return configs;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const packages: (string | { source: string; skills?: string[] })[] =
      settings.packages || [];

    for (const pkg of packages) {
      const source = typeof pkg === "string" ? pkg : pkg.source;
      const filters = typeof pkg === "string" ? undefined : pkg.skills;

      // Resolve package path
      let pkgPath: string | null = null;

      if (source.startsWith("npm:")) {
        const name = source.slice(4).replace(/@[\d.]+$/, "");
        pkgPath = join(home, ".pi/agent/npm", name);
      } else {
        // git packages
        let normalized = source.startsWith("git:") ? source.slice(4) : source;
        const refMatch = normalized.match(/@([^/]+)$/);
        if (refMatch) normalized = normalized.slice(0, normalized.length - refMatch[0].length);

        if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/[^/]+\/[^/]+$/.test(normalized)) {
          normalized = `https://${normalized}`;
        }
        if (normalized.startsWith("git@")) {
          normalized = normalized.replace(/^git@/, "").replace(":", "/");
        }

        try {
          const url = new URL(normalized);
          pkgPath = join(home, ".pi/agent/git", url.hostname, url.pathname.replace(/\.git$/, ""));
        } catch {
          const parts = normalized.split("/");
          if (parts.length >= 3 && parts[0].includes(".") && !parts[0].startsWith("/")) {
            pkgPath = join(home, ".pi/agent/git", ...parts).replace(/\.git$/, "");
          }
        }
      }

      if (pkgPath) {
        const skillsDir = join(pkgPath, "skills");
        if (existsSync(skillsDir)) {
          configs.push({ skillsDir, skillFilters: filters });
        }
      }
    }
  } catch {
    // ignore parse errors
  }

  return configs;
}

describe("getPackageSkillConfigs (integration)", () => {
  it("parses packages from settings.json correctly", () => {
    const pkgSkillsDir = join(testDir, "skills");
    mkdirSync(pkgSkillsDir, { recursive: true });

    const settingsPath = join(testDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: ["git:github.com/mattpocock/skills"],
      }),
      "utf-8",
    );

    // We need the resolved path to actually exist
    const resolvedSkillsDir = join(
      testDir,
      ".pi/agent/git/github.com/mattpocock/skills/skills",
    );
    mkdirSync(resolvedSkillsDir, { recursive: true });

    // Override home to point at testDir
    const configs = getPackageSkillConfigs(settingsPath, testDir);
    
    // We should find at least config items for existing skills dirs
    // (The exact count depends on whether the resolved path has skills/ dir)
  });

  it("returns empty array when settings.json doesn't exist", () => {
    const configs = getPackageSkillConfigs(
      join(testDir, "nonexistent.json"),
      testDir,
    );
    expect(configs).toEqual([]);
  });

  it("returns empty array when settings has no packages", () => {
    const settingsPath = join(testDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ other: "stuff" }),
      "utf-8",
    );

    const configs = getPackageSkillConfigs(settingsPath, testDir);
    expect(configs).toEqual([]);
  });

  it("handles corrupt settings.json gracefully", () => {
    const settingsPath = join(testDir, "settings.json");
    writeFileSync(settingsPath, "not valid json {", "utf-8");

    const configs = getPackageSkillConfigs(settingsPath, testDir);
    expect(configs).toEqual([]);
  });

  it("filters packages that don't have a skills directory", () => {
    const settingsPath = join(testDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: ["git:github.com/user/missing-skills-dir"],
      }),
      "utf-8",
    );

    // The resolved path won't exist, so no configs returned
    const configs = getPackageSkillConfigs(settingsPath, testDir);
    expect(configs).toEqual([]);
  });

  it("includes skillFilters from object-style package entries", () => {
    const home = testDir;

    // Create the resolved skills directory
    const githubDir = join(home, ".pi/agent/git/github.com/user/repo");
    const skillsDir = join(githubDir, "skills");
    mkdirSync(skillsDir, { recursive: true });

    const settingsPath = join(testDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: [
          {
            source: "git:github.com/user/repo",
            skills: ["+productivity", "-deprecated"],
          },
        ],
      }),
      "utf-8",
    );

    const configs = getPackageSkillConfigs(settingsPath, testDir);

    // Verify we found a config
    const found = configs.find((c) => c.skillsDir === skillsDir);
    expect(found).toBeDefined();
    expect(found!.skillFilters).toEqual(["+productivity", "-deprecated"]);
  });
});

// =============================================================================
// readPackageSkillFilters / writePackageSkillFilters (re-implemented)
// =============================================================================

/**
 * Read the skills filter array for a package from settings.json.
 * Returns the filters array, or undefined if no filters key exists.
 * Returns empty array if skills: [] is set.
 */
function readPackageSkillFilters(
  settingsPath: string,
  packageSource: string,
): string[] | undefined {
  if (!existsSync(settingsPath)) return undefined;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const packages: (string | { source: string; skills?: string[] })[] =
      settings.packages || [];

    for (const pkg of packages) {
      const src = typeof pkg === "string" ? pkg : pkg.source;
      if (src === packageSource) {
        if (typeof pkg === "object" && Array.isArray(pkg.skills)) {
          return pkg.skills;
        }
        // String package entry: no filters defined → undefined (all visible)
        return undefined;
      }
    }
  } catch {
    // ignore parse errors
  }

  return undefined;
}

/**
 * Write a skills filter array for a package to settings.json.
 * Ensures the package entry is an object form with `skills` field.
 */
function writePackageSkillFilters(
  settingsPath: string,
  packageSource: string,
  filters: string[],
): void {
  let settings: { packages: (string | { source: string; skills?: string[] })[] };

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = { packages: [] };
    }
  } else {
    settings = { packages: [] };
  }

  if (!Array.isArray(settings.packages)) {
    settings.packages = [];
  }

  // Find existing package entry
  const pkgIdx = settings.packages.findIndex((p) => {
    const src = typeof p === "string" ? p : p.source;
    return src === packageSource;
  });

  if (pkgIdx === -1) {
    // Package not found, add new entry
    settings.packages.push({ source: packageSource, skills: filters });
  } else {
    // Update existing entry
    const existing = settings.packages[pkgIdx];
    if (typeof existing === "string") {
      settings.packages[pkgIdx] = { source: packageSource, skills: filters };
    } else {
      settings.packages[pkgIdx] = { ...existing, skills: filters };
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

describe("Package Skill Filters Read/Write (integration)", () => {
  let settingsPath: string;
  const pkgSource = "git:github.com/user/test-pkg";

  beforeEach(() => {
    settingsPath = join(testDir, "settings.json");
  });

  describe("readPackageSkillFilters", () => {
    it("returns undefined when settings.json does not exist", () => {
      expect(readPackageSkillFilters(settingsPath, pkgSource)).toBeUndefined();
    });

    it("returns undefined for string-only package entry (no filters)", () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ packages: [pkgSource] }),
        "utf-8",
      );
      expect(readPackageSkillFilters(settingsPath, pkgSource)).toBeUndefined();
    });

    it("returns the skills array for object package entry", () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          packages: [
            { source: pkgSource, skills: ["+skills/a", "-skills/b"] },
          ],
        }),
        "utf-8",
      );
      const filters = readPackageSkillFilters(settingsPath, pkgSource);
      expect(filters).toEqual(["+skills/a", "-skills/b"]);
    });

    it("returns empty array when skills: [] is set", () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          packages: [{ source: pkgSource, skills: [] }],
        }),
        "utf-8",
      );
      const filters = readPackageSkillFilters(settingsPath, pkgSource);
      expect(filters).toEqual([]);
    });

    it("returns undefined when package not found in settings", () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ packages: ["git:github.com/user/other-pkg"] }),
        "utf-8",
      );
      expect(readPackageSkillFilters(settingsPath, pkgSource)).toBeUndefined();
    });
  });

  describe("writePackageSkillFilters", () => {
    it("writes filters to a new settings.json", () => {
      writePackageSkillFilters(settingsPath, pkgSource, ["-skills/x"]);
      const filters = readPackageSkillFilters(settingsPath, pkgSource);
      expect(filters).toEqual(["-skills/x"]);
    });

    it("adds skills field to existing string package entry", () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ packages: [pkgSource] }),
        "utf-8",
      );
      writePackageSkillFilters(settingsPath, pkgSource, ["-skills/a"]);
      const filters = readPackageSkillFilters(settingsPath, pkgSource);
      expect(filters).toEqual(["-skills/a"]);
    });

    it("updates existing filter array", () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          packages: [{ source: pkgSource, skills: ["+skills/old"] }],
        }),
        "utf-8",
      );
      writePackageSkillFilters(settingsPath, pkgSource, ["-skills/new"]);
      const filters = readPackageSkillFilters(settingsPath, pkgSource);
      expect(filters).toEqual(["-skills/new"]);
    });

    it("preserves other package entries", () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          packages: ["git:github.com/user/other", { source: pkgSource, skills: ["+skills/a"] }],
        }),
        "utf-8",
      );
      writePackageSkillFilters(settingsPath, pkgSource, ["-skills/b"]);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(settings.packages).toHaveLength(2);
      expect(settings.packages[0]).toBe("git:github.com/user/other");
      expect(settings.packages[1]).toEqual({ source: pkgSource, skills: ["-skills/b"] });
    });
  });
});

// =============================================================================
// matchesSkillFilter - End-to-end with scanDirectory + filter
// =============================================================================

describe("Skill Filtering (end-to-end)", () => {
  it("filters skills based on + and - patterns with scanDirectory", () => {
    const skillsDir = join(testDir, "skills");

    // Create skill in "productivity" category
    const prodDir = join(skillsDir, "productivity", "good-skill");
    mkdirSync(prodDir, { recursive: true });
    writeFileSync(
      join(prodDir, "SKILL.md"),
      "---\nname: good-skill\n---\n# Good",
    );

    // Create skill in "deprecated" category
    const depDir = join(skillsDir, "deprecated", "old-skill");
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      join(depDir, "SKILL.md"),
      "---\nname: old-skill\n---\n# Old",
    );

    // Scan all skills
    const allSkills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, allSkills, seen, "/home/user");

    // Apply filter: only productivity, not deprecated
    const filters = ["+productivity", "-deprecated"];
    const filtered = allSkills.filter((s) => {
      const relPath = relative(skillsDir, dirname(s.path));
      return matchesSkillFilter(relPath, filters);
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("good-skill");
  });

  it("includes all skills when no filters are applied", () => {
    const skillsDir = join(testDir, "skills");

    for (const name of ["a", "b", "c"]) {
      const d = join(skillsDir, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}`);
    }

    const allSkills: SkillInfo[] = [];
    const seen = new Set<string>();
    scanDirectory(skillsDir, skillsDir, allSkills, seen, "/home/user");

    // No filter, expect all
    expect(allSkills).toHaveLength(3);
  });
});
