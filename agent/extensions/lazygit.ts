/**
 * Lazygit Extension
 *
 * Opens lazygit in the current directory via the /lg command.
 * The TUI suspends while lazygit runs, then restores when it exits.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("lg", {
    description: "Open lazygit in the current directory",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify?.("lazygit requires an interactive terminal", "warning");
        return;
      }

      const exitCode = await ctx.ui.custom<number | null>(
        (tui, _theme, _kb, done) => {
          // Stop pi's TUI to release the terminal
          tui.stop();

          // Run lazygit with full terminal access
          const result = spawnSync("lazygit", [], {
            stdio: "inherit",
            cwd: ctx.cwd,
            env: process.env,
          });

          // Restart pi's TUI
          tui.start();
          tui.requestRender(true);

          // Signal completion
          done(result.status);
          return { render: () => [], invalidate: () => {} };
        },
      );

      if (exitCode === 0) {
        ctx.ui.notify("lazygit exited successfully", "info");
      } else {
        ctx.ui.notify(`lazygit exited with code ${exitCode}`, "warning");
      }
    },
  });
}
