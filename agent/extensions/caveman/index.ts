/**
 * Caveman Extension — always-on token-compressed communication mode.
 *
 * Injects per-turn caveman rules in the user's language (Chinese or English).
 * No toggle. No command. Always active.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectLanguage } from "./detect.ts";
import { getCavemanRules } from "./rules.ts";

export default function cavemanExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const lang = detectLanguage(event.prompt);
    const rules = getCavemanRules(lang);

    return {
      message: {
        customType: "caveman-rules",
        content: rules,
        display: false,
      },
    };
  });
}
