import { extname, resolve } from "path";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { parseControlCommand } from "../agent-control.js";
import { ASSISTANT_AVATAR, ASSISTANT_NAME, TRIGGER_PATTERN, WEB_HOST, WEB_IDLE_TIMEOUT, WEB_PORT } from "../config.js";
import { attachMediaToMessage, clampWebContent, createMedia, deleteMessageByRowId, getMediaById, getMediaInfoById, getMessageByRowId, getMessagesByHashtag, getMessagesSince, getRouterState, getTimeline, hasOlderMessages, searchMessages, setRouterState, storeChatMetadata, storeMessage, } from "../db.js";
import { detectChannel, formatMessages, formatOutbound } from "../router.js";
const DEFAULT_CHAT_JID = "web:default";
const DEFAULT_AGENT_ID = "default";
const STATE_KEY = "last_agent_timestamp_web";
const STATIC_DIR = resolve(import.meta.dir, "..", "..", "web", "static");
const DOCS_DIR = resolve(import.meta.dir, "..", "..", "docs");
const encoder = new TextEncoder();
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
};
const createFallbackTheme = () => {
    const passthrough = (text) => text;
    const identity = () => passthrough;
    return {
        name: "web",
        sourcePath: undefined,
        fg: (_color, text) => text,
        bg: (_color, text) => text,
        bold: passthrough,
        italic: passthrough,
        underline: passthrough,
        inverse: passthrough,
        strikethrough: passthrough,
        getFgAnsi: (_color) => "",
        getBgAnsi: (_color) => "",
        getColorMode: () => "truecolor",
        getThinkingBorderColor: () => identity(),
        getBashModeBorderColor: () => identity(),
    };
};
export class WebChannel {
    queue;
    agentPool;
    server = null;
    lastAgentTimestamp = {};
    clients = new Set();
    pendingUiRequests = new Map();
    uiRequestCounter = 0;
    editorTextByChat = new Map();
    fallbackTheme = createFallbackTheme();
    constructor(opts) {
        this.queue = opts.queue;
        this.agentPool = opts.agentPool;
        if (typeof this.agentPool.setSessionBinder === "function") {
            this.agentPool.setSessionBinder((session, chatJid) => this.bindSessionUiContext(session, chatJid));
        }
    }
    async start() {
        this.loadState();
        try {
            initTheme();
        }
        catch { }
        this.server = Bun.serve({
            hostname: WEB_HOST,
            port: WEB_PORT,
            idleTimeout: WEB_IDLE_TIMEOUT,
            fetch: (req) => this.handleRequest(req),
        });
        console.log(`[web] UI listening on http://${WEB_HOST}:${WEB_PORT}`);
    }
    async stop() {
        for (const client of this.clients) {
            clearInterval(client.heartbeat);
            try {
                client.controller.close();
            }
            catch { }
        }
        this.clients.clear();
        for (const pending of this.pendingUiRequests.values()) {
            clearTimeout(pending.timeoutId);
            try {
                pending.reject(new Error("Web channel stopped"));
            }
            catch { }
        }
        this.pendingUiRequests.clear();
        this.server?.stop(true);
        this.server = null;
    }
    async sendMessage(chatJid, text) {
        const interaction = this.storeMessage(chatJid, text, true, []);
        if (interaction) {
            this.broadcastEvent("agent_response", {
                ...interaction,
                agent_name: ASSISTANT_NAME,
                agent_avatar: ASSISTANT_AVATAR || null,
            });
        }
    }
    loadState() {
        const data = getRouterState(STATE_KEY);
        try {
            this.lastAgentTimestamp = data ? JSON.parse(data) : {};
        }
        catch {
            this.lastAgentTimestamp = {};
        }
    }
    saveState() {
        setRouterState(STATE_KEY, JSON.stringify(this.lastAgentTimestamp));
    }
    async handleRequest(req) {
        const url = new URL(req.url);
        const pathname = url.pathname;
        if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
            return this.serveStatic("index.html");
        }
        if (pathname.startsWith("/static/")) {
            const rel = pathname.replace("/static/", "");
            return this.serveStatic(rel);
        }
        if (pathname.startsWith("/docs/")) {
            const rel = pathname.replace("/docs/", "");
            return this.serveDocsStatic(rel);
        }
        if (pathname === "/sse/stream") {
            return this.handleSse();
        }
        if (req.method === "GET" && pathname === "/agents") {
            return this.json({
                agents: [
                    {
                        id: DEFAULT_AGENT_ID,
                        name: ASSISTANT_NAME,
                        description: `${ASSISTANT_NAME} agent`,
                        status: "running",
                        actions: [],
                        avatar_url: ASSISTANT_AVATAR || null,
                    },
                ],
            });
        }
        if (req.method === "GET" && pathname === "/timeline") {
            const limit = this.clampInt(url.searchParams.get("limit"), 10, 1, 100);
            const before = this.parseOptionalInt(url.searchParams.get("before"));
            const posts = getTimeline(DEFAULT_CHAT_JID, limit, before ?? undefined);
            const oldestId = posts.length > 0 ? posts[0].id : null;
            const hasMore = oldestId !== null && posts.length === limit && hasOlderMessages(DEFAULT_CHAT_JID, oldestId);
            return this.json({ posts, limit, has_more: hasMore });
        }
        if (req.method === "GET" && pathname.startsWith("/hashtag/")) {
            const tag = decodeURIComponent(pathname.replace("/hashtag/", ""));
            const limit = this.clampInt(url.searchParams.get("limit"), 50, 1, 100);
            const offset = this.clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
            const posts = getMessagesByHashtag(DEFAULT_CHAT_JID, tag, limit, offset);
            return this.json({ hashtag: tag, posts, limit, offset });
        }
        if (req.method === "GET" && pathname === "/search") {
            const query = (url.searchParams.get("q") || "").trim();
            if (!query)
                return this.json({ error: "Missing 'q' parameter" }, 400);
            const limit = this.clampInt(url.searchParams.get("limit"), 50, 1, 100);
            const offset = this.clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
            const results = searchMessages(DEFAULT_CHAT_JID, query, limit, offset);
            return this.json({ query, results, limit, offset });
        }
        if (req.method === "POST" && pathname === "/post") {
            return this.handlePost(req, false);
        }
        if (req.method === "POST" && pathname === "/reply") {
            return this.handlePost(req, true);
        }
        if (req.method === "GET" && pathname.startsWith("/thread/")) {
            const id = this.parseOptionalInt(pathname.replace("/thread/", ""));
            if (!id)
                return this.json({ error: "Thread not found" }, 404);
            const thread = getMessageByRowId(DEFAULT_CHAT_JID, id);
            if (!thread)
                return this.json({ error: "Thread not found" }, 404);
            return this.json({ thread: [thread] });
        }
        if (req.method === "DELETE" && pathname.startsWith("/post/")) {
            const id = this.parseOptionalInt(pathname.replace("/post/", ""));
            if (!id)
                return this.json({ error: "Post not found" }, 404);
            const deleted = deleteMessageByRowId(DEFAULT_CHAT_JID, id);
            if (deleted) {
                this.broadcastEvent("interaction_deleted", { ids: [id] });
            }
            return this.json({ deleted: deleted ? 1 : 0, ids: deleted ? [id] : [] });
        }
        if (req.method === "POST" && pathname.startsWith("/agent/") && pathname.endsWith("/message")) {
            return this.handleAgentMessage(req, pathname);
        }
        if (req.method === "POST" && pathname === "/agent/respond") {
            return this.handleAgentRespond(req);
        }
        if (req.method === "POST" && pathname === "/agent/whitelist") {
            return this.json({ status: "ok" });
        }
        if (req.method === "POST" && pathname === "/media/upload") {
            return this.handleMediaUpload(req);
        }
        if (req.method === "GET" && pathname.startsWith("/media/") && pathname.endsWith("/thumbnail")) {
            const id = this.parseOptionalInt(pathname.replace("/media/", "").replace("/thumbnail", ""));
            if (!id)
                return this.json({ error: "Media not found" }, 404);
            return this.handleMedia(id, true);
        }
        if (req.method === "GET" && pathname.startsWith("/media/") && pathname.endsWith("/info")) {
            const id = this.parseOptionalInt(pathname.replace("/media/", "").replace("/info", ""));
            if (!id)
                return this.json({ error: "Media not found" }, 404);
            return this.handleMediaInfo(id);
        }
        if (req.method === "GET" && pathname.startsWith("/media/")) {
            const id = this.parseOptionalInt(pathname.replace("/media/", ""));
            if (!id)
                return this.json({ error: "Media not found" }, 404);
            return this.handleMedia(id, false);
        }
        return this.json({ error: "Not found" }, 404);
    }
    handleSse() {
        let clientRef = null;
        const stream = new ReadableStream({
            start: (controller) => {
                const heartbeat = setInterval(() => {
                    try {
                        controller.enqueue(encoder.encode(": heartbeat\n\n"));
                    }
                    catch {
                        clearInterval(heartbeat);
                        if (clientRef)
                            this.clients.delete(clientRef);
                    }
                }, 30000);
                clientRef = { controller, heartbeat };
                this.clients.add(clientRef);
                controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));
            },
            cancel: () => {
                if (clientRef) {
                    clearInterval(clientRef.heartbeat);
                    this.clients.delete(clientRef);
                }
            },
        });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            },
        });
    }
    broadcastEvent(eventType, data) {
        const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        const bytes = encoder.encode(payload);
        for (const client of this.clients) {
            try {
                client.controller.enqueue(bytes);
            }
            catch {
                clearInterval(client.heartbeat);
                this.clients.delete(client);
            }
        }
    }
    async bindSessionUiContext(session, chatJid) {
        if (!chatJid.startsWith("web:"))
            return;
        const waitForIdle = async () => {
            if (!session.isStreaming)
                return;
            await new Promise((resolve) => {
                const unsub = session.subscribe((event) => {
                    if (event.type === "agent_end") {
                        unsub();
                        resolve();
                    }
                });
            });
        };
        const uiContext = this.createUiContext(chatJid);
        await session.bindExtensions({
            uiContext,
            commandContextActions: {
                waitForIdle,
                newSession: async (options) => {
                    const ok = await session.newSession(options);
                    return { cancelled: !ok };
                },
                fork: async (entryId) => {
                    const result = await session.fork(entryId);
                    return { cancelled: result.cancelled };
                },
                navigateTree: async (targetId, options) => {
                    const result = await session.navigateTree(targetId, options);
                    return { cancelled: result.cancelled };
                },
                switchSession: async (sessionPath) => {
                    const ok = await session.switchSession(sessionPath);
                    return { cancelled: !ok };
                },
                reload: () => session.reload(),
            },
            onError: (error) => {
                console.error("[web] Extension error:", error);
                this.broadcastEvent("extension_ui_error", error);
            },
        });
    }
    createUiContext(chatJid) {
        const fallbackTheme = this.fallbackTheme;
        const requestUiResponse = async (kind, payload, timeoutMs = 120000) => {
            const requestId = `ui-${Date.now()}-${++this.uiRequestCounter}`;
            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    this.pendingUiRequests.delete(requestId);
                    this.broadcastEvent("extension_ui_timeout", { request_id: requestId, kind, chat_jid: chatJid });
                    resolve(undefined);
                }, timeoutMs);
                this.pendingUiRequests.set(requestId, { resolve, reject, timeoutId, kind });
                this.broadcastEvent("extension_ui_request", {
                    request_id: requestId,
                    kind,
                    chat_jid: chatJid,
                    ...payload,
                });
            });
        };
        return {
            select: async (title, options, opts) => {
                const timeoutMs = typeof opts?.timeout === "number" ? opts.timeout : 120000;
                const result = await requestUiResponse("select", { title, options, opts }, timeoutMs);
                return typeof result === "string" ? result : undefined;
            },
            confirm: async (title, message, opts) => {
                const timeoutMs = typeof opts?.timeout === "number" ? opts.timeout : 120000;
                const result = await requestUiResponse("confirm", { title, message, opts }, timeoutMs);
                return Boolean(result);
            },
            input: async (title, placeholder, opts) => {
                const timeoutMs = typeof opts?.timeout === "number" ? opts.timeout : 120000;
                const result = await requestUiResponse("input", { title, placeholder, opts }, timeoutMs);
                return typeof result === "string" ? result : undefined;
            },
            notify: (message, type) => {
                this.broadcastEvent("extension_ui_notify", { chat_jid: chatJid, message, type });
            },
            onTerminalInput: () => () => { },
            setStatus: (key, text) => {
                this.broadcastEvent("extension_ui_status", { chat_jid: chatJid, key, text });
            },
            setWorkingMessage: (message) => {
                this.broadcastEvent("extension_ui_working", { chat_jid: chatJid, message });
            },
            setWidget: (key, content, options) => {
                if (Array.isArray(content)) {
                    this.broadcastEvent("extension_ui_widget", { chat_jid: chatJid, key, content, options });
                }
            },
            setFooter: () => { },
            setHeader: () => { },
            setTitle: (title) => {
                this.broadcastEvent("extension_ui_title", { chat_jid: chatJid, title });
            },
            custom: async (_factory, _options) => {
                const result = await requestUiResponse("custom", { title: "Custom UI" });
                return result;
            },
            pasteToEditor: (text) => {
                const current = this.editorTextByChat.get(chatJid) || "";
                const updated = current + text;
                this.editorTextByChat.set(chatJid, updated);
                this.broadcastEvent("extension_ui_editor_text", { chat_jid: chatJid, text: updated });
            },
            setEditorText: (text) => {
                this.editorTextByChat.set(chatJid, text);
                this.broadcastEvent("extension_ui_editor_text", { chat_jid: chatJid, text });
            },
            getEditorText: () => this.editorTextByChat.get(chatJid) || "",
            editor: async (title, prefill) => {
                const result = await requestUiResponse("editor", { title, prefill });
                return typeof result === "string" ? result : undefined;
            },
            setEditorComponent: () => { },
            get theme() {
                return fallbackTheme;
            },
            getAllThemes: () => [],
            getTheme: (_name) => undefined,
            setTheme: (_nextTheme) => ({ success: false, error: "UI theme switching not available" }),
            getToolsExpanded: () => false,
            setToolsExpanded: () => { },
        };
    }
    async handlePost(req, isReply) {
        let data;
        try {
            data = await req.json();
        }
        catch {
            return this.json({ error: "Invalid JSON" }, 400);
        }
        if (!data.content)
            return this.json({ error: "Missing 'content' field" }, 400);
        if (isReply && !data.thread_id)
            return this.json({ error: "Missing 'thread_id' field" }, 400);
        const mediaIds = Array.isArray(data.media_ids)
            ? data.media_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
            : [];
        const interaction = this.storeMessage(DEFAULT_CHAT_JID, data.content, false, mediaIds);
        if (!interaction)
            return this.json({ error: "Failed to store message" }, 500);
        if (isReply && data.thread_id)
            interaction.data.thread_id = Number(data.thread_id);
        this.broadcastEvent(isReply ? "new_reply" : "new_post", interaction);
        return this.json(interaction, 201);
    }
    async handleAgentRespond(req) {
        let data;
        try {
            data = await req.json();
        }
        catch {
            return this.json({ error: "Invalid JSON" }, 400);
        }
        if (!data.request_id)
            return this.json({ error: "Missing request_id" }, 400);
        const pending = this.pendingUiRequests.get(data.request_id);
        if (pending) {
            clearTimeout(pending.timeoutId);
            this.pendingUiRequests.delete(data.request_id);
            pending.resolve(data.outcome);
            return this.json({ status: "ok" });
        }
        return this.json({ status: "unknown_request" });
    }
    async handleAgentMessage(req, pathname) {
        const agentId = pathname.split("/")[2] || DEFAULT_AGENT_ID;
        let data;
        try {
            data = await req.json();
        }
        catch {
            return this.json({ error: "Invalid JSON" }, 400);
        }
        if (!data.content)
            return this.json({ error: "Missing 'content' field" }, 400);
        const mediaIds = Array.isArray(data.media_ids)
            ? data.media_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
            : [];
        const interaction = this.storeMessage(DEFAULT_CHAT_JID, data.content, false, mediaIds);
        if (!interaction)
            return this.json({ error: "Failed to store message" }, 500);
        this.broadcastEvent("new_post", interaction);
        const markCommandHandled = () => {
            if (interaction?.timestamp) {
                this.lastAgentTimestamp[DEFAULT_CHAT_JID] = interaction.timestamp;
                this.saveState();
            }
        };
        const command = parseControlCommand(data.content, TRIGGER_PATTERN);
        if (command) {
            const result = await this.agentPool.applyControlCommand(DEFAULT_CHAT_JID, command);
            const formatted = formatOutbound(result.message, "web");
            if (formatted)
                await this.sendMessage(DEFAULT_CHAT_JID, formatted);
            markCommandHandled();
            return this.json({ user_message: interaction, thread_id: data.thread_id ?? interaction.id, command: result }, 201);
        }
        // If message looks like an extension slash command (starts with '/'), execute it directly
        const trimmed = (data.content || "").trim();
        if (trimmed.startsWith("/")) {
            const cmdResult = await this.agentPool.applySlashCommand(DEFAULT_CHAT_JID, trimmed);
            try {
                const formatted = formatOutbound(cmdResult.message || "", "web");
                if (formatted)
                    await this.sendMessage(DEFAULT_CHAT_JID, formatted);
            }
            catch (e) {
                console.error('[web] Failed to send slash command response:', e);
            }
            markCommandHandled();
            return this.json({ user_message: interaction, thread_id: data.thread_id ?? interaction.id, command: cmdResult }, 201);
        }
        const steerResult = await this.agentPool.queueStreamingMessage(DEFAULT_CHAT_JID, data.content, "steer");
        if (steerResult.queued) {
            markCommandHandled();
            return this.json({
                user_message: interaction,
                thread_id: data.thread_id ?? interaction.id,
                queued: "steer",
            }, 201);
        }
        if (steerResult.error) {
            console.warn(`[web] Failed to queue steering message: ${steerResult.error}`);
        }
        this.queue.enqueue(async () => {
            await this.processChat(DEFAULT_CHAT_JID, agentId);
        }, `chat:${DEFAULT_CHAT_JID}`);
        return this.json({ user_message: interaction, thread_id: data.thread_id ?? interaction.id }, 201);
    }
    async processChat(chatJid, agentId) {
        const since = this.lastAgentTimestamp[chatJid] || "";
        const messages = getMessagesSince(chatJid, since, ASSISTANT_NAME);
        if (messages.length === 0)
            return;
        const channel = detectChannel(chatJid);
        const prompt = formatMessages(messages, channel);
        const prevCursor = this.lastAgentTimestamp[chatJid] || "";
        this.lastAgentTimestamp[chatJid] = messages[messages.length - 1].timestamp;
        this.saveState();
        const threadId = messages[messages.length - 1].timestamp;
        let thoughtBuffer = "";
        let draftBuffer = "";
        const toolTitles = new Map();
        const THOUGHT_PREVIEW_LINES = 8;
        const DRAFT_PREVIEW_LINES = 8;
        const PREVIEW_MAX_CHARS_PER_LINE = 160;
        const countSoftLines = (line, maxChars) => {
            if (!line)
                return 1;
            return Math.max(1, Math.ceil(line.length / maxChars));
        };
        const buildPreview = (text, maxLines) => {
            const value = (text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            if (!value)
                return { preview: "", totalLines: 0 };
            const rawLines = value.split("\n");
            const totalLines = rawLines.reduce((acc, line) => acc + countSoftLines(line, PREVIEW_MAX_CHARS_PER_LINE), 0);
            const previewLines = rawLines.slice(0, maxLines);
            return { preview: previewLines.join("\n"), totalLines };
        };
        const extractToolArgs = (args) => {
            if (!args)
                return null;
            if (typeof args === "string") {
                try {
                    const parsed = JSON.parse(args);
                    if (parsed && typeof parsed === "object")
                        return parsed;
                }
                catch {
                    return null;
                }
            }
            if (typeof args === "object") {
                const record = args;
                const nested = record.arguments ||
                    record.input ||
                    record.params ||
                    record.parameters ||
                    record.args ||
                    record.payload;
                return nested ?? record;
            }
            return null;
        };
        const formatToolTitle = (toolName, args) => {
            const record = extractToolArgs(args);
            if (!record)
                return toolName;
            let detail = null;
            const command = record.command;
            if (typeof command === "string")
                detail = command;
            if (!detail && Array.isArray(record.commands)) {
                detail = record.commands.filter((item) => typeof item === "string").join(" && ");
            }
            const path = record.path || record.filePath || record.target;
            if (!detail && typeof path === "string")
                detail = path;
            if (!detail && Array.isArray(record.paths)) {
                detail = record.paths.filter((item) => typeof item === "string").join(", ");
            }
            const filename = record.fileName || record.filename || record.file;
            if (!detail && typeof filename === "string")
                detail = filename;
            const url = record.url;
            if (!detail && typeof url === "string")
                detail = url;
            const query = record.query;
            if (!detail && typeof query === "string")
                detail = query;
            if (!detail)
                return toolName;
            const normalized = detail.replace(/\s+/g, " ").trim();
            const maxLen = 120;
            const clipped = normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized;
            return `${toolName}: ${clipped}`;
        };
        const rememberToolTitle = (toolCallId, toolName, args) => {
            const title = formatToolTitle(toolName, args);
            toolTitles.set(toolCallId, title);
            return title;
        };
        const lookupToolTitle = (toolCallId, toolName, args) => {
            return toolTitles.get(toolCallId) ?? formatToolTitle(toolName, args);
        };
        const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const withAgentProfile = (payload) => ({
            ...payload,
            agent_name: ASSISTANT_NAME,
            agent_avatar: ASSISTANT_AVATAR || null,
        });
        this.broadcastEvent("agent_status", withAgentProfile({
            thread_id: threadId,
            agent_id: agentId,
            type: "thinking",
            title: "Thinking...",
            turn_id: turnId,
        }));
        const output = await this.agentPool.runAgent(prompt, chatJid, {
            onEvent: (event) => {
                if (event.type === "message_update") {
                    const messageEvent = event.assistantMessageEvent;
                    if (messageEvent.type === "thinking_start") {
                        thoughtBuffer = "";
                    }
                    if (messageEvent.type === "thinking_delta") {
                        thoughtBuffer += messageEvent.delta;
                        const { preview, totalLines } = buildPreview(thoughtBuffer, THOUGHT_PREVIEW_LINES);
                        this.broadcastEvent("agent_thought", withAgentProfile({
                            thread_id: threadId,
                            agent_id: agentId,
                            text: preview,
                            total_lines: totalLines,
                            turn_id: turnId,
                        }));
                    }
                    if (messageEvent.type === "thinking_end") {
                        thoughtBuffer = messageEvent.content || thoughtBuffer;
                        const { preview, totalLines } = buildPreview(thoughtBuffer, THOUGHT_PREVIEW_LINES);
                        this.broadcastEvent("agent_thought", withAgentProfile({
                            thread_id: threadId,
                            agent_id: agentId,
                            text: preview,
                            total_lines: totalLines,
                            turn_id: turnId,
                        }));
                    }
                    if (messageEvent.type === "toolcall_end") {
                        const title = rememberToolTitle(messageEvent.toolCall.id, messageEvent.toolCall.name, messageEvent.toolCall.arguments);
                        this.broadcastEvent("agent_status", withAgentProfile({
                            thread_id: threadId,
                            agent_id: agentId,
                            type: "tool_call",
                            title,
                            turn_id: turnId,
                        }));
                    }
                    if (messageEvent.type === "text_start") {
                        draftBuffer = "";
                        this.broadcastEvent("agent_draft", withAgentProfile({
                            thread_id: threadId,
                            agent_id: agentId,
                            text: "",
                            total_lines: 0,
                            kind: "draft",
                            mode: "replace",
                            turn_id: turnId,
                        }));
                        this.broadcastEvent("agent_draft_delta", withAgentProfile({
                            thread_id: threadId,
                            agent_id: agentId,
                            delta: "",
                            reset: true,
                            turn_id: turnId,
                        }));
                    }
                    if (messageEvent.type === "text_delta") {
                        draftBuffer += messageEvent.delta;
                        const { preview, totalLines } = buildPreview(draftBuffer, DRAFT_PREVIEW_LINES);
                        this.broadcastEvent("agent_draft", withAgentProfile({
                            thread_id: threadId,
                            agent_id: agentId,
                            text: preview,
                            total_lines: totalLines,
                            kind: "draft",
                            mode: "replace",
                            turn_id: turnId,
                        }));
                        this.broadcastEvent("agent_draft_delta", withAgentProfile({
                            thread_id: threadId,
                            agent_id: agentId,
                            delta: messageEvent.delta,
                            turn_id: turnId,
                        }));
                    }
                }
                if (event.type === "tool_execution_start") {
                    const title = rememberToolTitle(event.toolCallId, event.toolName, event.args);
                    this.broadcastEvent("agent_status", withAgentProfile({
                        thread_id: threadId,
                        agent_id: agentId,
                        type: "tool_call",
                        title,
                        turn_id: turnId,
                    }));
                }
                if (event.type === "tool_execution_update") {
                    const title = lookupToolTitle(event.toolCallId, event.toolName, event.args);
                    this.broadcastEvent("agent_status", withAgentProfile({
                        thread_id: threadId,
                        agent_id: agentId,
                        type: "tool_status",
                        title,
                        status: "Working...",
                        turn_id: turnId,
                    }));
                }
                if (event.type === "tool_execution_end") {
                    const title = lookupToolTitle(event.toolCallId, event.toolName);
                    toolTitles.delete(event.toolCallId);
                    this.broadcastEvent("agent_status", withAgentProfile({
                        thread_id: threadId,
                        agent_id: agentId,
                        type: "tool_status",
                        title,
                        status: event.isError ? "Failed" : "Done",
                        turn_id: turnId,
                    }));
                }
            },
        });
        if (output.status === "error") {
            this.lastAgentTimestamp[chatJid] = prevCursor;
            this.saveState();
            this.broadcastEvent("agent_status", withAgentProfile({
                thread_id: threadId,
                agent_id: agentId,
                type: "error",
                title: output.error || "Agent error",
                turn_id: turnId,
            }));
            return;
        }
        if (output.result) {
            const text = formatOutbound(output.result, channel);
            if (text) {
                const interaction = this.storeMessage(chatJid, text, true, []);
                if (interaction) {
                    this.broadcastEvent("agent_response", {
                        ...interaction,
                        agent_name: ASSISTANT_NAME,
                        agent_avatar: ASSISTANT_AVATAR || null,
                    });
                }
            }
        }
        this.broadcastEvent("agent_status", withAgentProfile({
            thread_id: threadId,
            agent_id: agentId,
            type: "done",
            turn_id: turnId,
        }));
    }
    storeMessage(chatJid, content, isBot, mediaIds) {
        const timestamp = new Date().toISOString();
        const msg = {
            id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chat_jid: chatJid,
            sender: isBot ? "web-agent" : "web-user",
            sender_name: isBot ? ASSISTANT_NAME : "You",
            content,
            timestamp,
            is_from_me: false,
            is_bot_message: isBot,
        };
        const rowId = storeMessage(msg);
        if (rowId <= 0)
            return null;
        if (mediaIds.length > 0) {
            attachMediaToMessage(rowId, mediaIds);
        }
        storeChatMetadata(chatJid, timestamp, "Web");
        const interaction = getMessageByRowId(chatJid, rowId);
        if (interaction) {
            interaction.data.agent_id = DEFAULT_AGENT_ID;
            return interaction;
        }
        const { content: safeContent, meta } = clampWebContent(content);
        return {
            id: rowId,
            timestamp,
            data: {
                type: isBot ? "agent_response" : "user_message",
                content: safeContent,
                content_meta: meta,
                agent_id: DEFAULT_AGENT_ID,
                media_ids: mediaIds,
            },
        };
    }
    async handleMediaUpload(req) {
        let form;
        try {
            form = await req.formData();
        }
        catch {
            return this.json({ error: "Invalid form data" }, 400);
        }
        const file = form.get("file");
        if (!(file instanceof File))
            return this.json({ error: "Missing file" }, 400);
        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const mediaId = createMedia(file.name || "upload", file.type || "application/octet-stream", data, null, { size: file.size });
        return this.json({ id: mediaId, filename: file.name, size: file.size });
    }
    handleMedia(id, thumbnail) {
        const media = getMediaById(id);
        if (!media)
            return this.json({ error: "Media not found" }, 404);
        const blob = thumbnail && media.thumbnail ? media.thumbnail : media.data;
        const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
        const body = new Blob([buffer], { type: media.content_type });
        return new Response(body, {
            headers: {
                "Content-Type": media.content_type,
            },
        });
    }
    handleMediaInfo(id) {
        const info = getMediaInfoById(id);
        if (!info)
            return this.json({ error: "Media not found" }, 404);
        return this.json(info);
    }
    async serveStatic(relPath) {
        const filePath = resolve(STATIC_DIR, relPath);
        if (!filePath.startsWith(STATIC_DIR))
            return this.json({ error: "Not found" }, 404);
        const file = Bun.file(filePath);
        if (!(await file.exists()))
            return this.json({ error: "Not found" }, 404);
        const contentType = MIME_TYPES[extname(filePath)] || "application/octet-stream";
        return new Response(file, {
            headers: {
                "Content-Type": contentType,
            },
        });
    }
    async serveDocsStatic(relPath) {
        const filePath = resolve(DOCS_DIR, relPath);
        if (!filePath.startsWith(DOCS_DIR))
            return this.json({ error: "Not found" }, 404);
        const file = Bun.file(filePath);
        if (!(await file.exists()))
            return this.json({ error: "Not found" }, 404);
        const contentType = MIME_TYPES[extname(filePath)] || "application/octet-stream";
        return new Response(file, {
            headers: {
                "Content-Type": contentType,
            },
        });
    }
    json(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: {
                "Content-Type": "application/json",
            },
        });
    }
    clampInt(value, fallback, min, max) {
        const parsed = value ? parseInt(value, 10) : fallback;
        if (Number.isNaN(parsed))
            return fallback;
        return Math.min(Math.max(parsed, min), max);
    }
    parseOptionalInt(value) {
        if (!value)
            return null;
        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? null : parsed;
    }
}
