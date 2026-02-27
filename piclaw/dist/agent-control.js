import { existsSync } from "fs";
import { createTrackedBashOperations } from "./tools/tracked-bash.js";
import { killTrackedProcesses } from "./process-tracker.js";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const SHELL_OUTPUT_LIMIT = 20000;
const SHELL_TIMEOUT_SECONDS = 30;
function resolveShellCwd() {
    const preferred = "/workspace";
    if (existsSync(preferred))
        return preferred;
    return process.cwd();
}
function formatShellBlock(command, output, meta = []) {
    const lines = [`$ ${command}`];
    const trimmed = output.trimEnd();
    if (trimmed) {
        lines.push(trimmed);
    }
    else {
        lines.push("(no output)");
    }
    if (meta.length > 0) {
        lines.push(...meta);
    }
    return ["```", ...lines, "```"].join("\n");
}
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
    if (command.toLowerCase() === "/commands") {
        return {
            type: "commands",
            raw: cleaned,
        };
    }
    if (command.toLowerCase() === "/restart") {
        return {
            type: "restart",
            raw: cleaned,
        };
    }
    if (command.toLowerCase() === "/shell") {
        return {
            type: "shell",
            command: args || undefined,
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
    if (command.type === "restart") {
        try {
            await session.abort();
        }
        catch {
            // Ignore abort failures
        }
        const killed = killTrackedProcesses();
        try {
            await session.reload();
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                status: "error",
                message: `Restart failed after killing ${killed} subprocess${killed === 1 ? "" : "es"}: ${message}`,
            };
        }
        const killedLabel = killed === 1 ? "1 subprocess" : `${killed} subprocesses`;
        return {
            status: "success",
            message: `Agent restarted. Killed ${killedLabel}.`,
        };
    }
    if (command.type === "shell") {
        const rawCommand = command.command?.trim();
        if (!rawCommand) {
            return {
                status: "error",
                message: "Usage: /shell <command>",
            };
        }
        const cwd = resolveShellCwd();
        const bash = createTrackedBashOperations();
        let output = "";
        let truncated = false;
        const onData = (data) => {
            if (truncated)
                return;
            const chunk = data.toString("utf8");
            const remaining = SHELL_OUTPUT_LIMIT - output.length;
            if (remaining <= 0) {
                truncated = true;
                return;
            }
            if (chunk.length > remaining) {
                output += chunk.slice(0, remaining);
                truncated = true;
                return;
            }
            output += chunk;
        };
        let exitCode = null;
        let timedOut = false;
        let errorMessage = null;
        try {
            const result = await bash.exec(rawCommand, cwd, {
                onData,
                timeout: SHELL_TIMEOUT_SECONDS,
            });
            exitCode = result.exitCode ?? null;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.startsWith("timeout:")) {
                timedOut = true;
            }
            else if (message !== "aborted") {
                errorMessage = message;
            }
        }
        const meta = [];
        if (truncated)
            meta.push("(output truncated)");
        if (timedOut)
            meta.push(`(timed out after ${SHELL_TIMEOUT_SECONDS}s)`);
        if (exitCode !== null)
            meta.push(`(exit code ${exitCode})`);
        if (errorMessage)
            meta.push(`(error: ${errorMessage})`);
        const isSuccess = !timedOut && !errorMessage && (exitCode === null || exitCode === 0);
        return {
            status: isSuccess ? "success" : "error",
            message: formatShellBlock(rawCommand, output, meta),
        };
    }
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
    if (command.type === "commands") {
        const lines = ["Available commands:"];
        const addLine = (name, description) => {
            const suffix = description ? ` - ${description}` : "";
            lines.push(`• ${name}${suffix}`);
        };
        addLine("/model", "Select model or list available models");
        addLine("/thinking", "Show or set thinking level");
        addLine("/restart", "Restart the agent and stop subprocesses");
        addLine("/shell", "Run a shell command and return output");
        addLine("/commands", "List available commands");
        const extensionRunner = session.extensionRunner;
        if (extensionRunner) {
            const extCommands = extensionRunner.getRegisteredCommandsWithPaths();
            for (const entry of extCommands) {
                const name = entry.command?.name;
                if (!name)
                    continue;
                const description = entry.command.description || `extension (${entry.extensionPath})`;
                addLine(`/${name}`, description);
            }
        }
        for (const template of session.promptTemplates) {
            const description = template.description || "prompt template";
            addLine(`/${template.name}`, description);
        }
        const skills = session.resourceLoader.getSkills().skills;
        for (const skill of skills) {
            const description = skill.description || "skill";
            addLine(`/skill:${skill.name}`, description);
        }
        return {
            status: "success",
            message: lines.join("\n"),
        };
    }
    if (command.type !== "thinking") {
        return {
            status: "error",
            message: "Unsupported command.",
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
