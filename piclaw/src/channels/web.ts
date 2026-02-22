import { extname, resolve } from "path";

import { AgentQueue } from "../queue.js";
import type { AgentPool } from "../agent-pool.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { ASSISTANT_NAME, WEB_HOST, WEB_IDLE_TIMEOUT, WEB_PORT } from "../config.js";
import {
  attachMediaToMessage,
  createMedia,
  deleteMessageByRowId,
  getMediaById,
  getMediaInfoById,
  getMessageByRowId,
  getMessagesByHashtag,
  getMessagesSince,
  getRouterState,
  getTimeline,
  hasOlderMessages,
  searchMessages,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from "../db.js";
import { formatMessages, formatOutbound } from "../router.js";
import type { InteractionRow } from "../db.js";
import type { NewMessage } from "../types.js";

const DEFAULT_CHAT_JID = "web:default";
const DEFAULT_AGENT_ID = "default";
const STATE_KEY = "last_agent_timestamp_web";
const STATIC_DIR = resolve(import.meta.dir, "..", "..", "web", "static");
const DOCS_DIR = resolve(import.meta.dir, "..", "..", "docs");

const encoder = new TextEncoder();

const MIME_TYPES: Record<string, string> = {
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

export interface WebChannelOpts {
  queue: AgentQueue;
  agentPool: AgentPool;
}

interface PendingClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: Timer;
}

export class WebChannel {
  private queue: AgentQueue;
  private agentPool: AgentPool;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private lastAgentTimestamp: Record<string, string> = {};
  private clients: Set<PendingClient> = new Set();

  constructor(opts: WebChannelOpts) {
    this.queue = opts.queue;
    this.agentPool = opts.agentPool;
  }

  async start(): Promise<void> {
    this.loadState();
    this.server = Bun.serve({
      hostname: WEB_HOST,
      port: WEB_PORT,
      idleTimeout: WEB_IDLE_TIMEOUT,
      fetch: (req) => this.handleRequest(req),
    });
    console.log(`[web] UI listening on http://${WEB_HOST}:${WEB_PORT}`);
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      try { client.controller.close(); } catch {}
    }
    this.clients.clear();
    this.server?.stop(true);
    this.server = null;
  }

  async sendMessage(chatJid: string, text: string): Promise<void> {
    const interaction = this.storeMessage(chatJid, text, true, []);
    if (interaction) {
      this.broadcastEvent("agent_response", interaction);
    }
  }

  private loadState(): void {
    const data = getRouterState(STATE_KEY);
    try {
      this.lastAgentTimestamp = data ? JSON.parse(data) : {};
    } catch {
      this.lastAgentTimestamp = {};
    }
  }

  private saveState(): void {
    setRouterState(STATE_KEY, JSON.stringify(this.lastAgentTimestamp));
  }

  private async handleRequest(req: Request): Promise<Response> {
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
      if (!query) return this.json({ error: "Missing 'q' parameter" }, 400);
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
      if (!id) return this.json({ error: "Thread not found" }, 404);
      const thread = getMessageByRowId(DEFAULT_CHAT_JID, id);
      if (!thread) return this.json({ error: "Thread not found" }, 404);
      return this.json({ thread: [thread] });
    }

    if (req.method === "DELETE" && pathname.startsWith("/post/")) {
      const id = this.parseOptionalInt(pathname.replace("/post/", ""));
      if (!id) return this.json({ error: "Post not found" }, 404);
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
      return this.json({ status: "ok" });
    }

    if (req.method === "POST" && pathname === "/agent/whitelist") {
      return this.json({ status: "ok" });
    }

    if (req.method === "POST" && pathname === "/media/upload") {
      return this.handleMediaUpload(req);
    }

    if (req.method === "GET" && pathname.startsWith("/media/") && pathname.endsWith("/thumbnail")) {
      const id = this.parseOptionalInt(pathname.replace("/media/", "").replace("/thumbnail", ""));
      if (!id) return this.json({ error: "Media not found" }, 404);
      return this.handleMedia(id, true);
    }

    if (req.method === "GET" && pathname.startsWith("/media/") && pathname.endsWith("/info")) {
      const id = this.parseOptionalInt(pathname.replace("/media/", "").replace("/info", ""));
      if (!id) return this.json({ error: "Media not found" }, 404);
      return this.handleMediaInfo(id);
    }

    if (req.method === "GET" && pathname.startsWith("/media/")) {
      const id = this.parseOptionalInt(pathname.replace("/media/", ""));
      if (!id) return this.json({ error: "Media not found" }, 404);
      return this.handleMedia(id, false);
    }

    return this.json({ error: "Not found" }, 404);
  }

  private handleSse(): Response {
    let clientRef: PendingClient | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
            if (clientRef) this.clients.delete(clientRef);
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

  private broadcastEvent(eventType: string, data: unknown): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = encoder.encode(payload);
    for (const client of this.clients) {
      try {
        client.controller.enqueue(bytes);
      } catch {
        clearInterval(client.heartbeat);
        this.clients.delete(client);
      }
    }
  }

  private async handlePost(req: Request, isReply: boolean): Promise<Response> {
    let data: { content?: string; thread_id?: number | null; media_ids?: number[] };
    try {
      data = await req.json();
    } catch {
      return this.json({ error: "Invalid JSON" }, 400);
    }

    if (!data.content) return this.json({ error: "Missing 'content' field" }, 400);
    if (isReply && !data.thread_id) return this.json({ error: "Missing 'thread_id' field" }, 400);

    const mediaIds = Array.isArray(data.media_ids)
      ? data.media_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : [];

    const interaction = this.storeMessage(DEFAULT_CHAT_JID, data.content, false, mediaIds);
    if (!interaction) return this.json({ error: "Failed to store message" }, 500);

    if (isReply && data.thread_id) interaction.data.thread_id = Number(data.thread_id);

    this.broadcastEvent(isReply ? "new_reply" : "new_post", interaction);
    return this.json(interaction, 201);
  }

  private async handleAgentMessage(req: Request, pathname: string): Promise<Response> {
    const agentId = pathname.split("/")[2] || DEFAULT_AGENT_ID;
    let data: { content?: string; thread_id?: number | null; media_ids?: number[] };
    try {
      data = await req.json();
    } catch {
      return this.json({ error: "Invalid JSON" }, 400);
    }

    if (!data.content) return this.json({ error: "Missing 'content' field" }, 400);

    const mediaIds = Array.isArray(data.media_ids)
      ? data.media_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : [];

    const interaction = this.storeMessage(DEFAULT_CHAT_JID, data.content, false, mediaIds);

    if (!interaction) return this.json({ error: "Failed to store message" }, 500);

    this.broadcastEvent("new_post", interaction);

    this.queue.enqueue(async () => {
      await this.processChat(DEFAULT_CHAT_JID, agentId);
    }, `chat:${DEFAULT_CHAT_JID}`);

    return this.json({ user_message: interaction, thread_id: data.thread_id ?? interaction.id }, 201);
  }

  private async processChat(chatJid: string, agentId: string): Promise<void> {
    const since = this.lastAgentTimestamp[chatJid] || "";
    const messages = getMessagesSince(chatJid, since, ASSISTANT_NAME);
    if (messages.length === 0) return;

    const prompt = formatMessages(messages);
    const prevCursor = this.lastAgentTimestamp[chatJid] || "";
    this.lastAgentTimestamp[chatJid] = messages[messages.length - 1].timestamp;
    this.saveState();

    const threadId = messages[messages.length - 1].timestamp;
    let thoughtBuffer = "";
    let draftBuffer = "";
    const toolTitles = new Map<string, string>();

    const extractToolArgs = (args: unknown): Record<string, unknown> | null => {
      if (!args) return null;
      if (typeof args === "string") {
        try {
          const parsed = JSON.parse(args);
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      if (typeof args === "object") {
        const record = args as Record<string, unknown>;
        const nested =
          (record.arguments as Record<string, unknown> | undefined) ||
          (record.input as Record<string, unknown> | undefined) ||
          (record.params as Record<string, unknown> | undefined) ||
          (record.parameters as Record<string, unknown> | undefined) ||
          (record.args as Record<string, unknown> | undefined) ||
          (record.payload as Record<string, unknown> | undefined);
        return nested ?? record;
      }
      return null;
    };

    const formatToolTitle = (toolName: string, args: unknown): string => {
      const record = extractToolArgs(args);
      if (!record) return toolName;
      let detail: string | null = null;

      const command = record.command;
      if (typeof command === "string") detail = command;

      if (!detail && Array.isArray(record.commands)) {
        detail = record.commands.filter((item) => typeof item === "string").join(" && ");
      }

      const path = record.path || record.filePath || record.target;
      if (!detail && typeof path === "string") detail = path;

      if (!detail && Array.isArray(record.paths)) {
        detail = record.paths.filter((item) => typeof item === "string").join(", ");
      }

      const filename = record.fileName || record.filename || record.file;
      if (!detail && typeof filename === "string") detail = filename;

      const url = record.url;
      if (!detail && typeof url === "string") detail = url;

      const query = record.query;
      if (!detail && typeof query === "string") detail = query;

      if (!detail) return toolName;

      const normalized = detail.replace(/\s+/g, " ").trim();
      const maxLen = 120;
      const clipped = normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized;
      return `${toolName}: ${clipped}`;
    };

    const rememberToolTitle = (toolCallId: string, toolName: string, args: unknown): string => {
      const title = formatToolTitle(toolName, args);
      toolTitles.set(toolCallId, title);
      return title;
    };

    const lookupToolTitle = (toolCallId: string, toolName: string, args?: unknown): string => {
      return toolTitles.get(toolCallId) ?? formatToolTitle(toolName, args);
    };

    this.broadcastEvent("agent_status", {
      thread_id: threadId,
      agent_id: agentId,
      type: "thinking",
      title: "Thinking...",
    });

    const output = await this.agentPool.runAgent(prompt, chatJid, {
      onEvent: (event: AgentSessionEvent) => {
        if (event.type === "message_update") {
          const messageEvent = event.assistantMessageEvent;
          if (messageEvent.type === "thinking_start") {
            thoughtBuffer = "";
          }
          if (messageEvent.type === "thinking_delta") {
            thoughtBuffer += messageEvent.delta;
            this.broadcastEvent("agent_thought", {
              thread_id: threadId,
              agent_id: agentId,
              text: thoughtBuffer,
            });
          }
          if (messageEvent.type === "thinking_end") {
            thoughtBuffer = messageEvent.content || thoughtBuffer;
            this.broadcastEvent("agent_thought", {
              thread_id: threadId,
              agent_id: agentId,
              text: thoughtBuffer,
            });
          }
          if (messageEvent.type === "toolcall_end") {
            const title = rememberToolTitle(
              messageEvent.toolCall.id,
              messageEvent.toolCall.name,
              messageEvent.toolCall.arguments
            );
            this.broadcastEvent("agent_status", {
              thread_id: threadId,
              agent_id: agentId,
              type: "tool_call",
              title,
            });
          }
          if (messageEvent.type === "text_start") {
            draftBuffer = "";
            this.broadcastEvent("agent_draft", {
              thread_id: threadId,
              agent_id: agentId,
              text: "",
              kind: "draft",
              mode: "replace",
            });
          }
          if (messageEvent.type === "text_delta") {
            draftBuffer += messageEvent.delta;
            this.broadcastEvent("agent_draft", {
              thread_id: threadId,
              agent_id: agentId,
              text: messageEvent.delta,
              kind: "draft",
              mode: "append",
            });
          }
        }

        if (event.type === "tool_execution_start") {
          const title = rememberToolTitle(event.toolCallId, event.toolName, event.args);
          this.broadcastEvent("agent_status", {
            thread_id: threadId,
            agent_id: agentId,
            type: "tool_call",
            title,
          });
        }

        if (event.type === "tool_execution_update") {
          const title = lookupToolTitle(event.toolCallId, event.toolName, event.args);
          this.broadcastEvent("agent_status", {
            thread_id: threadId,
            agent_id: agentId,
            type: "tool_status",
            title,
            status: "Working...",
          });
        }

        if (event.type === "tool_execution_end") {
          const title = lookupToolTitle(event.toolCallId, event.toolName);
          toolTitles.delete(event.toolCallId);
          this.broadcastEvent("agent_status", {
            thread_id: threadId,
            agent_id: agentId,
            type: "tool_status",
            title,
            status: event.isError ? "Failed" : "Done",
          });
        }
      },
    });

    if (output.status === "error") {
      this.lastAgentTimestamp[chatJid] = prevCursor;
      this.saveState();
      this.broadcastEvent("agent_status", {
        thread_id: threadId,
        agent_id: agentId,
        type: "error",
        title: output.error || "Agent error",
      });
      return;
    }

    if (output.result) {
      const text = formatOutbound(output.result);
      if (text) {
        const interaction = this.storeMessage(chatJid, text, true, []);
        if (interaction) {
          this.broadcastEvent("agent_response", interaction);
        }
      }
    }

    this.broadcastEvent("agent_status", {
      thread_id: threadId,
      agent_id: agentId,
      type: "done",
    });
  }

  private storeMessage(chatJid: string, content: string, isBot: boolean, mediaIds: number[]): InteractionRow | null {
    const timestamp = new Date().toISOString();
    const msg: NewMessage = {
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
    if (rowId <= 0) return null;

    if (mediaIds.length > 0) {
      attachMediaToMessage(rowId, mediaIds);
    }

    storeChatMetadata(chatJid, timestamp, "Web");

    const interaction = getMessageByRowId(chatJid, rowId);
    if (interaction) {
      interaction.data.agent_id = DEFAULT_AGENT_ID;
      return interaction;
    }

    return {
      id: rowId,
      timestamp,
      data: {
        type: isBot ? "agent_response" : "user_message",
        content,
        agent_id: DEFAULT_AGENT_ID,
        media_ids: mediaIds,
      },
    };
  }

  private async handleMediaUpload(req: Request): Promise<Response> {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return this.json({ error: "Invalid form data" }, 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) return this.json({ error: "Missing file" }, 400);

    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const mediaId = createMedia(
      file.name || "upload",
      file.type || "application/octet-stream",
      data,
      null,
      { size: file.size }
    );

    return this.json({ id: mediaId, filename: file.name, size: file.size });
  }

  private handleMedia(id: number, thumbnail: boolean): Response {
    const media = getMediaById(id);
    if (!media) return this.json({ error: "Media not found" }, 404);

    const blob = thumbnail && media.thumbnail ? media.thumbnail : media.data;
    const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
    const body = new Blob([buffer], { type: media.content_type });
    return new Response(body, {
      headers: {
        "Content-Type": media.content_type,
      },
    });
  }

  private handleMediaInfo(id: number): Response {
    const info = getMediaInfoById(id);
    if (!info) return this.json({ error: "Media not found" }, 404);
    return this.json(info);
  }

  private async serveStatic(relPath: string): Promise<Response> {
    const filePath = resolve(STATIC_DIR, relPath);
    if (!filePath.startsWith(STATIC_DIR)) return this.json({ error: "Not found" }, 404);

    const file = Bun.file(filePath);
    if (!(await file.exists())) return this.json({ error: "Not found" }, 404);

    const contentType = MIME_TYPES[extname(filePath)] || "application/octet-stream";
    return new Response(file, {
      headers: {
        "Content-Type": contentType,
      },
    });
  }

  private async serveDocsStatic(relPath: string): Promise<Response> {
    const filePath = resolve(DOCS_DIR, relPath);
    if (!filePath.startsWith(DOCS_DIR)) return this.json({ error: "Not found" }, 404);

    const file = Bun.file(filePath);
    if (!(await file.exists())) return this.json({ error: "Not found" }, 404);

    const contentType = MIME_TYPES[extname(filePath)] || "application/octet-stream";
    return new Response(file, {
      headers: {
        "Content-Type": contentType,
      },
    });
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  private clampInt(value: string | null, fallback: number, min: number, max: number): number {
    const parsed = value ? parseInt(value, 10) : fallback;
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }

  private parseOptionalInt(value: string | null): number | null {
    if (!value) return null;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
}
