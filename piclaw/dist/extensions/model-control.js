import { supportsXhigh } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const THINKING_LEVELS = [
    "off", "minimal", "low", "medium", "high", "xhigh",
];
const TOOL_HINT = [
    "You can manage your own model and thinking level.",
    "Use get_model_state to see the current model + thinking level.",
    "Use list_models to discover available models when needed.",
    "Use switch_model to change models and switch_thinking to change thinking level.",
    "Do not ask the user to run /model or /thinking when you can switch yourself.",
].join("\n");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function modelLabel(model) {
    return model ? `${model.provider}/${model.id}` : null;
}
function getAvailableLevels(model) {
    if (!model?.reasoning)
        return ["off"];
    const base = ["off", "minimal", "low", "medium", "high"];
    return supportsXhigh(model) ? [...base, "xhigh"] : base;
}
function clamp(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}
function parseModelInput(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return { modelId: "" };
    const slash = trimmed.indexOf("/");
    return slash > 0
        ? { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) }
        : { modelId: trimmed };
}
function findModel(models, provider, modelId) {
    if (provider) {
        const match = models.find((m) => m.provider.toLowerCase() === provider.toLowerCase() &&
            m.id.toLowerCase() === modelId.toLowerCase());
        return match
            ? { model: match }
            : { error: `Model not found: ${provider}/${modelId}.` };
    }
    const matches = models.filter((m) => m.id.toLowerCase() === modelId.toLowerCase());
    if (matches.length === 0)
        return { error: `Model not found: ${modelId}.` };
    if (matches.length > 1) {
        const list = matches.map((m) => `${m.provider}/${m.id}`).join(", ");
        return { error: `Model "${modelId}" matches multiple providers: ${list}. Use provider/modelId.` };
    }
    return { model: matches[0] };
}
// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------
export const modelControl = (pi) => {
    // Inject tool-usage hint into system prompt
    pi.on("before_agent_start", async (event) => {
        return { systemPrompt: `${event.systemPrompt}\n\n${TOOL_HINT}` };
    });
    // -- get_model_state -------------------------------------------------------
    pi.registerTool({
        name: "get_model_state",
        label: "get_model_state",
        description: "Get the current model and thinking level.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
            const model = ctx.model;
            const label = modelLabel(model);
            const thinking = pi.getThinkingLevel();
            const available = getAvailableLevels(model);
            const supportsThinking = Boolean(model?.reasoning);
            const usage = ctx.getContextUsage();
            const thinkingNote = supportsThinking
                ? `Thinking level: ${thinking}.`
                : "Thinking is off for this model.";
            const contextNote = usage
                ? `Context: ${usage.tokens ?? "?"}/${usage.contextWindow} tokens (${usage.percent ? usage.percent.toFixed(1) : "?"}%).`
                : "Context: unknown.";
            return {
                content: [{ type: "text", text: `Current model: ${label ?? "(none)"}. ${thinkingNote} ${contextNote}` }],
                details: {
                    model: label,
                    provider: model?.provider ?? null,
                    model_id: model?.id ?? null,
                    thinking_level: thinking,
                    supports_thinking: supportsThinking,
                    available_thinking_levels: available,
                    context_tokens: usage?.tokens ?? null,
                    context_window: usage?.contextWindow ?? null,
                    context_percent: usage?.percent ?? null,
                },
            };
        },
    });
    // -- list_models -----------------------------------------------------------
    pi.registerTool({
        name: "list_models",
        label: "list_models",
        description: "List available models in the registry.",
        parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "Filter by provider/modelId substring (case-insensitive)." })),
            limit: Type.Optional(Type.Integer({ description: "Max results (1-200).", minimum: 1, maximum: 200 })),
            offset: Type.Optional(Type.Integer({ description: "Offset for pagination.", minimum: 0 })),
        }),
        async execute(_id, params, _signal, _update, ctx) {
            ctx.modelRegistry.refresh();
            const seen = new Map();
            for (const m of ctx.modelRegistry.getAvailable()) {
                const key = `${m.provider}/${m.id}`;
                if (!seen.has(key))
                    seen.set(key, m);
            }
            const query = params.query?.trim().toLowerCase();
            let entries = Array.from(seen.values()).map((m) => ({
                id: m.id,
                provider: m.provider,
                label: `${m.provider}/${m.id}`,
                reasoning: m.reasoning || undefined,
                context_window: m.contextWindow || undefined,
            }));
            if (query)
                entries = entries.filter((e) => e.label.toLowerCase().includes(query));
            entries.sort((a, b) => a.label.localeCompare(b.label));
            const limit = clamp(params.limit, 100, 1, 200);
            const offset = clamp(params.offset, 0, 0, Math.max(entries.length, 0));
            const page = entries.slice(offset, offset + limit);
            const current = modelLabel(ctx.model);
            if (page.length === 0) {
                const msg = query ? `No models found matching "${params.query}".` : "No available models found.";
                return { content: [{ type: "text", text: msg }], details: { total: entries.length, count: 0, offset, limit, current_model: current, models: [] } };
            }
            const header = query
                ? `Available models (filtered): ${page.length} of ${entries.length}.`
                : `Available models: ${page.length} of ${entries.length}.`;
            const lines = page.map((e) => `• ${e.label}${e.label === current ? " (current)" : ""}`);
            return {
                content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
                details: { total: entries.length, count: page.length, offset, limit, current_model: current, models: page },
            };
        },
    });
    // -- switch_model ----------------------------------------------------------
    pi.registerTool({
        name: "switch_model",
        label: "switch_model",
        description: "Switch the active model for the current session.",
        parameters: Type.Object({
            model: Type.String({ description: "Model identifier (provider/modelId or modelId)." }),
        }),
        async execute(_id, params, _signal, _update, ctx) {
            const { provider, modelId } = parseModelInput(params.model);
            if (!modelId) {
                return { content: [{ type: "text", text: "Provide a model identifier." }], details: {} };
            }
            ctx.modelRegistry.refresh();
            const { model: selected, error } = findModel(ctx.modelRegistry.getAll(), provider, modelId);
            if (error || !selected) {
                return { content: [{ type: "text", text: error }], details: {} };
            }
            const previous = modelLabel(ctx.model);
            const success = await pi.setModel(selected);
            if (!success) {
                return {
                    content: [{ type: "text", text: `No API key for ${selected.provider}/${selected.id}.` }],
                    details: { previous_model: previous },
                };
            }
            const thinking = pi.getThinkingLevel();
            const thinkingNote = selected.reasoning
                ? ` Thinking level: ${thinking}.`
                : " Thinking is off for this model.";
            return {
                content: [{ type: "text", text: `Model set to ${selected.provider}/${selected.id}.${thinkingNote}` }],
                details: { previous_model: previous, current_model: `${selected.provider}/${selected.id}` },
            };
        },
    });
    // -- switch_thinking -------------------------------------------------------
    pi.registerTool({
        name: "switch_thinking",
        label: "switch_thinking",
        description: "Switch the thinking level for the current session.",
        parameters: Type.Object({
            level: Type.Optional(Type.String({ description: "Thinking level (off/minimal/low/medium/high/xhigh). Omit to see current." })),
        }),
        async execute(_id, params, _signal, _update, ctx) {
            const model = ctx.model;
            if (!model) {
                return { content: [{ type: "text", text: "No model selected yet. Switch models first." }], details: {} };
            }
            const available = getAvailableLevels(model);
            const supportsThinking = Boolean(model.reasoning);
            const requested = (params.level ?? "").trim().toLowerCase();
            if (!requested) {
                const msg = [
                    `Current model: ${model.provider}/${model.id}.`,
                    `Current thinking level: ${pi.getThinkingLevel()}.`,
                    `Available thinking levels: ${available.join(", ")}.`,
                ].join("\n") + (supportsThinking ? "" : " Thinking is off for this model.");
                return {
                    content: [{ type: "text", text: msg }],
                    details: { current_level: pi.getThinkingLevel(), available_levels: available, supports_thinking: supportsThinking },
                };
            }
            if (!THINKING_LEVELS.includes(requested)) {
                return {
                    content: [{ type: "text", text: `Unknown thinking level: ${params.level}. Available: ${available.join(", ")}.` }],
                    details: { available_levels: available },
                };
            }
            pi.setThinkingLevel(requested);
            const applied = pi.getThinkingLevel();
            if (!supportsThinking) {
                const msg = requested === "off"
                    ? "Thinking is off for this model."
                    : "Current model does not support thinking levels. Thinking is off.";
                return {
                    content: [{ type: "text", text: msg }],
                    details: { current_level: applied, available_levels: available, supports_thinking: false },
                };
            }
            const note = applied !== requested ? ` (requested ${requested})` : "";
            return {
                content: [{ type: "text", text: `Thinking level set to ${applied}${note}.` }],
                details: { current_level: applied, available_levels: available, supports_thinking: true },
            };
        },
    });
};
