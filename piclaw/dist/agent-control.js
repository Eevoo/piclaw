import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { ASSISTANT_AVATAR, ASSISTANT_NAME, PICLAW_CONFIG_PATH, setAssistantAvatar, setAssistantName } from "./config.js";
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
function formatCompactNumber(value) {
    if (!Number.isFinite(value))
        return String(value);
    const abs = Math.abs(value);
    const format = (divisor, suffix) => {
        const raw = (value / divisor).toFixed(1);
        const trimmed = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
        return `${trimmed}${suffix}`;
    };
    if (abs >= 1_000_000_000)
        return format(1_000_000_000, "B");
    if (abs >= 1_000_000)
        return format(1_000_000, "M");
    if (abs >= 1_000)
        return format(1_000, "K");
    return String(value);
}
function formatCurrency(value) {
    if (!Number.isFinite(value))
        return String(value);
    if (value === 0)
        return "$0";
    if (Math.abs(value) < 0.01)
        return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
}
function parseToggle(value) {
    if (!value)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalized))
        return true;
    if (["off", "false", "no", "0", "disable", "disabled"].includes(normalized))
        return false;
    return undefined;
}
function parseQueueMode(value) {
    if (!value)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "all")
        return "all";
    if (["one", "one-at-a-time", "one_at_a_time", "single"].includes(normalized))
        return "one-at-a-time";
    return undefined;
}
function truncateText(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
function extractTextFromContent(content) {
    if (!content)
        return "";
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => b && b.type === "text")
            .map((b) => b.text)
            .join("");
    }
    return "";
}
function splitArgs(input) {
    const result = [];
    let current = "";
    let quote = "";
    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        if (quote) {
            if (char === quote) {
                quote = "";
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === " " || char === "\t" || char === "\n") {
            if (current) {
                result.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (current)
        result.push(current);
    return result;
}
function parseTreeArgs(args) {
    const tokens = splitArgs(args);
    let targetId;
    let summarize = false;
    let customInstructions;
    let replaceInstructions = false;
    let label;
    let limit;
    let all = false;
    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i];
        if (!token.startsWith("--") && !targetId) {
            targetId = token;
            i += 1;
            continue;
        }
        if (token === "--summarize") {
            summarize = true;
            i += 1;
            continue;
        }
        if (token === "--summary") {
            summarize = true;
            const next = tokens[i + 1];
            if (next && !next.startsWith("--")) {
                customInstructions = next;
                i += 2;
            }
            else {
                i += 1;
            }
            continue;
        }
        if (token === "--replace") {
            replaceInstructions = true;
            i += 1;
            continue;
        }
        if (token === "--label") {
            const next = tokens[i + 1];
            if (next && !next.startsWith("--")) {
                label = next;
                i += 2;
            }
            else {
                i += 1;
            }
            continue;
        }
        if (token.startsWith("--label=")) {
            label = token.slice("--label=".length);
            i += 1;
            continue;
        }
        if (token === "--all") {
            all = true;
            i += 1;
            continue;
        }
        if (token === "--limit") {
            const next = tokens[i + 1];
            if (next && !next.startsWith("--")) {
                const parsed = parseInt(next, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    limit = parsed;
                }
                i += 2;
            }
            else {
                i += 1;
            }
            continue;
        }
        if (token.startsWith("--limit=")) {
            const raw = token.slice("--limit=".length);
            const parsed = parseInt(raw, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                limit = parsed;
            }
            i += 1;
            continue;
        }
        i += 1;
    }
    if (customInstructions)
        summarize = true;
    return { targetId, summarize, customInstructions, replaceInstructions, label, limit, all };
}
function readPiclawConfig() {
    try {
        const raw = readFileSync(PICLAW_CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object")
            return parsed;
    }
    catch {
        // ignore
    }
    return {};
}
function writePiclawConfig(config) {
    mkdirSync(dirname(PICLAW_CONFIG_PATH), { recursive: true });
    const next = JSON.stringify(config, null, 2);
    writeFileSync(PICLAW_CONFIG_PATH, `${next}\n`, "utf-8");
}
function updateAssistantConfig(patch) {
    const config = readPiclawConfig();
    const assistant = config.assistant && typeof config.assistant === "object"
        ? { ...config.assistant }
        : {};
    const nameKeys = ["assistantName", "assistant_name", "agentName", "agent_name", "name", "ASSISTANT_NAME"];
    const avatarKeys = [
        "assistantAvatar",
        "assistant_avatar",
        "agentAvatar",
        "agent_avatar",
        "avatar",
        "ASSISTANT_AVATAR",
    ];
    const clearKeys = (keys) => {
        for (const key of keys) {
            if (key in assistant)
                delete assistant[key];
        }
    };
    if (patch.name !== undefined) {
        clearKeys(nameKeys);
        if (patch.name !== null) {
            assistant.assistantName = patch.name;
        }
    }
    if (patch.avatar !== undefined) {
        clearKeys(avatarKeys);
        if (patch.avatar !== null) {
            assistant.assistantAvatar = patch.avatar;
        }
    }
    if (Object.keys(assistant).length > 0) {
        config.assistant = assistant;
    }
    else {
        delete config.assistant;
    }
    writePiclawConfig(config);
    return {
        name: typeof assistant.assistantName === "string" ? assistant.assistantName : undefined,
        avatar: typeof assistant.assistantAvatar === "string" ? assistant.assistantAvatar : undefined,
    };
}
async function runPromptAndCapture(session, text) {
    let assistantBuffer = "";
    const customBuffers = [];
    const onEvent = (event) => {
        if (event.type === "message_update") {
            const me = event.assistantMessageEvent;
            if (me && me.type === "text_delta") {
                assistantBuffer += me.delta || "";
            }
        }
        if (event.type === "message_end") {
            const msg = event.message;
            const text = extractTextFromContent(msg.content);
            if (msg.role === "assistant") {
                assistantBuffer = text || assistantBuffer;
            }
            else if (text) {
                customBuffers.push(text);
            }
        }
    };
    const unsub = session.subscribe(onEvent);
    try {
        await session.prompt(text);
    }
    finally {
        unsub();
    }
    const finalText = (assistantBuffer && assistantBuffer.trim())
        ? assistantBuffer.trim()
        : customBuffers.join("\n\n").trim();
    return finalText || "(no output)";
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
    const commandLower = command.toLowerCase();
    if (commandLower === "/model") {
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
    if (commandLower === "/thinking") {
        const level = args.split(/\s+/).filter(Boolean)[0];
        return {
            type: "thinking",
            level: level || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/commands") {
        return {
            type: "commands",
            raw: cleaned,
        };
    }
    if (commandLower === "/restart") {
        return {
            type: "restart",
            raw: cleaned,
        };
    }
    if (commandLower === "/shell") {
        return {
            type: "shell",
            command: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/queue") {
        return {
            type: "queue",
            message: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/queue-all") {
        return {
            type: "queue_all",
            message: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/state") {
        return { type: "state", raw: cleaned };
    }
    if (commandLower === "/stats") {
        return { type: "stats", raw: cleaned };
    }
    if (commandLower === "/context") {
        return { type: "context", raw: cleaned };
    }
    if (commandLower === "/last") {
        return { type: "last", raw: cleaned };
    }
    if (commandLower === "/compact") {
        return {
            type: "compact",
            instructions: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/auto-compact") {
        return {
            type: "auto_compact",
            enabled: parseToggle(args),
            raw: cleaned,
        };
    }
    if (commandLower === "/auto-retry") {
        return {
            type: "auto_retry",
            enabled: parseToggle(args),
            raw: cleaned,
        };
    }
    if (commandLower === "/abort") {
        return { type: "abort", raw: cleaned };
    }
    if (commandLower === "/abort-retry") {
        return { type: "abort_retry", raw: cleaned };
    }
    if (commandLower === "/abort-bash") {
        return { type: "abort_bash", raw: cleaned };
    }
    if (commandLower === "/cycle-model") {
        const dirRaw = args.toLowerCase();
        const direction = ["back", "backward", "prev", "previous"].includes(dirRaw)
            ? "backward"
            : "forward";
        return {
            type: "cycle_model",
            direction,
            raw: cleaned,
        };
    }
    if (commandLower === "/cycle-thinking") {
        return { type: "cycle_thinking", raw: cleaned };
    }
    if (commandLower === "/steering-mode") {
        return {
            type: "steering_mode",
            mode: parseQueueMode(args),
            raw: cleaned,
        };
    }
    if (commandLower === "/followup-mode") {
        return {
            type: "followup_mode",
            mode: parseQueueMode(args),
            raw: cleaned,
        };
    }
    if (commandLower === "/session-name") {
        return {
            type: "session_name",
            name: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/new-session") {
        return {
            type: "new_session",
            parent: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/switch-session") {
        return {
            type: "switch_session",
            path: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/fork") {
        return {
            type: "fork",
            entryId: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/forks") {
        return { type: "forks", raw: cleaned };
    }
    if (commandLower === "/export-html") {
        return {
            type: "export_html",
            path: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/bash") {
        return {
            type: "bash",
            command: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/tree") {
        const parsed = parseTreeArgs(args);
        return {
            type: "tree",
            targetId: parsed.targetId,
            summarize: parsed.summarize,
            customInstructions: parsed.customInstructions,
            replaceInstructions: parsed.replaceInstructions,
            label: parsed.label,
            limit: parsed.limit,
            all: parsed.all,
            raw: cleaned,
        };
    }
    if (commandLower === "/label") {
        const tokens = splitArgs(args);
        const targetId = tokens[0];
        const label = tokens.slice(1).join(" ").trim() || undefined;
        return {
            type: "label",
            targetId: targetId || undefined,
            label,
            raw: cleaned,
        };
    }
    if (commandLower === "/labels") {
        return { type: "labels", raw: cleaned };
    }
    if (commandLower === "/agent-name") {
        return {
            type: "agent_name",
            name: args || undefined,
            raw: cleaned,
        };
    }
    if (commandLower === "/agent-avatar") {
        return {
            type: "agent_avatar",
            avatar: args || undefined,
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
    if (command.type === "bash") {
        const rawCommand = command.command?.trim();
        if (!rawCommand) {
            return {
                status: "error",
                message: "Usage: /bash <command>",
            };
        }
        try {
            const bashOps = createTrackedBashOperations();
            const result = await session.executeBash(rawCommand, undefined, { operations: bashOps });
            const meta = [];
            if (result.cancelled)
                meta.push("(cancelled)");
            if (result.truncated)
                meta.push("(output truncated)");
            if (result.exitCode !== undefined && result.exitCode !== null) {
                meta.push(`(exit code ${result.exitCode})`);
            }
            if (result.fullOutputPath)
                meta.push(`(full output: ${result.fullOutputPath})`);
            const isSuccess = !result.cancelled && (result.exitCode === undefined || result.exitCode === null || result.exitCode === 0);
            return {
                status: isSuccess ? "success" : "error",
                message: formatShellBlock(rawCommand, result.output ?? "", meta),
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "queue" || command.type === "queue_all") {
        const queuedText = command.message?.trim();
        const useBatch = command.type === "queue_all";
        const mode = useBatch ? "all" : "one-at-a-time";
        if (!queuedText) {
            return {
                status: "error",
                message: useBatch ? "Usage: /queue-all <message>" : "Usage: /queue <message>",
            };
        }
        if (session.followUpMode !== mode) {
            session.setFollowUpMode(mode);
        }
        if (session.isStreaming) {
            try {
                await session.prompt(queuedText, { streamingBehavior: "followUp" });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { status: "error", message };
            }
            return {
                status: "success",
                message: useBatch
                    ? "Queued as a follow-up (batch mode: all)."
                    : "Queued as a follow-up (one-at-a-time).",
            };
        }
        try {
            const response = await runPromptAndCapture(session, queuedText);
            return { status: "success", message: response };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "state") {
        const modelLabel = session.model ? `${session.model.provider}/${session.model.id}` : "none";
        const steeringCount = session.getSteeringMessages().length;
        const followUpCount = session.getFollowUpMessages().length;
        const lines = [
            `Model: ${modelLabel}`,
            `Thinking level: ${session.thinkingLevel}${session.supportsThinking() ? "" : " (thinking off)"}`,
            `Streaming: ${session.isStreaming ? "yes" : "no"}`,
            `Compacting: ${session.isCompacting ? "yes" : "no"}`,
            `Retrying: ${session.isRetrying ? "yes" : "no"}`,
            `Auto-compaction: ${session.autoCompactionEnabled ? "on" : "off"}`,
            `Auto-retry: ${session.autoRetryEnabled ? "on" : "off"}`,
            `Steering mode: ${session.steeringMode}`,
            `Follow-up mode: ${session.followUpMode}`,
            `Pending messages: ${session.pendingMessageCount} (steer ${steeringCount}, follow-up ${followUpCount})`,
            `Session id: ${session.sessionId}`,
            `Session name: ${session.sessionName || "none"}`,
            `Session file: ${session.sessionFile || "none"}`,
        ];
        return { status: "success", message: lines.join("\n") };
    }
    if (command.type === "stats") {
        const stats = session.getSessionStats();
        const tokens = stats.tokens;
        const lines = [
            "Session stats:",
            `• Messages: ${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolResults} tool results (${stats.totalMessages} total)`,
            `• Tool calls: ${stats.toolCalls}`,
            `• Tokens: input ${formatCompactNumber(tokens.input)}, output ${formatCompactNumber(tokens.output)}, cache read ${formatCompactNumber(tokens.cacheRead)}, cache write ${formatCompactNumber(tokens.cacheWrite)}, total ${formatCompactNumber(tokens.total)}`,
            `• Cost: ${formatCurrency(stats.cost)}`,
        ];
        return { status: "success", message: lines.join("\n") };
    }
    if (command.type === "context") {
        const usage = session.getContextUsage();
        if (!usage) {
            return { status: "error", message: "Context usage unavailable (no model configured)." };
        }
        if (usage.tokens === null) {
            return {
                status: "success",
                message: `Context usage: unknown. Context window: ${formatCompactNumber(usage.contextWindow)}.`,
            };
        }
        const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
        return {
            status: "success",
            message: `Context usage: ${formatCompactNumber(usage.tokens)} / ${formatCompactNumber(usage.contextWindow)} (${percent.toFixed(1)}%).`,
        };
    }
    if (command.type === "last") {
        const last = session.getLastAssistantText();
        if (!last) {
            return { status: "error", message: "No assistant messages yet." };
        }
        return { status: "success", message: `Last assistant response:\n\n${last}` };
    }
    if (command.type === "compact") {
        try {
            const result = await session.compact(command.instructions?.trim() || undefined);
            const lines = [
                "Compaction complete.",
                `Tokens before: ${formatCompactNumber(result.tokensBefore)}`,
                `First kept entry: ${result.firstKeptEntryId}`,
                "Summary:",
                result.summary,
            ];
            return { status: "success", message: lines.join("\n") };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "auto_compact") {
        const hasArgs = command.raw.trim().split(/\s+/).length > 1;
        if (command.enabled === undefined) {
            if (hasArgs) {
                return { status: "error", message: "Usage: /auto-compact on|off" };
            }
            return {
                status: "success",
                message: `Auto-compaction is ${session.autoCompactionEnabled ? "on" : "off"}.`,
            };
        }
        session.setAutoCompactionEnabled(command.enabled);
        return {
            status: "success",
            message: `Auto-compaction turned ${command.enabled ? "on" : "off"}.`,
        };
    }
    if (command.type === "auto_retry") {
        const hasArgs = command.raw.trim().split(/\s+/).length > 1;
        if (command.enabled === undefined) {
            if (hasArgs) {
                return { status: "error", message: "Usage: /auto-retry on|off" };
            }
            return {
                status: "success",
                message: `Auto-retry is ${session.autoRetryEnabled ? "on" : "off"}.`,
            };
        }
        session.setAutoRetryEnabled(command.enabled);
        return {
            status: "success",
            message: `Auto-retry turned ${command.enabled ? "on" : "off"}.`,
        };
    }
    if (command.type === "abort") {
        try {
            await session.abort();
            return { status: "success", message: "Aborted current response." };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "abort_retry") {
        session.abortRetry();
        return { status: "success", message: "Retry aborted." };
    }
    if (command.type === "abort_bash") {
        if (!session.isBashRunning) {
            return { status: "success", message: "No bash command is running." };
        }
        session.abortBash();
        return { status: "success", message: "Bash command aborted." };
    }
    if (command.type === "cycle_model") {
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
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "cycle_thinking") {
        const previous = session.thinkingLevel;
        const level = session.cycleThinkingLevel();
        if (!level) {
            return { status: "error", message: "Current model does not support thinking levels." };
        }
        if (level !== previous) {
            try {
                await session.reload();
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    status: "error",
                    message: `Thinking level set to ${level}, but reload failed: ${message}`,
                };
            }
        }
        return { status: "success", message: `Thinking level set to ${level}.` };
    }
    if (command.type === "steering_mode") {
        const hasArgs = command.raw.trim().split(/\s+/).length > 1;
        if (!command.mode) {
            if (hasArgs) {
                return { status: "error", message: "Usage: /steering-mode all|one" };
            }
            return { status: "success", message: `Steering mode: ${session.steeringMode}.` };
        }
        session.setSteeringMode(command.mode);
        return { status: "success", message: `Steering mode set to ${command.mode}.` };
    }
    if (command.type === "followup_mode") {
        const hasArgs = command.raw.trim().split(/\s+/).length > 1;
        if (!command.mode) {
            if (hasArgs) {
                return { status: "error", message: "Usage: /followup-mode all|one" };
            }
            return { status: "success", message: `Follow-up mode: ${session.followUpMode}.` };
        }
        session.setFollowUpMode(command.mode);
        return { status: "success", message: `Follow-up mode set to ${command.mode}.` };
    }
    if (command.type === "session_name") {
        if (!command.name) {
            return {
                status: "success",
                message: `Session name: ${session.sessionName || "none"}.`,
            };
        }
        const name = command.name.trim();
        const normalized = name.toLowerCase();
        if (["clear", "none", "off"].includes(normalized)) {
            session.setSessionName("");
            return { status: "success", message: "Session name cleared." };
        }
        session.setSessionName(name);
        return { status: "success", message: `Session name set to "${name}".` };
    }
    if (command.type === "new_session") {
        const ok = await session.newSession(command.parent ? { parentSession: command.parent } : undefined);
        if (!ok) {
            return { status: "error", message: "New session cancelled." };
        }
        return { status: "success", message: "Started a new session." };
    }
    if (command.type === "switch_session") {
        if (!command.path) {
            return { status: "error", message: "Usage: /switch-session <path>" };
        }
        const ok = await session.switchSession(command.path.trim());
        if (!ok) {
            return { status: "error", message: "Switch session cancelled." };
        }
        return { status: "success", message: `Switched to session: ${command.path.trim()}.` };
    }
    if (command.type === "fork") {
        if (!command.entryId) {
            return { status: "error", message: "Usage: /fork <entryId>" };
        }
        try {
            const result = await session.fork(command.entryId.trim());
            if (result.cancelled) {
                return { status: "error", message: "Fork cancelled." };
            }
            const selected = result.selectedText ? `Selected text:\n${result.selectedText}` : "Fork created.";
            return { status: "success", message: selected };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "forks") {
        const messages = session.getUserMessagesForForking();
        if (messages.length === 0) {
            return { status: "success", message: "No user messages available for forking." };
        }
        const lines = ["Forkable messages:", ...messages.map((msg) => `• ${msg.entryId}: ${truncateText(msg.text, 120)}`)];
        return { status: "success", message: lines.join("\n") };
    }
    if (command.type === "export_html") {
        try {
            const outputPath = command.path?.trim() || undefined;
            const path = await session.exportToHtml(outputPath);
            return { status: "success", message: `Exported session to ${path}.` };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "tree") {
        const sessionManager = session.sessionManager;
        const leafId = sessionManager.getLeafId();
        if (!command.targetId) {
            const roots = sessionManager.getTree();
            if (roots.length === 0) {
                return { status: "success", message: "Tree is empty." };
            }
            const describeEntry = (entry) => {
                switch (entry.type) {
                    case "message": {
                        const msg = entry.message;
                        const role = msg?.role || "message";
                        if (role === "toolResult") {
                            return `toolResult: ${msg.toolName || "tool"}`;
                        }
                        const text = extractTextFromContent(msg?.content);
                        if (text) {
                            return `${role}: "${truncateText(text, 80)}"`;
                        }
                        if (Array.isArray(msg?.content)) {
                            const toolCall = msg.content.find((c) => c?.type === "toolCall");
                            if (toolCall)
                                return `${role}: [tool ${toolCall.name}]`;
                        }
                        return role;
                    }
                    case "compaction":
                        return `[compaction: ${formatCompactNumber(entry.tokensBefore)} tokens]`;
                    case "branch_summary":
                        return `[branch summary from ${entry.fromId}]`;
                    case "thinking_level_change":
                        return `[thinking ${entry.thinkingLevel}]`;
                    case "model_change":
                        return `[model ${entry.provider}/${entry.modelId}]`;
                    case "custom":
                        return `[custom ${entry.customType}]`;
                    case "custom_message":
                        return `[custom message ${entry.customType}]`;
                    case "label":
                        return `[label ${entry.label || "clear"}]`;
                    case "session_info":
                        return `[session name ${entry.name || "none"}]`;
                    default:
                        return `[${entry.type}]`;
                }
            };
            const lines = ["Session tree:"];
            const maxEntries = command.all ? Number.POSITIVE_INFINITY : (command.limit ?? 10);
            let count = 0;
            let truncated = false;
            const walk = (node, depth) => {
                if (count >= maxEntries) {
                    truncated = true;
                    return;
                }
                const indent = "  ".repeat(depth);
                const label = node.label ? ` [${node.label}]` : "";
                const active = node.entry.id === leafId ? " ← active" : "";
                lines.push(`${indent}• ${node.entry.id} ${describeEntry(node.entry)}${label}${active}`);
                count += 1;
                for (const child of node.children || []) {
                    walk(child, depth + 1);
                    if (count >= maxEntries) {
                        truncated = true;
                        return;
                    }
                }
            };
            for (const root of roots) {
                walk(root, 0);
                if (count >= maxEntries) {
                    truncated = true;
                    break;
                }
            }
            if (truncated) {
                lines.push(`… truncated at ${maxEntries} entries. Use /tree --all or /tree --limit N to view more.`);
            }
            lines.push("Use /tree <entryId> to navigate. Add --summarize or --summary \"...\" for branch summaries.");
            return { status: "success", message: lines.join("\n") };
        }
        const options = {
            summarize: command.summarize ?? false,
            customInstructions: command.customInstructions,
            replaceInstructions: command.replaceInstructions,
            label: command.label,
        };
        try {
            const result = await session.navigateTree(command.targetId, options);
            if (result.cancelled) {
                return { status: "error", message: "Tree navigation cancelled." };
            }
            if (result.aborted) {
                return { status: "error", message: "Tree navigation aborted." };
            }
            if (result.editorText) {
                return {
                    status: "success",
                    message: `Navigation complete. Selected text:\n${result.editorText}`,
                };
            }
            return { status: "success", message: "Navigation complete." };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", message };
        }
    }
    if (command.type === "label") {
        if (!command.targetId) {
            return { status: "error", message: "Usage: /label <entryId> <label|clear>" };
        }
        const rawLabel = command.label?.trim();
        const label = rawLabel && !["clear", "none", "off"].includes(rawLabel.toLowerCase()) ? rawLabel : "";
        session.sessionManager.appendLabelChange(command.targetId.trim(), label);
        return {
            status: "success",
            message: label ? `Label set on ${command.targetId}: ${label}` : `Label cleared on ${command.targetId}.`,
        };
    }
    if (command.type === "labels") {
        const roots = session.sessionManager.getTree();
        const labels = [];
        const describeEntry = (entry) => {
            if (entry.type === "message") {
                const role = entry.message?.role || "message";
                const text = extractTextFromContent(entry.message?.content);
                if (text)
                    return `${role}: "${truncateText(text, 60)}"`;
                return role;
            }
            return `[${entry.type}]`;
        };
        const walk = (node) => {
            if (node.label) {
                labels.push({ id: node.entry.id, label: node.label, summary: describeEntry(node.entry) });
            }
            for (const child of node.children || []) {
                walk(child);
            }
        };
        for (const root of roots)
            walk(root);
        if (labels.length === 0) {
            return { status: "success", message: "No labels set." };
        }
        const lines = ["Labels:", ...labels.map((item) => `• ${item.id} [${item.label}] ${item.summary}`)];
        return { status: "success", message: lines.join("\n") };
    }
    if (command.type === "agent_name") {
        if (!command.name) {
            return { status: "success", message: `Agent name: ${ASSISTANT_NAME}` };
        }
        const trimmed = command.name.trim();
        const normalized = trimmed.toLowerCase();
        const nextName = ["clear", "none", "off", "default"].includes(normalized) ? null : trimmed;
        const updated = updateAssistantConfig({ name: nextName });
        const fallback = process.env.ASSISTANT_NAME || "PiClaw";
        const effective = updated.name || fallback;
        setAssistantName(effective);
        return {
            status: "success",
            message: nextName ? `Agent name set to ${effective}.` : `Agent name reset to ${effective}.`,
        };
    }
    if (command.type === "agent_avatar") {
        if (!command.avatar) {
            const current = ASSISTANT_AVATAR || "(default)";
            return { status: "success", message: `Agent avatar: ${current}` };
        }
        const trimmed = command.avatar.trim();
        const normalized = trimmed.toLowerCase();
        const nextAvatar = ["clear", "none", "off", "default"].includes(normalized) ? null : trimmed;
        const updated = updateAssistantConfig({ avatar: nextAvatar });
        const fallback = process.env.ASSISTANT_AVATAR || "";
        const effective = updated.avatar || fallback;
        setAssistantAvatar(effective);
        return {
            status: "success",
            message: nextAvatar ? `Agent avatar set to ${effective || "(default)"}.` : "Agent avatar reset to default.",
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
        addLine("/cycle-model", "Cycle to the next available model");
        addLine("/thinking", "Show or set thinking level");
        addLine("/cycle-thinking", "Cycle thinking level");
        addLine("/state", "Show current session state");
        addLine("/stats", "Show session token and cost stats");
        addLine("/context", "Show context window usage");
        addLine("/last", "Show last assistant response");
        addLine("/compact", "Manually compact the session");
        addLine("/auto-compact", "Toggle auto-compaction");
        addLine("/auto-retry", "Toggle auto-retry");
        addLine("/abort", "Abort the current response");
        addLine("/abort-retry", "Abort retry backoff");
        addLine("/abort-bash", "Abort running bash command");
        addLine("/shell", "Run a shell command and return output");
        addLine("/bash", "Run a shell command and add output to context");
        addLine("/queue", "Queue a follow-up message (one-at-a-time)");
        addLine("/queue-all", "Queue a follow-up message (batch all)");
        addLine("/steering-mode", "Set steering mode (all|one)");
        addLine("/followup-mode", "Set follow-up mode (all|one)");
        addLine("/session-name", "Set or show the session name");
        addLine("/new-session", "Start a new session");
        addLine("/switch-session", "Switch to a session file");
        addLine("/fork", "Fork from a previous message");
        addLine("/forks", "List forkable messages");
        addLine("/tree", "List the session tree (default 10 entries) and navigate branches");
        addLine("/label", "Set or clear a label on a tree entry");
        addLine("/labels", "List labeled entries");
        addLine("/agent-name", "Set or show the agent display name");
        addLine("/agent-avatar", "Set or show the agent avatar URL");
        addLine("/export-html", "Export session to HTML");
        addLine("/restart", "Restart the agent and stop subprocesses");
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
