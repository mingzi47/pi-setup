/**
 * Integration tests for plan-mode extension.
 * Tests behavior through the public ExtensionAPI interface.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import planModeExtension from "./index.ts";

// ---------------------------------------------------------------------------
// Test helpers - lightweight ExtensionAPI mock
// ---------------------------------------------------------------------------

interface CapturedCommand {
  name: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function createMockExtensionAPI() {
  const commands: CapturedCommand[] = [];
  const eventHandlers: Map<string, Array<(...args: unknown[]) => unknown>> = new Map();
  const entries: unknown[] = [];
  let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  let thinkingLevel: string = "off";

  const mockCtx = {
    ui: {
      setStatus: mock.fn(),
      notify: mock.fn(),
      theme: {
        fg: (_color: string) => (s: string) => s,
      },
    },
    sessionManager: {
      getEntries: () => entries,
    },
  };

  const pi = {
    registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.push({ name, handler: options.handler });
    },
    registerShortcut: mock.fn(),
    registerFlag: mock.fn(),
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    getActiveTools(): string[] {
      return [...activeTools];
    },
    getAllTools(): Array<string | { name: string }> {
      return ["read", "bash", "edit", "write", "grep", "find", "ls"];
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    appendEntry: mock.fn(),
    getFlag: mock.fn(() => undefined),

    // Expose captured state
    _commands: commands,
    _eventHandlers: eventHandlers,
    _activeTools: () => activeTools,
    _thinkingLevel: () => thinkingLevel,
    _entries: entries,
    _ctx: mockCtx,
  };

  return pi;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plan-mode extension", () => {
  function getPlanCommand(pi: ReturnType<typeof createMockExtensionAPI>) {
    const cmd = pi._commands.find((c) => c.name === "plan");
    assert.ok(cmd, "/plan command should be registered");
    return cmd;
  }

  describe("entering plan mode via /plan", () => {
    it("disables edit and write, keeps other tools", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);

      const planCommand = getPlanCommand(pi);
      await planCommand.handler("", pi._ctx);

      const tools = pi._activeTools();
      assert.ok(tools.includes("read"), "read should remain active");
      assert.ok(tools.includes("bash"), "bash should remain active");
      assert.ok(!tools.includes("edit"), "edit should be disabled");
      assert.ok(!tools.includes("write"), "write should be disabled");
      assert.strictEqual(pi._thinkingLevel(), "xhigh", "thinking should be xhigh");
    });
  });

  describe("exiting plan mode via /plan", () => {
    it("restores previous tools and thinking level", async () => {
      const pi = createMockExtensionAPI();
      // Simulate user had custom tools set
      pi.setActiveTools(["read", "bash", "edit", "write", "custom-tool"]);
      pi.setThinkingLevel("medium");

      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);

      // Enter plan mode
      await planCommand.handler("", pi._ctx);
      assert.strictEqual(pi._thinkingLevel(), "xhigh");

      // Exit plan mode
      await planCommand.handler("", pi._ctx);

      const tools = pi._activeTools();
      assert.ok(tools.includes("edit"), "edit should be restored");
      assert.ok(tools.includes("write"), "write should be restored");
      assert.ok(tools.includes("custom-tool"), "custom-tool should be restored");
      assert.strictEqual(pi._thinkingLevel(), "medium", "thinking should be restored");
    });

    it("clears footer status on exit", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);

      await planCommand.handler("", pi._ctx);
      await planCommand.handler("", pi._ctx);

      const setStatusCalls = pi._ctx.ui.setStatus.mock.calls.filter(
        (c: { arguments: unknown[] }) => c.arguments[0] === "plan-mode"
      );
      const lastCall = setStatusCalls[setStatusCalls.length - 1];
      assert.strictEqual(lastCall.arguments[1], undefined, "footer status should be cleared");
    });
  });

  describe("tool call interception in plan mode", () => {
    it("blocks edit tool calls", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);
      await planCommand.handler("", pi._ctx);

      const toolCallHandler = pi._eventHandlers.get("tool_call")?.[0];
      assert.ok(toolCallHandler, "tool_call handler should be registered");

      const result = await toolCallHandler({ toolName: "edit", toolCallId: "1", input: {} }, pi._ctx);
      assert.ok(result, "should return a result for edit");
      assert.strictEqual((result as { block: boolean }).block, true, "edit should be blocked");
    });

    it("blocks write tool calls", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);
      await planCommand.handler("", pi._ctx);

      const toolCallHandler = pi._eventHandlers.get("tool_call")?.[0];
      assert.ok(toolCallHandler);

      const result = await toolCallHandler({ toolName: "write", toolCallId: "2", input: {} }, pi._ctx);
      assert.ok(result, "should return a result for write");
      assert.strictEqual((result as { block: boolean }).block, true, "write should be blocked");
    });

    it("allows read, bash, grep, find, ls tool calls", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);
      await planCommand.handler("", pi._ctx);

      const toolCallHandler = pi._eventHandlers.get("tool_call")?.[0];
      assert.ok(toolCallHandler);

      for (const toolName of ["read", "bash", "grep", "find", "ls"]) {
        const result = await toolCallHandler({ toolName, toolCallId: toolName, input: {} }, pi._ctx);
        assert.strictEqual(result, undefined, `${toolName} should pass through`);
      }
    });

    it("shows notification when blocking a tool", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);
      await planCommand.handler("", pi._ctx);

      const toolCallHandler = pi._eventHandlers.get("tool_call")?.[0];
      await toolCallHandler({ toolName: "edit", toolCallId: "3", input: {} }, pi._ctx);

      const notifyCalls = pi._ctx.ui.notify.mock.calls;
      const blockNotify = notifyCalls.find(
        (c: { arguments: unknown[] }) => typeof c.arguments[0] === "string" && (c.arguments[0] as string).includes("edit")
      );
      assert.ok(blockNotify, "should notify about blocked edit");
    });

    it("does not block tools when plan mode is off", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);

      const toolCallHandler = pi._eventHandlers.get("tool_call")?.[0];
      assert.ok(toolCallHandler);

      const result = await toolCallHandler({ toolName: "edit", toolCallId: "4", input: {} }, pi._ctx);
      assert.strictEqual(result, undefined, "edit should pass through when plan mode is off");
    });
  });

  describe("context injection in plan mode", () => {
    it("injects [PLAN MODE ACTIVE] message via before_agent_start", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);
      await planCommand.handler("", pi._ctx);

      const handler = pi._eventHandlers.get("before_agent_start")?.[0];
      assert.ok(handler, "before_agent_start handler should be registered");

      const result = await handler({ prompt: "test" }, pi._ctx);
      assert.ok(result, "should return a result");
      const message = (result as { message?: { content: string } }).message;
      assert.ok(message, "should contain a message");
      assert.ok(
        message!.content.includes("[PLAN MODE ACTIVE]"),
        "message should contain [PLAN MODE ACTIVE]"
      );
    });

    it("does not inject context when plan mode is off", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);

      const handler = pi._eventHandlers.get("before_agent_start")?.[0];
      assert.ok(handler);

      const result = await handler({ prompt: "test" }, pi._ctx);
      assert.strictEqual(result, undefined, "should not inject context when plan mode is off");
    });
  });

  describe("state persistence", () => {
    it("saves state via appendEntry when entering plan mode", async () => {
      const pi = createMockExtensionAPI();
      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);
      const planCommand = getPlanCommand(pi);
      await planCommand.handler("", pi._ctx);

      const appendCalls = pi.appendEntry.mock.calls;
      const planEntry = appendCalls.find(
        (c: { arguments: unknown[] }) => c.arguments[0] === "plan-mode"
      );
      assert.ok(planEntry, "should call appendEntry with plan-mode");
      assert.strictEqual((planEntry.arguments[1] as { enabled: boolean }).enabled, true, "should persist enabled=true");
    });

    it("restores plan mode state on session_start", async () => {
      const pi = createMockExtensionAPI();
      // Simulate a previous session saved plan mode state
      pi._entries.push({
        type: "custom",
        customType: "plan-mode",
        data: { enabled: true, previousTools: ["read", "bash", "edit"], previousThinkingLevel: "low" },
      });

      planModeExtension(pi as unknown as Parameters<typeof planModeExtension>[0]);

      const sessionStartHandler = pi._eventHandlers.get("session_start")?.[0];
      assert.ok(sessionStartHandler, "session_start handler should be registered");
      await sessionStartHandler({ reason: "resume" }, pi._ctx);

      // After restore, plan mode should be active
      const tools = pi._activeTools();
      assert.ok(!tools.includes("edit"), "edit should be disabled after restore");
      assert.ok(!tools.includes("write"), "write should be disabled after restore");
    });
  });
});
