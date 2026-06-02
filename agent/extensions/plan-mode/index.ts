/**
 * Plan Mode Extension
 *
 * Read-only design discussion mode. Blocks code modifications.
 * - /plan to toggle
 * - Disables edit/write (bash stays open)
 * - Sets thinking to xhigh while active
 * - Restores previous tool set and thinking level on exit
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBlacklistedCommand } from "./utils.ts";

const DISABLED_TOOLS = ["edit", "write"];

const PLAN_MODE_CONTEXT = `[PLAN MODE ACTIVE]
You are in plan mode - a read-only discussion and design exploration mode.

Restrictions:
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is available but restricted: file modification commands (rm, mv, sed -i, > redirect, etc.), git destructive operations (reset, stash, clean, checkout), package installs, editors, sudo/su are blocked
- Safe commands allowed: cat, head, tail, grep, rg, find, fd, ls, git status/log/diff, npm list/view, curl, etc.

Focus on understanding the codebase, discussing design decisions, and exploring options.
Do NOT attempt to make changes to code.`;

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let previousTools: string[] = [];
  let previousThinkingLevel: string | null = null;

  function persistState(): void {
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      previousTools,
      previousThinkingLevel,
    });
  }

  function enterPlanMode(ctx: ExtensionContext): void {
    if (planModeEnabled) return;
    planModeEnabled = true;

    // Save current state
    previousTools = pi.getActiveTools?.() ?? [];
    previousThinkingLevel = pi.getThinkingLevel?.() ?? null;

    // Restrict tools
    const restricted = previousTools.filter((name) => !DISABLED_TOOLS.includes(name));
    pi.setActiveTools(restricted);

    // Set thinking to xhigh
    pi.setThinkingLevel?.("xhigh");

    // UI
    ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "\u23F8 plan"));

    persistState();
  }

  function exitPlanMode(ctx: ExtensionContext): void {
    if (!planModeEnabled) return;
    planModeEnabled = false;

    pi.setActiveTools(previousTools);
    if (previousThinkingLevel) {
      pi.setThinkingLevel?.(previousThinkingLevel);
    }

    ctx.ui.setStatus("plan-mode", undefined);

    persistState();
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (planModeEnabled) {
      exitPlanMode(ctx);
    } else {
      enterPlanMode(ctx);
    }
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only design discussion)",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  // Block destructive tools in plan mode
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (!planModeEnabled) return;

    const toolName = (event as { toolName: string }).toolName;

    // Block edit/write tools
    if (DISABLED_TOOLS.includes(toolName)) {
      ctx.ui.notify(`Plan mode: ${toolName} blocked`, "warning");
      return {
        block: true,
        reason: `Plan mode: ${toolName} is disabled. Use /plan to exit plan mode.`,
      };
    }

    // Block blacklisted bash commands
    if (toolName === "bash") {
      const command = (event as { input: { command?: string } }).input?.command;
      if (command && isBlacklistedCommand(command)) {
        ctx.ui.notify(`Plan mode: bash command blocked`, "warning");
        return {
          block: true,
          reason: `Plan mode: this bash command is blocked in plan mode.\nCommand: ${command}\nUse /plan to exit plan mode first.`,
        };
      }
    }
  });

  // Inject plan mode context
  pi.on("before_agent_start", async () => {
    if (!planModeEnabled) return;

    return {
      message: {
        customType: "plan-mode-context",
        content: PLAN_MODE_CONTEXT,
        display: false,
      },
    };
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const planModeEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .pop() as { data?: { enabled: boolean; previousTools?: string[]; previousThinkingLevel?: string | null } } | undefined;

    if (planModeEntry?.data?.enabled) {
      planModeEnabled = true;
      previousTools = planModeEntry.data.previousTools ?? [];
      previousThinkingLevel = planModeEntry.data.previousThinkingLevel ?? null;

      const restricted = previousTools.filter((name) => !DISABLED_TOOLS.includes(name));
      pi.setActiveTools(restricted);
      pi.setThinkingLevel?.("xhigh");
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "\u23F8 plan"));
    }
  });
}
