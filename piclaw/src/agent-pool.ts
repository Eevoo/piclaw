import { mkdirSync } from "fs";
import { join } from "path";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";

import { applyControlCommand, type AgentControlCommand, type AgentControlResult } from "./agent-control.js";
import { AGENT_TIMEOUT, SESSIONS_DIR, WORKSPACE_DIR } from "./config.js";
import { detectChannel } from "./router.js";
import { createTrackedBashOperations } from "./tools/tracked-bash.js";
import { AttachmentRegistry, type AttachmentInfo } from "./agent-pool/attachments.js";
import { writeAgentLog } from "./agent-pool/logging.js";
import { createDefaultSession, ensureSessionDir } from "./agent-pool/session.js";
import { executeSlashCommand } from "./agent-pool/slash-command.js";
import { createSessionTools } from "./agent-pool/tools.js";

export interface AgentOutput {
  status: "success" | "error";
  result: string | null;
  error?: string;
  attachments?: AttachmentInfo[];
}

export interface AutoCompactNotice {
  phase: "pre" | "post";
  status: "start" | "end" | "error";
  tokens: number;
  contextWindow: number;
  percent: number | null;
  threshold: number;
  error?: string;
}

export interface RunAgentOptions {
  onEvent?: (event: AgentSessionEvent) => void;
  onAutoCompact?: (notice: AutoCompactNotice) => void;
  autoCompactPhases?: Array<"pre" | "post">;
}

export interface AgentPoolOptions {
  createSession?: (chatJid: string, sessionDir: string) => Promise<AgentSession>;
  modelRegistry?: ModelRegistry;
}

interface PoolEntry {
  session: AgentSession;
  lastUsed: number;
}

/** How long (ms) an idle session stays cached before being disposed. */
const IDLE_TTL = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL = 60 * 1000; // check every minute

/**
 * Manages a pool of persistent AgentSession instances keyed by chat JID.
 *
 * First invocation for a JID pays the warm-up cost (resource discovery,
 * model initialisation). Subsequent calls reuse the live session – no
 * process-spawn overhead, conversation context already loaded.
 */
export class AgentPool {
  private pool = new Map<string, PoolEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Shared across all sessions (expensive to create, safe to reuse)
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private settingsManager = SettingsManager.create(WORKSPACE_DIR, getAgentDir());
  private logsDir = join(WORKSPACE_DIR, "logs");
  private createSession?: AgentPoolOptions["createSession"];
  private sessionBinder?: (session: AgentSession, chatJid: string) => Promise<void> | void;
  private bashOperations = createTrackedBashOperations();
  private attachments = new AttachmentRegistry();

  constructor(options: AgentPoolOptions = {}) {
    this.createSession = options.createSession;
    this.authStorage = AuthStorage.create();
    this.modelRegistry = options.modelRegistry ?? new ModelRegistry(this.authStorage);
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.evictIdle(), CLEANUP_INTERVAL);
  }

  setSessionBinder(binder?: (session: AgentSession, chatJid: string) => Promise<void> | void): void {
    this.sessionBinder = binder;
    if (!binder) return;
    for (const [jid, entry] of this.pool) {
      try {
        void binder(entry.session, jid);
      } catch (err) {
        console.error(`[agent-pool] Failed to bind session ${jid}:`, err);
      }
    }
  }

  /** Run a prompt against the persistent session for `chatJid`. */
  async runAgent(prompt: string, chatJid: string, options: RunAgentOptions = {}): Promise<AgentOutput> {
    const startTime = Date.now();
    this.attachments.clear(chatJid);

    try {
      const session = await this.getOrCreate(chatJid);
      console.log(`[agent-pool] Prompting session ${chatJid} (${prompt.length} chars)`);

      let result = "";
      const onEvent = options.onEvent;
      const unsub = session.subscribe((event: AgentSessionEvent) => {
        if (onEvent) {
          try {
            onEvent(event);
          } catch (err) {
            console.warn("[agent-pool] Event handler error:", err);
          }
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          result += event.assistantMessageEvent.delta;
        }
      });

      let timedOut = false;
      const timeoutId = setTimeout(async () => {
        timedOut = true;
        console.error(`[agent-pool] Timeout after ${AGENT_TIMEOUT}ms for ${chatJid}`);
        await session.abort();
      }, AGENT_TIMEOUT);

      process.env.PICLAW_CHAT_JID = chatJid;
      process.env.PICLAW_CHANNEL = detectChannel(chatJid);

      const phases = options.autoCompactPhases ?? ["pre", "post"];
      if (phases.includes("pre")) {
        await this.maybeAutoCompact(session, "pre", options.onAutoCompact);
      }

      try {
        await session.prompt(prompt);
      } finally {
        clearTimeout(timeoutId);
        unsub();
      }

      if (phases.includes("post")) {
        await this.maybeAutoCompact(session, "post", options.onAutoCompact);
      }

      const duration = Date.now() - startTime;
      const attachments = this.attachments.take(chatJid);
      writeAgentLog(this.logsDir, chatJid, duration, timedOut, result, null);

      if (timedOut) {
        return { status: "error", result: null, error: `Timed out after ${AGENT_TIMEOUT}ms` };
      }

      console.log(`[agent-pool] Done in ${duration}ms (${result.length} chars, session ${chatJid})`);
      return {
        status: "success",
        result: result.trim() || null,
        attachments: attachments.length ? attachments : undefined,
      };
    } catch (err) {
      this.attachments.clear(chatJid);
      const duration = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      writeAgentLog(this.logsDir, chatJid, duration, false, null, errorMsg);
      console.error(`[agent-pool] Error for ${chatJid}:`, errorMsg);
      return { status: "error", result: null, error: errorMsg };
    }
  }

  async applyControlCommand(chatJid: string, command: AgentControlCommand): Promise<AgentControlResult> {
    const session = await this.getOrCreate(chatJid);
    process.env.PICLAW_CHAT_JID = chatJid;
    process.env.PICLAW_CHANNEL = detectChannel(chatJid);
    return applyControlCommand(session, this.modelRegistry, command);
  }

  async queueStreamingMessage(
    chatJid: string,
    text: string,
    behavior: "steer" | "followUp"
  ): Promise<{ queued: boolean; error?: string }> {
    const session = await this.getOrCreate(chatJid);
    if (!session.isStreaming) return { queued: false };

    process.env.PICLAW_CHAT_JID = chatJid;
    process.env.PICLAW_CHANNEL = detectChannel(chatJid);

    try {
      await session.prompt(text, { streamingBehavior: behavior });
      return { queued: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { queued: false, error: message };
    }
  }

  /** Execute a raw slash command in the AgentSession (extension commands). */
  async applySlashCommand(chatJid: string, rawText: string): Promise<AgentControlResult> {
    this.attachments.clear(chatJid);
    const session = await this.getOrCreate(chatJid);
    const result = await executeSlashCommand(session, chatJid, rawText);
    this.attachments.clear(chatJid);
    return result;
  }

  /** Gracefully shut down all sessions. */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [jid, entry] of this.pool) {
      try {
        entry.session.dispose();
        console.log(`[agent-pool] Disposed session ${jid}`);
      } catch (err) {
        console.error(`[agent-pool] Error disposing ${jid}:`, err);
      }
    }
    this.pool.clear();
  }

  // ── internal ────────────────────────────────────────────

  private async getOrCreate(chatJid: string): Promise<AgentSession> {
    const existing = this.pool.get(chatJid);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.session;
    }

    console.log(`[agent-pool] Creating new session for ${chatJid}`);

    const chatSessionDir = ensureSessionDir(chatJid);

    if (this.createSession) {
      const session = await this.createSession(chatJid, chatSessionDir);
      this.pool.set(chatJid, { session, lastUsed: Date.now() });
      await this.bindSession(session, chatJid);
      console.log(`[agent-pool] Session ready for ${chatJid} (pool size: ${this.pool.size})`);
      return session;
    }

    const { tools, customTools } = createSessionTools(
      WORKSPACE_DIR,
      this.bashOperations,
      chatJid,
      this.attachments,
    );
    const session = await createDefaultSession(chatJid, {
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      tools,
      customTools,
    });

    this.pool.set(chatJid, { session, lastUsed: Date.now() });
    await this.bindSession(session, chatJid);
    console.log(`[agent-pool] Session ready for ${chatJid} (pool size: ${this.pool.size})`);
    return session;
  }

  private async bindSession(session: AgentSession, chatJid: string): Promise<void> {
    if (!this.sessionBinder) return;
    try {
      await this.sessionBinder(session, chatJid);
    } catch (err) {
      console.error(`[agent-pool] Failed to bind session ${chatJid}:`, err);
    }
  }

  private async maybeAutoCompact(
    session: AgentSession,
    phase: "pre" | "post",
    onAutoCompact?: (notice: AutoCompactNotice) => void
  ): Promise<void> {
    if (!session.autoCompactionEnabled) return;
    if (session.isCompacting) return;
    const usage = session.getContextUsage();
    if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;
    const settings = this.settingsManager.getCompactionSettings();
    if (!settings.enabled) return;

    const threshold = usage.contextWindow - settings.reserveTokens;
    if (usage.tokens <= threshold) return;

    const noticeBase: AutoCompactNotice = {
      phase,
      status: "start",
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent ?? null,
      threshold,
    };

    onAutoCompact?.(noticeBase);

    try {
      await session.compact();
      onAutoCompact?.({ ...noticeBase, status: "end" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onAutoCompact?.({ ...noticeBase, status: "error", error: message });
    }
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [jid, entry] of this.pool) {
      if (now - entry.lastUsed > IDLE_TTL) {
        console.log(`[agent-pool] Evicting idle session ${jid}`);
        try {
          entry.session.dispose();
        } catch {}
        this.pool.delete(jid);
      }
    }
  }
}
