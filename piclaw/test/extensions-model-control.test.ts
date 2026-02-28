import { describe, expect, test, beforeEach } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { modelControl } from "../src/extensions/model-control.js";

// ---------------------------------------------------------------------------
// Helpers – fake ExtensionAPI and ExtensionContext
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    provider: "test-provider",
    id: "test-model",
    name: "Test Model",
    reasoning: false,
    input: ["text"],
    api: "openai-responses" as any,
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function makeReasoningModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return makeModel({ reasoning: true, id: "reasoning-model", ...overrides });
}

type ToolDef = { name: string; execute: (...args: any[]) => Promise<any> };
type HandlerEntry = { event: string; handler: (...args: any[]) => any };

function createFakeApi() {
  const tools = new Map<string, ToolDef>();
  const handlers: HandlerEntry[] = [];
  let thinkingLevel = "medium";
  let currentModel: Model<any> | undefined;
  let setModelResult = true;

  const api: ExtensionAPI = {
    on(event: string, handler: any) { handlers.push({ event, handler }); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() { return undefined; },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() { return undefined; },
    setLabel() {},
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    getCommands: () => [],
    setModel: async () => setModelResult,
    getThinkingLevel: () => thinkingLevel as any,
    setThinkingLevel: (level: any) => { thinkingLevel = level; },
    registerProvider() {},
    unregisterProvider() {},
  } as unknown as ExtensionAPI;

  function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
    const models = [
      makeModel(),
      makeReasoningModel(),
      makeModel({ provider: "other", id: "other-model" }),
      makeModel({ provider: "dup", id: "shared-id" }),
      makeModel({ provider: "dup2", id: "shared-id" }),
    ];

    return {
      model: currentModel,
      hasUI: false,
      cwd: "/tmp",
      isIdle: () => true,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getSystemPrompt: () => "",
      getContextUsage: () => ({ tokens: 5000, contextWindow: 128000, percent: 3.9 }),
      sessionManager: {} as any,
      modelRegistry: {
        refresh: () => {},
        getAvailable: () => models,
        getAll: () => models,
        getApiKey: async () => "key",
        getApiKeyForProvider: async () => "key",
      } as any,
      compact: () => {},
      ui: {} as any,
      ...overrides,
    } as unknown as ExtensionContext;
  }

  return {
    api,
    tools,
    handlers,
    makeCtx,
    setCurrentModel(m: Model<any> | undefined) { currentModel = m; },
    setThinkingLevel(l: string) { thinkingLevel = l; },
    setSetModelResult(r: boolean) { setModelResult = r; },
  };
}

async function callTool(
  tools: Map<string, ToolDef>,
  name: string,
  params: any,
  ctx: ExtensionContext,
) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("model-control extension", () => {
  let fake: ReturnType<typeof createFakeApi>;

  beforeEach(() => {
    fake = createFakeApi();
    modelControl(fake.api);
  });

  test("registers all tools and before_agent_start handler", () => {
    expect(fake.tools.has("get_model_state")).toBe(true);
    expect(fake.tools.has("list_models")).toBe(true);
    expect(fake.tools.has("switch_model")).toBe(true);
    expect(fake.tools.has("switch_thinking")).toBe(true);
    expect(fake.handlers.some((h) => h.event === "before_agent_start")).toBe(true);
  });

  test("before_agent_start appends tool hint", async () => {
    const handler = fake.handlers.find((h) => h.event === "before_agent_start")!;
    const result = await handler.handler({ systemPrompt: "base prompt" }, {} as any);
    expect(result.systemPrompt).toContain("base prompt");
    expect(result.systemPrompt).toContain("get_model_state");
    expect(result.systemPrompt).toContain("switch_model");
  });

  // -- get_model_state -------------------------------------------------------

  test("get_model_state with no model", async () => {
    fake.setCurrentModel(undefined);
    const ctx = fake.makeCtx({ getContextUsage: () => undefined } as any);
    const result = await callTool(fake.tools, "get_model_state", {}, ctx);
    expect(result.content[0].text).toContain("(none)");
    expect(result.content[0].text).toContain("Context: unknown");
    expect(result.details.model).toBeNull();
  });

  test("get_model_state with non-reasoning model", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "get_model_state", {}, ctx);
    expect(result.content[0].text).toContain("test-provider/test-model");
    expect(result.content[0].text).toContain("Thinking is off");
    expect(result.content[0].text).toContain("3.9%");
    expect(result.details.supports_thinking).toBe(false);
    expect(result.details.available_thinking_levels).toEqual(["off"]);
  });

  test("get_model_state with reasoning model", async () => {
    fake.setCurrentModel(makeReasoningModel());
    fake.setThinkingLevel("high");
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "get_model_state", {}, ctx);
    expect(result.content[0].text).toContain("Thinking level: high");
    expect(result.details.supports_thinking).toBe(true);
    expect(result.details.available_thinking_levels).toContain("high");
  });

  // -- list_models -----------------------------------------------------------

  test("list_models shows all available", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "list_models", {}, ctx);
    expect(result.content[0].text).toContain("Available models:");
    expect(result.details.total).toBeGreaterThan(0);
    expect(result.details.models.length).toBeGreaterThan(0);
  });

  test("list_models filters by query", async () => {
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "list_models", { query: "other" }, ctx);
    expect(result.details.models.every((m: any) => m.label.includes("other"))).toBe(true);
  });

  test("list_models returns empty for no-match query", async () => {
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "list_models", { query: "nonexistent-xyz" }, ctx);
    expect(result.content[0].text).toContain("No models found");
    expect(result.details.count).toBe(0);
  });

  test("list_models respects limit and offset", async () => {
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "list_models", { limit: 2, offset: 0 }, ctx);
    expect(result.details.count).toBeLessThanOrEqual(2);
    expect(result.details.limit).toBe(2);
    expect(result.details.offset).toBe(0);
  });

  test("list_models marks current model", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "list_models", {}, ctx);
    expect(result.content[0].text).toContain("(current)");
    expect(result.details.current_model).toBe("test-provider/test-model");
  });

  test("list_models no current model", async () => {
    fake.setCurrentModel(undefined);
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "list_models", {}, ctx);
    expect(result.details.current_model).toBeNull();
  });

  // -- switch_model ----------------------------------------------------------

  test("switch_model with provider/id", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "other/other-model" }, ctx);
    expect(result.content[0].text).toContain("Model set to other/other-model");
    expect(result.details.current_model).toBe("other/other-model");
  });

  test("switch_model with id only (unique)", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "other-model" }, ctx);
    expect(result.content[0].text).toContain("Model set to other/other-model");
  });

  test("switch_model with empty input", async () => {
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "  " }, ctx);
    expect(result.content[0].text).toContain("Provide a model identifier");
  });

  test("switch_model not found", async () => {
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "nope/nope" }, ctx);
    expect(result.content[0].text).toContain("Model not found");
  });

  test("switch_model ambiguous id", async () => {
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "shared-id" }, ctx);
    expect(result.content[0].text).toContain("matches multiple providers");
  });

  test("switch_model no API key", async () => {
    fake.setSetModelResult(false);
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "other/other-model" }, ctx);
    expect(result.content[0].text).toContain("No API key");
  });

  test("switch_model to reasoning model shows thinking level", async () => {
    fake.setCurrentModel(makeModel());
    fake.setThinkingLevel("high");
    // Make the reasoning model findable and set result to true
    fake.setSetModelResult(true);
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "test-provider/reasoning-model" }, ctx);
    expect(result.content[0].text).toContain("Thinking level: high");
  });

  test("switch_model to non-reasoning model says thinking off", async () => {
    fake.setCurrentModel(makeReasoningModel());
    fake.setSetModelResult(true);
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_model", { model: "other/other-model" }, ctx);
    expect(result.content[0].text).toContain("Thinking is off");
  });

  // -- switch_thinking -------------------------------------------------------

  test("switch_thinking with no model", async () => {
    fake.setCurrentModel(undefined);
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_thinking", {}, ctx);
    expect(result.content[0].text).toContain("No model selected");
  });

  test("switch_thinking omit level shows current", async () => {
    fake.setCurrentModel(makeReasoningModel());
    fake.setThinkingLevel("medium");
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_thinking", {}, ctx);
    expect(result.content[0].text).toContain("Current thinking level: medium");
    expect(result.content[0].text).toContain("Available thinking levels:");
  });

  test("switch_thinking sets valid level", async () => {
    fake.setCurrentModel(makeReasoningModel());
    fake.setThinkingLevel("low");
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_thinking", { level: "high" }, ctx);
    expect(result.content[0].text).toContain("Thinking level set to high");
    expect(result.details.supports_thinking).toBe(true);
  });

  test("switch_thinking unknown level", async () => {
    fake.setCurrentModel(makeReasoningModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_thinking", { level: "turbo" }, ctx);
    expect(result.content[0].text).toContain("Unknown thinking level");
  });

  test("switch_thinking on non-reasoning model", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_thinking", { level: "high" }, ctx);
    expect(result.content[0].text).toContain("does not support thinking");
    expect(result.details.supports_thinking).toBe(false);
  });

  test("switch_thinking off on non-reasoning model", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_thinking", { level: "off" }, ctx);
    expect(result.content[0].text).toContain("Thinking is off");
  });

  test("switch_thinking shows info for non-reasoning model (no level arg)", async () => {
    fake.setCurrentModel(makeModel());
    const ctx = fake.makeCtx();
    const result = await callTool(fake.tools, "switch_thinking", {}, ctx);
    expect(result.content[0].text).toContain("Thinking is off for this model");
  });
});
