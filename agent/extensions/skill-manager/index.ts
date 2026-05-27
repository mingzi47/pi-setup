/**
 * Skill Manager Extension
 *
 * Provides a /skills command to manage skill trigger modes (auto/manual)
 * and visibility (visible/hidden per package).
 *
 * Usage:
 *   /skills  - Open interactive skill manager with two tabs:
 *              Tab 1: Trigger (auto/manual for all skills)
 *              Tab 2: Visibility (+/- filter per package skill)
 *
 * Trigger modes:
 *   - "auto"   (default): Skill appears in system prompt, LLM loads it automatically
 *   - "manual" : Skill hidden from system prompt, invoked via /skill:name only
 *
 * Visibility modes:
 *   - no entry       = default visible
 *   - "-path"        = hidden
 *   - "+path"        = force visible
 *   Cycle: none → "-" → "+" → "-" (never returns to "none" once touched)
 *
 * The extension modifies disable-model-invocation in each SKILL.md frontmatter
 * for trigger, and skills filter array in settings.json for visibility.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  relative,
} from "node:path";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  parseFrontmatter,
  isManualTrigger,
  matchesSkillFilter,
  toggleSkillVisibility,
  getSkillVisibilityEntry,
  updateSkillFilterArray,
  groupSkillsByPackage,
} from "./helpers";

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillInfo {
  /** Unique identifier (name from frontmatter, falls back to dir name) */
  name: string;
  /** Full path to the SKILL.md file */
  path: string;
  /** Human-readable directory (relative to home if possible) */
  location: string;
  /** Current trigger mode */
  trigger: "auto" | "manual";
  /** Description from frontmatter */
  description: string;
  /** Package source this skill belongs to, or undefined for local skills */
  packageSource?: string;
  /** Skill path relative to the package root */
  packageRelPath?: string;
}

interface PackageSkillConfig {
  /** Absolute path to the skills directory inside the package */
  skillsDir: string;
  /** Package source string (e.g., "git:github.com/user/repo") */
  source: string;
  /** Skills filter from settings.json package entry */
  skillFilters?: string[];
  /** Path to the settings.json that defined this package */
  settingsPath: string;
}

interface SkillGroup {
  name: string;
  skills: SkillInfo[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Toggle disable-model-invocation in a SKILL.md file.
 * Returns true if the file was modified.
 */
function setSkillTrigger(filePath: string, manual: boolean): boolean {
  const content = readFileSync(filePath, "utf-8");
  const { fields } = parseFrontmatter(content);

  const currentlyManual = isManualTrigger(fields);
  if (currentlyManual === manual) return false;

  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return false;

  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endIdx === -1) return false;

  const disableLineIdx = lines.findIndex(
    (l, i) => i > 0 && i < endIdx && /^\s*disable-model-invocation\s*:/.test(l),
  );

  if (manual) {
    if (disableLineIdx === -1) {
      lines.splice(endIdx, 0, "disable-model-invocation: true");
    } else {
      lines[disableLineIdx] = "disable-model-invocation: true";
    }
  } else {
    if (disableLineIdx !== -1) {
      lines.splice(disableLineIdx, 1);
    }
  }

  writeFileSync(filePath, lines.join("\n"), "utf-8");
  return true;
}

/**
 * Read installed packages from settings.json and resolve their skills directories
 * with any per-package skill filters.
 */
function getPackageSkillConfigs(home: string, settingsPaths: string[]): PackageSkillConfig[] {
  const configs: PackageSkillConfig[] = [];

  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const packages: (string | { source: string; skills?: string[] })[] =
        settings.packages || [];
      for (const pkg of packages) {
        const source = typeof pkg === "string" ? pkg : pkg.source;
        const filters = typeof pkg === "string" ? undefined : pkg.skills;

        let normalized = source;
        if (normalized.startsWith("git:")) normalized = normalized.slice(4);

        // Strip @ref suffix
        const refMatch = normalized.match(/@([^/]+)$/);
        if (refMatch) normalized = normalized.slice(0, normalized.length - refMatch[0].length);

        // npm packages
        if (source.startsWith("npm:")) {
          const name = source.slice(4).replace(/@[\d.]+$/, "");
          const pkgPath = join(home, ".pi/agent/npm", name);
          const skillsDir = join(pkgPath, "skills");
          if (existsSync(skillsDir)) {
            configs.push({ skillsDir, source, skillFilters: filters, settingsPath });
          }
          continue;
        }

        // git packages
        if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/[^/]+\/[^/]+$/.test(normalized)) {
          normalized = `https://${normalized}`;
        }
        if (normalized.startsWith("git@")) {
          normalized = normalized.replace(/^git@/, "").replace(":", "/");
        }

        try {
          const url = new URL(normalized);
          const pkgPath = join(home, ".pi/agent/git", url.hostname, url.pathname.replace(/\.git$/, ""));
          const skillsDir = join(pkgPath, "skills");
          if (existsSync(skillsDir)) {
            configs.push({ skillsDir, source, skillFilters: filters, settingsPath });
          }
        } catch {
          const parts = normalized.split("/");
          if (parts.length >= 3 && parts[0].includes(".") && !parts[0].startsWith("/")) {
            const pkgPath = join(home, ".pi/agent/git", ...parts).replace(/\.git$/, "");
            const skillsDir = join(pkgPath, "skills");
            if (existsSync(skillsDir)) {
              configs.push({ skillsDir, source, skillFilters: filters, settingsPath });
            }
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return configs;
}

/**
 * Read the skills filter array for a package from settings.json.
 */
function readPackageSkillFilters(
  settingsPaths: string[],
  packageSource: string,
): string[] | undefined {
  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;
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
          return undefined;
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return undefined;
}

/**
 * Write a skills filter array for a package to settings.json.
 * Uses the first settings path (user settings) for writes.
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

  const pkgIdx = settings.packages.findIndex((p) => {
    const src = typeof p === "string" ? p : p.source;
    return src === packageSource;
  });

  if (pkgIdx === -1) {
    settings.packages.push({ source: packageSource, skills: filters });
  } else {
    const existing = settings.packages[pkgIdx];
    if (typeof existing === "string") {
      settings.packages[pkgIdx] = { source: packageSource, skills: filters };
    } else {
      settings.packages[pkgIdx] = { ...existing, skills: filters };
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Discover all skills from known locations.
 */
function discoverSkills(settingsPaths: string[]): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const home = homedir();
  const seen = new Set<string>();

  // Local skill directories (no filters apply)
  const localDirs = [
    join(home, ".pi/agent/skills"),
    join(home, ".agents/skills"),
  ];

  try {
    const cwd = process.cwd();
    const cwdSkills = join(cwd, ".pi/skills");
    if (existsSync(cwdSkills)) localDirs.push(cwdSkills);
    const cwdAgents = join(cwd, ".agents/skills");
    if (existsSync(cwdAgents)) localDirs.push(cwdAgents);
  } catch {
    // ignore
  }

  for (const dir of localDirs) {
    if (!existsSync(dir)) continue;
    try {
      scanDirectory(dir, dir, skills, seen, home, undefined, undefined);
    } catch {
      // ignore permission errors
    }
  }

  // Scan package skill directories with filter support
  const pkgConfigs = getPackageSkillConfigs(home, settingsPaths);
  for (const config of pkgConfigs) {
    if (!existsSync(config.skillsDir)) continue;
    try {
      // Always scan all skills regardless of filter settings.
      // The Visibility tab independently reads skillFilters from settings.json
      // and shows the current visibility state, so the manager must show ALL
      // available skills to let the user toggle them.
      // parseSkill (called by scanDirectory) already sets packageRelPath
      // when packageSource and skillsDir are provided.
      scanDirectory(config.skillsDir, config.skillsDir, skills, seen, home, config.source, config.skillsDir);
    } catch {
      // ignore permission errors
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function scanDirectory(
  baseDir: string,
  dir: string,
  skills: SkillInfo[],
  seen: Set<string>,
  home: string,
  packageSource?: string,
  skillsDir?: string,
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
        const info = parseSkill(skillMd, home, packageSource, skillsDir);
        if (info) skills.push(info);
      }
      scanDirectory(baseDir, fullPath, skills, seen, home, packageSource, skillsDir);
    } else if (st.isFile() && entry.endsWith(".md") && !seen.has(fullPath)) {
      if (
        basename(dirname(fullPath)) === "skills" ||
        basename(dirname(fullPath)) === "SKILL.md"
      ) {
        if (dir.endsWith(".agents/skills")) continue;
        seen.add(fullPath);
        const info = parseSkill(fullPath, home, packageSource, skillsDir);
        if (info) skills.push(info);
      }
    }
  }
}

function parseSkill(
  skillMdPath: string,
  home: string,
  packageSource?: string,
  skillsDir?: string,
): SkillInfo | null {
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

    // Compute package-relative path
    let packageRelPath: string | undefined;
    if (packageSource && skillsDir) {
      const pkgRoot = dirname(skillsDir);
      packageRelPath = relative(pkgRoot, dirname(skillMdPath));
    }

    return { name, path: skillMdPath, location, trigger, description, packageSource, packageRelPath };
  } catch {
    return null;
  }
}

// ── Trigger State Persistence ─────────────────────────────────────────────────

const TRIGGERS_FILE = join(homedir(), ".pi/agent", "skill-triggers.json");

interface TriggerState {
  version: number;
  triggers: Record<string, "auto" | "manual">;
}

function loadTriggerStates(): TriggerState {
  try {
    if (existsSync(TRIGGERS_FILE)) {
      const raw = JSON.parse(readFileSync(TRIGGERS_FILE, "utf-8"));
      if (raw && typeof raw.triggers === "object") {
        return { version: raw.version || 1, triggers: raw.triggers };
      }
    }
  } catch {
    // ignore corrupt file
  }
  return { version: 1, triggers: {} };
}

function saveTriggerState(skillPath: string, trigger: "auto" | "manual"): void {
  const state = loadTriggerStates();
  const home = homedir();
  const relPath = skillPath.startsWith(home) ? skillPath.slice(home.length + 1) : skillPath;
  state.triggers[relPath] = trigger;
  try {
    writeFileSync(TRIGGERS_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // silently ignore write failures
  }
}

function restoreTriggersFromState(): number {
  const state = loadTriggerStates();
  if (Object.keys(state.triggers).length === 0) return 0;

  let restored = 0;
  let hasOrphans = false;
  const home = homedir();

  for (const [relPath, desiredTrigger] of Object.entries(state.triggers)) {
    const skillPath = join(home, relPath);
    if (!existsSync(skillPath)) {
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

  if (hasOrphans) {
    try {
      writeFileSync(TRIGGERS_FILE, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // silently ignore
    }
  }

  return restored;
}

// ── Settings Paths ────────────────────────────────────────────────────────────

function getSettingsPaths(): string[] {
  const home = homedir();
  const paths = [join(home, ".pi/agent/settings.json")];
  try {
    const projectSettings = join(process.cwd(), ".pi/settings.json");
    if (existsSync(projectSettings)) paths.push(projectSettings);
  } catch {
    // ignore
  }
  return paths;
}

function getUserSettingsPath(): string {
  return join(homedir(), ".pi/agent/settings.json");
}

// ── TUI Components ───────────────────────────────────────────────────────────

/**
 * How a skill's visibility is displayed in the UI.
 */
type VisibilityLabel = "visible" | "hidden" | "forced";

/**
 * Full skill manager with two tabs.
 */
class SkillManagerComponent {
  private container: Container;
  private theme: Theme;
  private activeTab: 0 | 1 = 0;
  private triggerTab: TriggerTabComponent;
  private visibilityTab: VisibilityTabComponent;
  private onClose: () => void;

  constructor(
    skills: SkillInfo[],
    pkgConfigs: PackageSkillConfig[],
    theme: Theme,
    settingsPaths: string[],
    onToggle: (skill: SkillInfo, newTrigger: "auto" | "manual") => void,
    onVisibilityToggle: (skill: SkillInfo, filters: string[], newFilters: string[]) => void,
    onSaveVisibility: (dirtyPkgs: Set<string>) => void,
    onClose: () => void,
  ) {
    this.theme = theme;
    this.onClose = onClose;
    this.container = new Container();

    // Build groups for visibility tab (all skills)
    const allGroups = groupSkillsByPackage(skills, pkgConfigs);

    // Build filtered groups for trigger tab (exclude hidden skills).
    // A skill is hidden if its package has a skills: filter in settings.json
    // and the skill does not match. Local skills are always visible.
    const triggerGroups = allGroups
      .map((group) => ({
        name: group.name,
        skills: group.skills.filter((skill) => {
          if (!skill.packageSource || !skill.packageRelPath) return true;
          const filters = readPackageSkillFilters(
            settingsPaths,
            skill.packageSource,
          );
          if (filters === undefined) return true;
          return matchesSkillFilter(skill.packageRelPath, filters);
        }),
      }))
      .filter((group) => group.skills.length > 0);

    this.triggerTab = new TriggerTabComponent(triggerGroups, theme, onToggle);
    this.visibilityTab = new VisibilityTabComponent(
      allGroups.filter((g) => g.name !== "Local"),
      pkgConfigs,
      theme,
      settingsPaths,
      onVisibilityToggle,
      onSaveVisibility,
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      // Check for unsaved visibility changes
      this.visibilityTab.handleTabSwitch();
      this.onClose();
      return;
    }

    if (matchesKey(data, "left")) {
      this.activeTab = 0;
      this.visibilityTab.handleTabSwitch();
      return;
    }

    if (matchesKey(data, "right")) {
      this.visibilityTab.handleTabSwitch();
      this.activeTab = 1;
      return;
    }

    if (this.activeTab === 0) {
      this.triggerTab.handleInput(data);
    } else {
      this.visibilityTab.handleInput(data);
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    // Tab bar
    const tabWidth = Math.floor(width / 2) - 2;
    const triggerLabel = " Trigger (auto/manual) ";
    const visLabel = " Visibility (+/-) ";

    const triggerTab = this.activeTab === 0
      ? th.bg("selectedBg", th.fg("text", th.bold(triggerLabel.padEnd(tabWidth))))
      : th.fg("muted", triggerLabel.padEnd(tabWidth));

    const visTab = this.activeTab === 1
      ? th.bg("selectedBg", th.fg("text", th.bold(visLabel.padEnd(tabWidth))))
      : th.fg("muted", visLabel.padEnd(tabWidth));

    lines.push(` ${triggerTab} ${visTab}`);
    lines.push(th.fg("borderMuted", "─".repeat(width)));

    // Tab content
    if (this.activeTab === 0) {
      lines.push(...this.triggerTab.render(width));
    } else {
      lines.push(...this.visibilityTab.render(width));
    }

    // Footer
    lines.push("");
    lines.push(th.fg("dim", " ←→ tab   ↑↓ navigate   Enter toggle   Space collapse/expand   Esc close"));

    return lines;
  }

  invalidate(): void {
    this.container.invalidate();
  }
}

/**
 * Collapsible group list component.
 */
class CollapsibleGroupList {
  private selectedGroupIdx = 0;
  private selectedItemIdx = 0;
  private theme: Theme;
  private collapsed: Set<string>;
  private onToggle: (skill: SkillInfo, groupIdx: number, itemIdx: number) => void;
  private getLabel: (skill: SkillInfo) => string;
  private getDisplayValue: (skill: SkillInfo) => string;
  private getUnsavedForGroup?: (groupName: string) => boolean;
  private groups: SkillGroup[];

  constructor(
    groups: SkillGroup[],
    theme: Theme,
    onToggle: (skill: SkillInfo, groupIdx: number, itemIdx: number) => void,
    getLabel: (skill: SkillInfo) => string,
    getDisplayValue: (skill: SkillInfo) => string,
    getUnsavedForGroup?: (groupName: string) => boolean,
  ) {
    this.groups = groups;
    this.theme = theme;
    this.collapsed = new Set<string>();
    this.onToggle = onToggle;
    this.getLabel = getLabel;
    this.getDisplayValue = getDisplayValue;
    this.getUnsavedForGroup = getUnsavedForGroup;
  }

  /** Convert (groupIdx, itemIdx) to flat index and vice versa */
  private flatIndex(): number {
    let flat = 0;
    for (let g = 0; g < this.selectedGroupIdx; g++) {
      flat++; // group header
      if (!this.collapsed.has(this.groups[g].name)) {
        flat += this.groups[g].skills.length;
      }
    }
    flat++; // current group header
    flat += this.selectedItemIdx;
    return flat;
  }

  private fromFlatIndex(flatIdx: number): { groupIdx: number; itemIdx: number; isHeader: boolean } {
    let remaining = flatIdx;
    for (let g = 0; g < this.groups.length; g++) {
      if (remaining === 0) return { groupIdx: g, itemIdx: 0, isHeader: true };
      remaining--;
      if (this.collapsed.has(this.groups[g].name)) continue;
      if (remaining < this.groups[g].skills.length + 1) {
        return { groupIdx: g, itemIdx: remaining, isHeader: false };
      }
      remaining -= this.groups[g].skills.length;
    }
    return { groupIdx: 0, itemIdx: 0, isHeader: false };
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      const flat = this.flatIndex();
      if (flat > 0) {
        const { groupIdx, itemIdx, isHeader } = this.fromFlatIndex(flat - 1);
        this.selectedGroupIdx = groupIdx;
        this.selectedItemIdx = isHeader ? -1 : itemIdx;
      }
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      const totalFlat = this.totalFlatItems();
      const flat = this.flatIndex();
      if (flat < totalFlat - 1) {
        const { groupIdx, itemIdx, isHeader } = this.fromFlatIndex(flat + 1);
        this.selectedGroupIdx = groupIdx;
        this.selectedItemIdx = isHeader ? -1 : itemIdx;
      }
      return;
    }

    if (matchesKey(data, "space") || matchesKey(data, " ")) {
      const group = this.groups[this.selectedGroupIdx];
      if (group) {
        const name = group.name;
        if (this.collapsed.has(name)) {
          this.collapsed.delete(name);
        } else {
          this.collapsed.add(name);
        }
      }
      return;
    }

    if (matchesKey(data, "enter")) {
      const group = this.groups[this.selectedGroupIdx];
      if (!group || !group.skills[this.selectedItemIdx]) return;
      this.onToggle(group.skills[this.selectedItemIdx], this.selectedGroupIdx, this.selectedItemIdx);
      return;
    }
  }

  private totalFlatItems(): number {
    let total = 0;
    for (const group of this.groups) {
      total++; // header
      if (!this.collapsed.has(group.name)) {
        total += group.skills.length;
      }
    }
    return total;
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    for (let g = 0; g < this.groups.length; g++) {
      const group = this.groups[g];
      const isGroupSelected = g === this.selectedGroupIdx && this.selectedItemIdx === -1;
      const collapsed = this.collapsed.has(group.name);
      const chevron = collapsed ? "▶" : "▼";

      // Unsaved indicator
      let unsavedMark = "";
      if (this.getUnsavedForGroup?.(group.name)) {
        unsavedMark = th.fg("warning", " *");
      }

      // Group header
      const countStr = `(${group.skills.length})`;
      const header = ` ${chevron} ${group.name} ${countStr}${unsavedMark}`;
      if (isGroupSelected) {
        lines.push(th.bg("selectedBg", th.fg("text", header.padEnd(width))));
      } else {
        lines.push(th.fg("accent", th.bold(header)));
      }

      // Skills
      if (!collapsed) {
        for (let i = 0; i < group.skills.length; i++) {
          const skill = group.skills[i];
          const isSelected = g === this.selectedGroupIdx && i === this.selectedItemIdx;
          const label = this.getLabel(skill);
          const value = this.getDisplayValue(skill);

          const line = `   ${label.padEnd(Math.max(20, width - 30))} ${value}`;
          if (isSelected) {
            lines.push(th.bg("selectedBg", th.fg("text", line.padEnd(width))));
          } else {
            lines.push(th.fg("text", line));
          }
        }
      }
    }

    return lines;
  }
}

/**
 * Trigger tab: manage auto/manual for all skills.
 */
class TriggerTabComponent {
  private list: CollapsibleGroupList;

  constructor(
    groups: SkillGroup[],
    theme: Theme,
    onToggle: (skill: SkillInfo, newTrigger: "auto" | "manual") => void,
  ) {
    this.list = new CollapsibleGroupList(
      groups,
      theme,
      (skill) => {
        const newTrigger = skill.trigger === "auto" ? "manual" : "auto";
        onToggle(skill, newTrigger);
      },
      (skill) => skill.name,
      (skill) => skill.trigger,
    );
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return this.list.render(width);
  }
}

/**
 * Visibility tab: manage +/- per package skill.
 */
class VisibilityTabComponent {
  private list: CollapsibleGroupList;
  private groups: SkillGroup[];
  private pkgConfigs: PackageSkillConfig[];
  private theme: Theme;
  private settingsPaths: string[];
  private onVisibilityToggle: (skill: SkillInfo, filters: string[], newFilters: string[]) => void;
  private onSaveVisibility: (dirtyPkgs: Set<string>) => void;
  /** Track which packages have dirty (unsaved) visibility changes */
  private dirtyPkgs = new Set<string>();
  /** Local copy of filters per package for editing before save */
  private editFilters = new Map<string, string[]>();

  constructor(
    groups: SkillGroup[],
    pkgConfigs: PackageSkillConfig[],
    theme: Theme,
    settingsPaths: string[],
    onVisibilityToggle: (skill: SkillInfo, filters: string[], newFilters: string[]) => void,
    onSaveVisibility: (dirtyPkgs: Set<string>) => void,
  ) {
    this.groups = groups;
    this.pkgConfigs = pkgConfigs;
    this.theme = theme;
    this.settingsPaths = settingsPaths;
    this.onVisibilityToggle = onVisibilityToggle;
    this.onSaveVisibility = onSaveVisibility;

    // Initialize edit filters from settings.json
    for (const group of groups) {
      const skill = group.skills[0];
      if (!skill || !skill.packageSource) continue;

      const config = pkgConfigs.find((c) => c.source === skill.packageSource);
      if (!config) continue;

      const currentFilters = readPackageSkillFilters(settingsPaths, config.source);
      // If skills: [] (empty array), initialize all as -path
      if (currentFilters !== undefined && currentFilters.length === 0) {
        const allHidden = group.skills.map((s) => `-${s.packageRelPath}`);
        this.editFilters.set(config.source, allHidden);
      } else if (currentFilters !== undefined) {
        this.editFilters.set(config.source, [...currentFilters]);
      } else {
        this.editFilters.set(config.source, []);
      }
    }

    this.list = new CollapsibleGroupList(
      groups,
      theme,
      (skill) => {
        if (!skill.packageSource || !skill.packageRelPath) return;

        const config = pkgConfigs.find((c) => c.source === skill.packageSource);
        if (!config) return;

        const currentFilters = this.editFilters.get(config.source) || [];
        const currentEntry = getSkillVisibilityEntry(skill.packageRelPath, currentFilters);
        const newEntry = toggleSkillVisibility(currentEntry, skill.packageRelPath);
        const newFilters = updateSkillFilterArray(skill.packageRelPath, currentFilters, newEntry);

        this.editFilters.set(config.source, newFilters);
        this.dirtyPkgs.add(config.source);
        this.onVisibilityToggle(skill, currentFilters, newFilters);
      },
      (skill) => {
        let label = skill.name;
        // Find any unsaved change for this skill's package
        if (skill.packageSource && this.dirtyPkgs.has(skill.packageSource)) {
          label = `*${label}`;
        }
        return label;
      },
      (skill) => {
        if (!skill.packageSource || !skill.packageRelPath) return "local";
        const config = this.pkgConfigs.find((c) => c.source === skill.packageSource);
        if (!config) return "local";

        const currentFilters = this.editFilters.get(config.source) || [];
        const entry = getSkillVisibilityEntry(skill.packageRelPath, currentFilters);

        if (!entry) return "visible";
        if (entry.startsWith("+")) return "forced";
        return "hidden";
      },
      (groupName) => {
        // Check if any skill in this group belongs to a dirty package
        const group = this.groups.find((g) => g.name === groupName);
        if (!group) return false;
        return group.skills.some(
          (s) => s.packageSource && this.dirtyPkgs.has(s.packageSource),
        );
      },
    );
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  handleTabSwitch(): void {
    if (this.dirtyPkgs.size > 0) {
      this.onSaveVisibility(this.dirtyPkgs);

      // Write to the correct settings.json (user or project) per package
      for (const pkgSource of this.dirtyPkgs) {
        const filters = this.editFilters.get(pkgSource);
        if (filters !== undefined) {
          const config = this.pkgConfigs.find((c) => c.source === pkgSource);
          const settingsPath = config?.settingsPath || getUserSettingsPath();
          writePackageSkillFilters(settingsPath, pkgSource, filters);
        }
      }

      this.dirtyPkgs.clear();
    }
  }

  render(width: number): string[] {
    return this.list.render(width);
  }
}

// ── Extension Entry Point ────────────────────────────────────────────────────

export default function skillManager(pi: ExtensionAPI) {
  let modified = false;

  function getSettings(): string[] {
    return getSettingsPaths();
  }

  function refreshSkills(): SkillInfo[] {
    return discoverSkills(getSettings());
  }

  function toggleSkill(skill: SkillInfo, newTrigger: "auto" | "manual"): boolean {
    const manual = newTrigger === "manual";
    const changed = setSkillTrigger(skill.path, manual);
    if (changed) {
      modified = true;
      skill.trigger = newTrigger;
      saveTriggerState(skill.path, newTrigger);
    }
    return changed;
  }

  // ── /skills command ────────────────────────────────────────────────────

  pi.registerCommand("skills", {
    description: "Manage skill trigger modes (auto/manual) and visibility (+/-)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/skills requires interactive mode.", "error");
        return;
      }

      const settingsPaths = getSettings();
      const skills = refreshSkills();
      const pkgConfigs = getPackageSkillConfigs(homedir(), settingsPaths);

      if (skills.length === 0) {
        ctx.ui.notify("No skills found. Use pi install to add skill packages, or create local skills.", "info");
        return;
      }

      modified = false;

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new SkillManagerComponent(
          skills,
          pkgConfigs,
          theme,
          settingsPaths,
          (skill, newTrigger) => {
            const changed = toggleSkill(skill, newTrigger);
            if (changed) {
              ctx.ui.notify(`${skill.name}: → ${newTrigger}`, "info");
            }
          },
          (_skill, _oldFilters, _newFilters) => {
            // Individual visibility toggle - just track dirty state in component
          },
          (dirtyPkgs) => {
            // Save triggered by tab switch
            const pkgList = [...dirtyPkgs].join(", ");
            ctx.ui.notify(`Visibility updated for: ${pkgList}. Reloading...`, "info");
            // Reload will be triggered after UI closes
          },
          () => {
            done();
          },
        );
      });

      // Reload if anything was modified
      if (modified || true) {
        // Always reload when closing skills manager (visibility changes need it)
        ctx.ui.notify("Reloading skills...", "info");
        await ctx.reload();
      }
    },
  });

  // ── Startup widget ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Restore trigger preferences from persistent state
    const startupRestored = restoreTriggersFromState();
    if (startupRestored > 0) {
      try {
        await ctx.reload();
      } catch {
        // reload is best-effort on startup
      }
    }

    const allSkills = discoverSkills(getSettings());
    const settingsPaths = getSettings();

    // Only count visible skills (not hidden by skills: filter in settings.json)
    const visibleSkills = allSkills.filter((s) => {
      if (!s.packageSource || !s.packageRelPath) return true;
      const filters = readPackageSkillFilters(settingsPaths, s.packageSource);
      if (filters === undefined) return true;
      return matchesSkillFilter(s.packageRelPath, filters);
    });

    if (visibleSkills.length === 0) {
      ctx.ui.setWidget("skill-manager", [
        "No visible skills. Use /skills to manage visibility.",
      ]);
    } else {
      const autoCount = visibleSkills.filter((s) => s.trigger === "auto").length;
      const manualCount = visibleSkills.filter((s) => s.trigger === "manual").length;
      ctx.ui.setWidget("skill-manager", [
        `Skills: ${autoCount} auto, ${manualCount} manual | /skills to manage`,
      ]);
    }
  });
}
