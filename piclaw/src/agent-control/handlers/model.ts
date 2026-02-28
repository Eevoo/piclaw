import type { AgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentControlCommand, AgentControlResult } from "../../agent-control-types.js";
import { THINKING_LEVELS, normalizeModelMatch } from "../../agent-control-helpers.js";

type ModelCommand = Extract<AgentControlCommand, { type: "model" }>;
type ThinkingCommand = Extract<AgentControlCommand, { type: "thinking" }>;
type CycleModelCommand = Extract<AgentControlCommand, { type: "cycle_model" }>;
type CycleThinkingCommand = Extract<AgentControlCommand, { type: "cycle_thinking" }>;

export async function handleModel(session: AgentSession, modelRegistry: ModelRegistry, command: ModelCommand): Promise<AgentControlResult> {
  modelRegistry.refresh();

  if (!command.modelId) {
    const available = modelRegistry.getAvailable();
    if (available.length === 0) {
      return {
        status: "error",
        message: "No models available. Configure API keys in your Pi settings, then try /model again.",
      };
    }

    const uniqueModels = new Map<string, Model<any>>();
    for (const model of available) {
      const key = `${model.provider}/${model.id}`;
      if (!uniqueModels.has(key)) {
        uniqueModels.set(key, model);
      }
    }

    const modelNames = Array.from(uniqueModels.keys()).sort((a, b) => a.localeCompare(b));
    const currentKey = session.model ? `${session.model.provider}/${session.model.id}` : null;
    const entries = modelNames.map((name) =>
      name === currentKey ? `• ${name} (current)` : `• ${name}`
    );

    return {
      status: "success",
      message: [
        "Available models:",
        ...entries,
        "Use /model <provider>/<modelId> to switch.",
      ].join("\n"),
    };
  }

  const models = modelRegistry.getAll();
  let selected: Model<any> | undefined;

  if (command.provider) {
    selected = normalizeModelMatch(models, command.provider, command.modelId);
    if (!selected) {
      return {
        status: "error",
        message: `Model not found: ${command.provider}/${command.modelId}.`,
      };
    }
  } else {
    const matches = models.filter((model) => model.id.toLowerCase() === command.modelId!.toLowerCase());
    if (matches.length === 0) {
      return {
        status: "error",
        message: `Model not found: ${command.modelId}.`,
      };
    }
    if (matches.length > 1) {
      const providers = matches.map((model) => `${model.provider}/${model.id}`).join(", ");
      return {
        status: "error",
        message: `Model "${command.modelId}" matches multiple providers: ${providers}. Use /model <provider>/<modelId>.`,
      };
    }
    selected = matches[0];
  }

  const _previousModel = session.model;
  try {
    await session.setModel(selected);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }

  const thinkingNote = session.supportsThinking()
    ? ` Thinking level: ${session.thinkingLevel}.`
    : " Thinking is off for this model.";

  return {
    status: "success",
    message: `Model set to ${selected.provider}/${selected.id}.${thinkingNote}`,
  };
}

export async function handleThinking(session: AgentSession, _modelRegistry: ModelRegistry, command: ThinkingCommand): Promise<AgentControlResult> {
  if (!session.model) {
    return {
      status: "error",
      message: "No model selected yet. Use /model to pick one first.",
    };
  }

  const requestedRaw = command.level?.toLowerCase() || "";
  if (!requestedRaw) {
    const available = session.getAvailableThinkingLevels();
    const modelLabel = session.model ? `${session.model.provider}/${session.model.id}` : "unknown";
    const lines = [
      `Current model: ${modelLabel}.`,
      `Current thinking level: ${session.thinkingLevel}.`,
      `Available thinking levels: ${available.join(", ")}.`,
    ];
    if (!session.supportsThinking()) {
      lines.push("Thinking is off for this model.");
    }
    return {
      status: "success",
      message: lines.join("\n"),
    };
  }

  if (!THINKING_LEVELS.includes(requestedRaw as ThinkingLevel)) {
    const available = session.getAvailableThinkingLevels().join(", ");
    return {
      status: "error",
      message: `Unknown thinking level: ${command.level}. Available: ${available}.`,
    };
  }

  const _previousLevel = session.thinkingLevel;
  session.setThinkingLevel(requestedRaw as ThinkingLevel);
  const applied = session.thinkingLevel;

  if (!session.supportsThinking()) {
    return {
      status: requestedRaw === "off" ? "success" : "error",
      message: "Current model does not support thinking levels. Thinking is off.",
    };
  }

  const note = applied !== requestedRaw ? ` (requested ${requestedRaw})` : "";
  return {
    status: "success",
    message: `Thinking level set to ${applied}${note}.`,
  };
}

export async function handleCycleModel(session: AgentSession, _modelRegistry: ModelRegistry, command: CycleModelCommand): Promise<AgentControlResult> {
  try {
    const result = await session.cycleModel(command.direction);
    if (!result) {
      return { status: "success", message: "Only one model is available to cycle." };
    }
    const label = `${result.model.provider}/${result.model.id}`;
    const scope = result.isScoped ? "scoped" : "available";
    return {
      status: "success",
      message: `Model set to ${label} (cycle: ${scope}). Thinking level: ${result.thinkingLevel}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }
}

export async function handleCycleThinking(session: AgentSession, _modelRegistry: ModelRegistry, _command: CycleThinkingCommand): Promise<AgentControlResult> {
  const level = session.cycleThinkingLevel();
  if (!level) {
    return { status: "error", message: "Current model does not support thinking levels." };
  }
  return { status: "success", message: `Thinking level set to ${level}.` };
}
