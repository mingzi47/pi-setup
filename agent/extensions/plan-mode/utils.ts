/**
 * Pure utility functions for plan-mode bash blacklist.
 * Extracted for testability.
 */

// Anchor: match at start or after chain operators (&&, ||, ;, |)
const CMD_START = /(?:^|[;&|]\s*)(?!!)/;
// Pipe anchor: match after a pipe symbol
const PIPE = /\|\s*/;

// Patterns that block ANYWHERE (always dangerous, even as sub-command)
const GLOBAL_BLACKLIST: RegExp[] = [
  // File redirect (write/append)
  /[^<>]>(?!\s*\/dev\/null)[^>&|]/,           // > (redirect write, not >>, not >&, not |>, not =>, not /dev/null)
  />>(?!\s*\/dev\/null)/,                      // >> (redirect append, not /dev/null)
  /\|\s*tee\b/,             // | tee (always writes to files)
  /\|\s*dd\b/,              // | dd

  // Privilege escalation (always dangerous)
  /\bsudo\b/,
  /\bsu\b(?=\s)/,

  // Package install (with anchor)
  /\bnpm\s+(install|uninstall|update|ci|link|publish)\b/,
  /\byarn\s+(add|remove|upgrade|publish)\b/,
  /\bpnpm\s+(add|remove|update|publish)\b/,
  /\bpip\d*\s+(install|uninstall)\b/,
  /\bapt(?:-get)?\s+(install|remove|purge|update|upgrade)\b/,
  /\bbrew\s+(install|uninstall|upgrade|reinstall)\b/,

  // Git destructive (always dangerous regardless of position)
  /\bgit\s+checkout\b(?!\s+-\w)/,
  /\bgit\s+reset\b/,
  /\bgit\s+stash\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+restore\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+revert\b/,
  /\bgit\s+cherry-pick\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+add\b/,
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+tag\b/,
  /\bgit\s+init\b/,
  /\bgit\s+clone\b/,
];

// Patterns that only block when the command is the PRIMARY command (at start or after chain op)
const PRIMARY_COMMAND_BLACKLIST: RegExp[] = [
  // File modification commands
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b/,
  /\btouch\b/,
  /\bmkdir\b/,
  /\bcp\b/,
  /\btee\b/,
  /\bdd\b/,
  /\bshred\b/,
  /\btruncate\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bchgrp\b/,
  /\bln\b/,
  /\bsed\s+-i/,
  /\b(?:vi|vim|nano|emacs|subl|code)\b/,
  /\bkill(?:all)?\b/,
  /\bpkill\b/,
  /\bsu\b/,
];

// Wrap a pattern to match only after command-start anchor
function asPrimary(pattern: RegExp): RegExp {
  return new RegExp(CMD_START.source + pattern.source, pattern.flags);
}

export function isBlacklistedCommand(command: string): boolean {
  if (!command.trim()) return false;

  // Check global patterns (match anywhere)
  for (const pattern of GLOBAL_BLACKLIST) {
    if (pattern.test(command)) return true;
  }

  // Check primary-command patterns (must be actual command, not echo argument)
  for (const pattern of PRIMARY_COMMAND_BLACKLIST) {
    if (asPrimary(pattern).test(command)) return true;
  }

  return false;
}
