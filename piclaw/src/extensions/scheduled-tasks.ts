/**
 * scheduled-tasks – registers /tasks and /scheduled commands that query
 * the SQLite scheduled_tasks table.
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import Database from "bun:sqlite";
import { join } from "path";

interface ScheduledTaskRow {
  id: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  status: string;
  created_at: string;
}

const STATUS_VALUES = new Set(["active", "paused", "completed"]);

function getDbPath(): string {
  const storeDir = process.env.PICLAW_STORE || "/workspace/.piclaw/store";
  return join(storeDir, "messages.db");
}

function summarizePrompt(prompt: string, maxLen = 140): string {
  if (!prompt) return "(no prompt)";
  const firstLine = prompt.replace(/\r\n/g, "\n").split("\n")[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return `${firstLine.slice(0, maxLen - 1)}…`;
}

function formatTask(row: ScheduledTaskRow): string {
  const next = row.next_run ? `next ${row.next_run}` : "next n/a";
  const summary = summarizePrompt(row.prompt);
  return `• ${row.id} (${row.status}) — ${row.schedule_type} ${row.schedule_value}, ${next} — ${summary}`;
}

function listTasks(filter: string | null): { summary: string; lines: string[] } {
  const db = new Database(getDbPath(), { readonly: true });
  try {
    const counts = db
      .query("SELECT status, COUNT(*) as count FROM scheduled_tasks GROUP BY status")
      .all() as Array<{ status: string; count: number }>;
    const countMap = new Map(counts.map((row) => [row.status, row.count]));

    let rows: ScheduledTaskRow[];
    if (filter && STATUS_VALUES.has(filter)) {
      rows = db
        .query(
          "SELECT id, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at FROM scheduled_tasks WHERE status = ? ORDER BY next_run"
        )
        .all(filter) as ScheduledTaskRow[];
    } else {
      rows = db
        .query(
          "SELECT id, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at FROM scheduled_tasks ORDER BY created_at"
        )
        .all() as ScheduledTaskRow[];
    }

    const header =
      filter && STATUS_VALUES.has(filter)
        ? `Scheduled tasks (${filter})`
        : "Scheduled tasks";
    const summary = `Active ${countMap.get("active") ?? 0} • Paused ${countMap.get("paused") ?? 0} • Completed ${countMap.get("completed") ?? 0}`;

    return {
      summary: `${header}\n${summary}`,
      lines: rows.map(formatTask),
    };
  } finally {
    db.close();
  }
}

export const scheduledTasks: ExtensionFactory = (pi: ExtensionAPI) => {
  const handler = async (args: string) => {
    const token = (args || "").trim().toLowerCase();
    const filter = token === "all" || token === "" ? null : token;

    if (filter && !STATUS_VALUES.has(filter)) {
      const message = "Usage: /tasks [all|active|paused|completed]";
      pi.sendMessage({ customType: "scheduled-tasks", content: message, display: true });
      return;
    }

    const { summary, lines } = listTasks(filter);
    const body = lines.length > 0 ? lines.join("\n") : "(no tasks found)";
    const message = `${summary}\n${body}`;
    pi.sendMessage({ customType: "scheduled-tasks", content: message, display: true });
  };

  pi.registerCommand("tasks", {
    description: "List scheduled tasks (all|active|paused|completed)",
    handler,
  });

  pi.registerCommand("scheduled", {
    description: "Alias for /tasks",
    handler,
  });
};
