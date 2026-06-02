/**
 * Pure utility functions for plan-mode bash blacklist.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBlacklistedCommand } from "./utils.ts";

describe("isBlacklistedCommand", () => {
  describe("file modification patterns", () => {
    const blocked = [
      // Redirect write
      ['echo "x" > file.ts', "redirect write"],
      ['echo "x" >> file.ts', "redirect append"],
      // In-place edit
      ["sed -i 's/a/b/' file.ts", "sed in-place"],
      ['sed -i.bak "s/a/b/" file.ts', "sed in-place with backup"],
      // Deletion
      ["rm file.ts", "rm file"],
      ["rm -rf node_modules", "rm recursive"],
      ["rmdir foo", "rmdir"],
      // Move/rename
      ["mv old.ts new.ts", "mv"],
      // Create
      ["touch newfile.ts", "touch"],
      ["mkdir foo", "mkdir"],
      // tee
      ['echo "x" | tee file.ts', "tee"],
      ["tee file.ts", "tee alone"],
      // Git destructive
      ["git checkout -- file.ts", "git checkout file"],
      ["git reset --hard", "git reset hard"],
      ["git stash", "git stash"],
      ["git clean -fd", "git clean"],
      ["git restore file.ts", "git restore"],
      ["git rebase main", "git rebase"],
      ["git revert HEAD", "git revert"],
      // dd, shred, truncate
      ["dd if=/dev/zero of=file", "dd"],
      ["shred file", "shred"],
      ["truncate -s 0 file", "truncate"],
      // chmod, chown
      ["chmod +x script.sh", "chmod"],
      ["chown user file", "chown"],
      // ln
      ["ln -s target link", "ln symlink"],
      // Package install
      ["npm install lodash", "npm install"],
      ["npm uninstall lodash", "npm uninstall"],
      ["npm update", "npm update"],
      ["npm ci", "npm ci"],
      ["yarn add lodash", "yarn add"],
      ["pnpm add lodash", "pnpm add"],
      ["pip install requests", "pip install"],
      ["apt-get install vim", "apt install"],
      ["brew install wget", "brew install"],
      // Editors
      ["vim file.ts", "vim"],
      ["nano file.ts", "nano"],
      ["code .", "code"],
      // Sudo/su
      ["sudo ls", "sudo"],
      ["su root", "su"],
      // Process kill
      ["kill 1234", "kill"],
      ["pkill node", "pkill"],
    ];

    for (const [command, label] of blocked) {
      it(`blocks: ${label}`, () => {
        assert.strictEqual(isBlacklistedCommand(command as string), true, `"${command}" should be blacklisted`);
      });
    }
  });

  describe("safe read-only patterns", () => {
    const allowed = [
      // Read-only file ops
      ["cat file.ts", "cat"],
      ["head file.ts", "head"],
      ["tail -f log", "tail"],
      ["less file.ts", "less"],
      // Search
      ["grep -r 'foo' src/", "grep"],
      ["rg 'foo' src/", "rg"],
      ["find . -name '*.ts'", "find"],
      ["fd 'test'", "fd"],
      ["ls -la", "ls"],
      ["tree src/", "tree"],
      // Info
      ["pwd", "pwd"],
      ["echo hello", "echo safe"],
      ["wc -l file.ts", "wc"],
      ["sort file.txt", "sort"],
      ["uniq file.txt", "uniq"],
      ["diff a.ts b.ts", "diff"],
      ["file program", "file"],
      ["stat file.ts", "stat"],
      ["du -sh .", "du"],
      ["df -h", "df"],
      ["which node", "which"],
      ["env", "env"],
      ["uname -a", "uname"],
      ["whoami", "whoami"],
      ["id", "id"],
      ["date", "date"],
      ["uptime", "uptime"],
      ["ps aux", "ps"],
      ["free -h", "free"],
      // Git read-only
      ["git status", "git status"],
      ["git log --oneline", "git log"],
      ["git diff", "git diff"],
      ["git show HEAD", "git show"],
      ["git branch", "git branch list"],
      ["git remote -v", "git remote"],
      ["git config --get user.name", "git config get"],
      ["git ls-files", "git ls-files"],
      // Package read-only
      ["npm list", "npm list"],
      ["npm view lodash", "npm view"],
      ["npm outdated", "npm outdated"],
      ["yarn info lodash", "yarn info"],
      ["pnpm list", "pnpm list"],
      // Network
      ["curl https://example.com", "curl"],
      ["wget -qO- https://example.com", "wget to stdout"],
      // Pipes and jq
      ["cat file | jq .", "jq"],
      ["awk '{print $1}' file", "awk"],
      // Ripgrep/fd with options
      ["rg -l 'TODO'", "rg list files"],
      ["fd -e ts", "fd extension"],
      // node/python version
      ["node --version", "node version"],
      ["python --version", "python version"],
      ["npm --version", "npm version"],
      ["git --version", "git version"],
      // eza/bat (modern ls/cat)
      ["bat file.ts", "bat"],
      ["eza -la", "eza"],
    ];

    for (const [command, label] of allowed) {
      it(`allows: ${label}`, () => {
        assert.strictEqual(isBlacklistedCommand(command as string), false, `"${command}" should be allowed`);
      });
    }
  });

  describe("edge cases", () => {
    it("allows echo containing blocked keyword", () => {
      assert.strictEqual(isBlacklistedCommand('echo "use rm -rf to delete"'), false);
    });

    it("blocks tee even in pipe chain", () => {
      assert.strictEqual(isBlacklistedCommand("cat file | tee output.txt | grep foo"), true);
    });

    it("allows git status --porcelain", () => {
      assert.strictEqual(isBlacklistedCommand("git status --porcelain"), false);
    });

    it("allows empty command", () => {
      assert.strictEqual(isBlacklistedCommand(""), false);
    });

    it("allows multi-line with safe commands", () => {
      assert.strictEqual(isBlacklistedCommand("cd src && ls"), false);
    });

    it("blocks multi-line with rm", () => {
      assert.strictEqual(isBlacklistedCommand("cd src && rm file.ts"), true);
    });
  });
});
