import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import Database from "bun:sqlite";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { scheduledTasks } from "../src/extensions/scheduled-tasks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dir, ".tmp-scheduled-tasks-test");
const DB_PATH = join(TEST_DIR, "messages.db");

function setupDb() {
  mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function insertTask(db: Database, overrides: Record<string, string> = {}) {
  const defaults = {
    id: `task-${Date.now()}`,
    chat_jid: "test@chat",
    prompt: "Do something",
    schedule_type: "cron",
    schedule_value: "0 9 * * *",
    next_run: "2026-03-01T09:00:00Z",
    status: "active",
    created_at: new Date().toISOString(),
  };
  const row = { ...defaults, ...overrides };
  db.run(
    `INSERT INTO scheduled_tasks (id, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.chat_jid, row.prompt, row.schedule_type, row.schedule_value, row.next_run, row.status, row.created_at],
  );
  return row;
}

type CommandEntry = { name: string; handler: (args: string) => Promise<void> };

function createFakeApi() {
  const commands = new Map<string, CommandEntry>();
  const messages: Array<{ customType: string; content: string; display: boolean }> = [];

  const api: ExtensionAPI = {
    on() {},
    registerTool() {},
    registerCommand(name: string, options: any) {
      commands.set(name, { name, handler: options.handler });
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag() { return undefined; },
    registerMessageRenderer() {},
    sendMessage(msg: any) { messages.push(msg); },
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
    setModel: async () => true,
    getThinkingLevel: () => "off" as any,
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
  } as unknown as ExtensionAPI;

  return { api, commands, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scheduled-tasks extension", () => {
  let db: Database;
  let fake: ReturnType<typeof createFakeApi>;

  beforeEach(() => {
    process.env.PICLAW_STORE = TEST_DIR;
    db = setupDb();
    fake = createFakeApi();
    scheduledTasks(fake.api);
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.PICLAW_STORE;
  });

  test("registers /tasks and /scheduled commands", () => {
    expect(fake.commands.has("tasks")).toBe(true);
    expect(fake.commands.has("scheduled")).toBe(true);
  });

  test("/tasks lists all tasks when empty", async () => {
    await fake.commands.get("tasks")!.handler("");
    expect(fake.messages.length).toBe(1);
    expect(fake.messages[0].content).toContain("(no tasks found)");
    expect(fake.messages[0].content).toContain("Active 0");
  });

  test("/tasks lists active tasks", async () => {
    insertTask(db, { id: "t-1", status: "active", prompt: "Morning check" });
    insertTask(db, { id: "t-2", status: "paused", prompt: "Paused job" });

    await fake.commands.get("tasks")!.handler("active");
    expect(fake.messages.length).toBe(1);
    expect(fake.messages[0].content).toContain("t-1");
    expect(fake.messages[0].content).toContain("Morning check");
    // Should not include paused task
    expect(fake.messages[0].content).not.toContain("t-2");
  });

  test("/tasks all lists everything", async () => {
    insertTask(db, { id: "t-a", status: "active" });
    insertTask(db, { id: "t-p", status: "paused" });
    insertTask(db, { id: "t-c", status: "completed" });

    await fake.commands.get("tasks")!.handler("all");
    expect(fake.messages[0].content).toContain("t-a");
    expect(fake.messages[0].content).toContain("t-p");
    expect(fake.messages[0].content).toContain("t-c");
    expect(fake.messages[0].content).toContain("Active 1");
    expect(fake.messages[0].content).toContain("Paused 1");
    expect(fake.messages[0].content).toContain("Completed 1");
  });

  test("/tasks with invalid filter shows usage", async () => {
    await fake.commands.get("tasks")!.handler("bogus");
    expect(fake.messages[0].content).toContain("Usage:");
  });

  test("/scheduled is an alias for /tasks", async () => {
    insertTask(db, { id: "t-s", status: "active", prompt: "Scheduled thing" });

    await fake.commands.get("scheduled")!.handler("");
    expect(fake.messages[0].content).toContain("t-s");
    expect(fake.messages[0].content).toContain("Scheduled thing");
  });

  test("truncates long prompts", async () => {
    const longPrompt = "A".repeat(200);
    insertTask(db, { id: "t-long", prompt: longPrompt });

    await fake.commands.get("tasks")!.handler("");
    // Should be truncated (default 140 chars + ellipsis)
    expect(fake.messages[0].content).not.toContain(longPrompt);
    expect(fake.messages[0].content).toContain("…");
  });
});
