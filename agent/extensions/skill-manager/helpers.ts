/**
 * Pure helper functions extracted from skill-manager for testability.
 * These have no side effects and no filesystem access.
 */

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Returns the raw frontmatter lines, the parsed key-value map, and the rest of the content.
 */
export function parseFrontmatter(content: string): {
  lines: string[];
  fields: Map<string, string>;
  rest: string;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { lines: [], fields: new Map(), rest: content };
  }

  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endIdx === -1) {
    return { lines: [], fields: new Map(), rest: content };
  }

  const fmLines = lines.slice(1, endIdx);
  const fields = new Map<string, string>();

  for (const line of fmLines) {
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (match) {
      fields.set(match[1], match[2].trim());
    }
  }

  return {
    lines: fmLines,
    fields,
    rest: lines.slice(endIdx + 1).join("\n"),
  };
}

/**
 * Check whether disable-model-invocation is set to true in frontmatter.
 */
export function isManualTrigger(fields: Map<string, string>): boolean {
  const val = fields.get("disable-model-invocation");
  return val === "true";
}

/**
 * Check if a skill path (relative to package skills dir) matches the filters.
 * Filter patterns:
 *   +path = force-include (skill must match at least one +pattern if any + exists)
 *   -path = force-exclude (skill matching a -pattern is excluded)
 *
 * Returns true if the skill should be included.
 */
export function matchesSkillFilter(
  skillRelPath: string,
  filters: string[],
): boolean {
  const includes: string[] = [];
  const excludes: string[] = [];

  for (const f of filters) {
    if (f.startsWith("+")) {
      includes.push(f.slice(1));
    } else if (f.startsWith("-")) {
      excludes.push(f.slice(1));
    }
  }

  // If force-includes exist, the skill MUST match at least one
  if (includes.length > 0) {
    const matched = includes.some(
      (inc) => skillRelPath === inc || skillRelPath.startsWith(inc + "/"),
    );
    if (!matched) return false;
  }

  // Check force-excludes
  for (const exc of excludes) {
    if (skillRelPath === exc || skillRelPath.startsWith(exc + "/")) {
      return false;
    }
  }

  return true;
}

/**
 * Resolve a package source string to a local path on disk.
 * Handles git (https://, ssh://, git:host/path, git@) and npm (npm:name) specs.
 * This is the pure resolution logic: path derivation only, no existence check.
 */
export function resolvePackagePathSpec(source: string, home: string): string | null {
  // npm packages
  if (source.startsWith("npm:")) {
    const name = source.slice(4).replace(/@[\d.]+$/, ""); // strip version
    return `${home}/.pi/agent/npm/${name}`;
  }

  // git packages
  let normalized = source;
  if (normalized.startsWith("git:")) {
    normalized = normalized.slice(4);
  }

  // Strip @ref suffix
  const refMatch = normalized.match(/@([^/]+)$/);
  if (refMatch) {
    normalized = normalized.slice(0, normalized.length - refMatch[0].length);
  }

  // Handle shorthand: github.com/user/repo → https://github.com/user/repo
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/[^/]+\/[^/]+$/.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  // Handle git@github.com:user/repo → github.com/user/repo
  if (normalized.startsWith("git@")) {
    normalized = normalized.replace(/^git@/, "").replace(":", "/");
  }

  // Parse host and path from URL
  try {
    const url = new URL(normalized);
    return `${home}/.pi/agent/git/${url.hostname}${url.pathname.replace(/\.git$/, "")}`;
  } catch {
    const parts = normalized.split("/");
    if (parts.length >= 3 && parts[0].includes(".") && !parts[0].startsWith("/")) {
      return `${home}/.pi/agent/git/${normalized.replace(/\.git$/, "")}`;
    }
    return null;
  }
}

/**
 * Toggle a skill's visibility filter entry.
 * Cycle: undefined (default visible) → "-path" (hidden) → "+path" (force visible) → "-path"
 * Once a skill is toggled, it must always have an explicit + or - entry (never returns undefined).
 *
 * @param currentEntry - Current filter entry for this skill, or undefined if not present
 * @param skillRelPath - The skill's path relative to the package root
 * @returns The next filter entry, or undefined only on the first toggle from undefined
 */
export function toggleSkillVisibility(
  currentEntry: string | undefined,
  skillRelPath: string,
): string {
  if (currentEntry === undefined) {
    return `-${skillRelPath}`;
  }
  if (currentEntry.startsWith("-")) {
    return `+${skillRelPath}`;
  }
  // currentEntry startsWith("+") → toggle to hidden
  return `-${skillRelPath}`;
}

/**
 * Find the current filter entry for a skill in the skills filter array.
 * Returns the matching entry string (e.g. "+skills/foo" or "-skills/foo"),
 * or undefined if the skill has no explicit entry (meaning default visible).
 */
export function getSkillVisibilityEntry(
  skillRelPath: string,
  filters: string[],
): string | undefined {
  for (const f of filters) {
    const isPlus = f.startsWith("+");
    const isMinus = f.startsWith("-");
    if (isPlus || isMinus) {
      const pattern = isPlus ? f.slice(1) : isMinus ? f.slice(1) : f;
      if (pattern === skillRelPath || skillRelPath.startsWith(pattern + "/")) {
        return f;
      }
    }
  }
  return undefined;
}

/**
 * Update the skills filter array for a skill toggle.
 * Adds, removes, or replaces entries based on the toggle cycle.
 *
 * @param skillRelPath - The skill path relative to package root
 * @param currentFilters - The current skills filter array
 * @param newEntry - The new entry to set (e.g. "+skills/foo" or "-skills/foo") - must be the full entry
 * @returns The updated filter array
 */
export function updateSkillFilterArray(
  skillRelPath: string,
  currentFilters: string[],
  newEntry: string,
): string[] {
  // Remove any existing entry for this skill (exact match or prefix match)
  const filtered = currentFilters.filter((f) => {
    const isPlus = f.startsWith("+");
    const isMinus = f.startsWith("-");
    if (isPlus || isMinus) {
      const pattern = isPlus ? f.slice(1) : isMinus ? f.slice(1) : f;
      if (pattern === skillRelPath || skillRelPath.startsWith(pattern + "/")) {
        return false;
      }
    }
    return true;
  });

  // Add the new entry
  filtered.push(newEntry);
  return filtered;
}

/**
 * Group skills by their package origin.
 * Skills that belong to a package (under its skillsDir) are grouped by package name.
 * Skills not under any package go into the "Local" group.
 *
 * @param skills - All discovered skills
 * @param pkgConfigs - Package skill configs with skillsDir paths
 * @returns Array of groups sorted alphabetically (Local last)
 */
export function groupSkillsByPackage(
  skills: { name: string; path: string; location: string; trigger: string; description: string }[],
  pkgConfigs: { skillsDir: string }[],
): { name: string; skills: typeof skills }[] {
  const groupMap = new Map<string, typeof skills>();
  const localSkills: typeof skills = [];

  for (const skill of skills) {
    let matched = false;
    for (const config of pkgConfigs) {
      if (skill.path.startsWith(config.skillsDir + "/") || skill.path.startsWith(config.skillsDir)) {
        // Extract package name: the last segment of the package root (parent of skillsDir)
        const pkgRoot = config.skillsDir.replace(/\/skills\/?$/, "");
        const pkgName = pkgRoot.split("/").pop() || "unknown";
        if (!groupMap.has(pkgName)) {
          groupMap.set(pkgName, []);
        }
        groupMap.get(pkgName)!.push(skill);
        matched = true;
        break;
      }
    }
    if (!matched) {
      localSkills.push(skill);
    }
  }

  // Sort each group by skill name
  for (const skills of groupMap.values()) {
    skills.sort((a, b) => a.name.localeCompare(b.name));
  }
  localSkills.sort((a, b) => a.name.localeCompare(b.name));

  // Build result: package groups alphabetical, Local last
  const result: { name: string; skills: typeof skills }[] = [];
  const pkgNames = [...groupMap.keys()].sort();
  for (const name of pkgNames) {
    result.push({ name, skills: groupMap.get(name)! });
  }
  if (localSkills.length > 0) {
    result.push({ name: "Local", skills: localSkills });
  }

  return result;
}

/**
 * Parse a single skill from a SKILL.md file's content.
 * Returns null if the content is invalid (empty body).
 */
export function parseSkillContent(
  content: string,
  dirnamePath: string,
): { name: string; description: string; trigger: "auto" | "manual" } | null {
  try {
    const { fields } = parseFrontmatter(content);

    const name = fields.get("name") || dirnamePath;
    const description = fields.get("description") || "";
    const trigger = isManualTrigger(fields) ? "manual" : "auto";

    return { name, description, trigger };
  } catch {
    return null;
  }
}
