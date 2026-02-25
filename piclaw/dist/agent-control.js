const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
function stripTrigger(text, triggerPattern) {
    if (!triggerPattern)
        return text.trim();
    const flags = triggerPattern.flags.includes("g") ? triggerPattern.flags : `${triggerPattern.flags}g`;
    const pattern = new RegExp(triggerPattern.source, flags);
    return text.replace(pattern, " ").trim();
}
export function parseControlCommand(text, triggerPattern) {
    if (!text)
        return null;
    const cleaned = stripTrigger(text, triggerPattern);
    if (!cleaned.startsWith("/"))
        return null;
    const [command, ...rest] = cleaned.split(/\s+/);
    const args = rest.join(" ").trim();
    if (command.toLowerCase() === "/model") {
        const tokens = args.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
            return { type: "model", raw: cleaned };
        }
        const [first, ...remaining] = tokens;
        if (first && first.includes("/")) {
            const [provider, ...modelParts] = first.split("/");
            const modelId = modelParts.join("/");
            return {
                type: "model",
                provider: provider || undefined,
                modelId: modelId || undefined,
                raw: cleaned,
            };
        }
        if (remaining.length > 0) {
            return {
                type: "model",
                provider: first,
                modelId: remaining.join(" "),
                raw: cleaned,
            };
        }
        return {
            type: "model",
            modelId: first,
            raw: cleaned,
        };
    }
    if (command.toLowerCase() === "/thinking") {
        const level = args.split(/\s+/).filter(Boolean)[0];
        return {
            type: "thinking",
            level: level || undefined,
            raw: cleaned,
        };
    }
    return null;
}
function normalizeModelMatch(models, provider, modelId) {
    const providerLower = provider.toLowerCase();
    const modelLower = modelId.toLowerCase();
    return models.find((model) => model.provider.toLowerCase() === providerLower && model.id.toLowerCase() === modelLower);
}
export async function applyControlCommand(session, modelRegistry, command) {
    if (command.type === "model") {
        modelRegistry.refresh();
        if (!command.modelId) {
            const available = modelRegistry.getAvailable();
            if (available.length === 0) {
                return {
                    status: "error",
                    message: "No models available. Configure API keys in your Pi settings, then try /model again.",
                };
            }
            const uniqueModels = new Map();
            for (const model of available) {
                const key = `${model.provider}/${model.id}`;
                if (!uniqueModels.has(key)) {
                    uniqueModels.set(key, model);
                }
            }
            const modelNames = Array.from(uniqueModels.keys()).sort((a, b) => a.localeCompare(b));
            const currentKey = session.model ? `${session.model.provider}/${session.model.id}` : null;
            const entries = modelNames.map((name) => name === currentKey ? `• ${name} (current)` : `• ${name}`);
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
        let selected;
        if (command.provider) {
            selected = normalizeModelMatch(models, command.provider, command.modelId);
            if (!selected) {
                return {
                    status: "error",
                    message: `Model not found: ${command.provider}/${command.modelId}.`,
                };
            }
        }
        else {
            const matches = models.filter((model) => model.id.toLowerCase() === command.modelId.toLowerCase());
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
        const previousModel = session.model;
        try {
            await session.setModel(selected);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
        const modelChanged = !previousModel ||
            previousModel.provider !== selected.provider ||
            previousModel.id !== selected.id;
        if (modelChanged) {
            try {
                await session.reload();
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    status: "error",
                    message: `Model set to ${selected.provider}/${selected.id}, but reload failed: ${message}`,
                };
            }
        }
        const thinkingNote = session.supportsThinking()
            ? ` Thinking level: ${session.thinkingLevel}.`
            : " Thinking is off for this model.";
        return {
            status: "success",
            message: `Model set to ${selected.provider}/${selected.id}.${thinkingNote}`,
        };
    }
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
    if (!THINKING_LEVELS.includes(requestedRaw)) {
        const available = session.getAvailableThinkingLevels().join(", ");
        return {
            status: "error",
            message: `Unknown thinking level: ${command.level}. Available: ${available}.`,
        };
    }
    const previousLevel = session.thinkingLevel;
    session.setThinkingLevel(requestedRaw);
    const applied = session.thinkingLevel;
    if (!session.supportsThinking()) {
        return {
            status: requestedRaw === "off" ? "success" : "error",
            message: "Current model does not support thinking levels. Thinking is off.",
        };
    }
    const note = applied !== requestedRaw ? ` (requested ${requestedRaw})` : "";
    if (applied !== previousLevel) {
        try {
            await session.reload();
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                status: "error",
                message: `Thinking level set to ${applied}${note}, but reload failed: ${message}`,
            };
        }
    }
    return {
        status: "success",
        message: `Thinking level set to ${applied}${note}.`,
    };
}
