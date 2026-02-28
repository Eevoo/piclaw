import Database from "bun:sqlite";
import fs from "fs";
import path from "path";
import { STORE_DIR } from "./config.js";
let db;
function createSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      chat_jid UNINDEXED,
      sender UNINDEXED,
      sender_name UNINDEXED,
      timestamp UNINDEXED,
      is_bot_message UNINDEXED,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, chat_jid, sender, sender_name, timestamp, is_bot_message)
      VALUES (new.rowid, new.content, new.chat_jid, new.sender, new.sender_name, new.timestamp, new.is_bot_message);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, chat_jid, sender, sender_name, timestamp, is_bot_message)
      VALUES ('delete', old.rowid, old.content, old.chat_jid, old.sender, old.sender_name, old.timestamp, old.is_bot_message);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, chat_jid, sender, sender_name, timestamp, is_bot_message)
      VALUES ('delete', old.rowid, old.content, old.chat_jid, old.sender, old.sender_name, old.timestamp, old.is_bot_message);
      INSERT INTO messages_fts(rowid, content, chat_jid, sender, sender_name, timestamp, is_bot_message)
      VALUES (new.rowid, new.content, new.chat_jid, new.sender, new.sender_name, new.timestamp, new.is_bot_message);
    END;

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      data BLOB NOT NULL,
      thumbnail BLOB,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_media (
      message_rowid INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      PRIMARY KEY (message_rowid, media_id),
      FOREIGN KEY (media_id) REFERENCES media(id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_media_message_rowid ON message_media(message_rowid);
    CREATE INDEX IF NOT EXISTS idx_message_media_media_id ON message_media(media_id);

    CREATE TABLE IF NOT EXISTS tool_outputs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source TEXT,
      size_bytes INTEGER,
      line_count INTEGER,
      summary TEXT,
      path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_outputs_created_at ON tool_outputs(created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS tool_outputs_fts USING fts5(
      content,
      output_id UNINDEXED
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
function ensureFts(database) {
    const row = database.prepare("PRAGMA user_version").get();
    const version = typeof row?.user_version === "number" ? row.user_version : 0;
    if (version >= 1)
        return;
    database.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
    database.exec("PRAGMA user_version = 1;");
}
export function initDatabase() {
    const dbPath = path.join(STORE_DIR, "messages.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    createSchema(db);
    ensureFts(db);
}
export function storeChatMetadata(chatJid, timestamp, name) {
    if (name) {
        db.prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         last_message_time = MAX(last_message_time, excluded.last_message_time)`).run(chatJid, name, timestamp);
    }
    else {
        db.prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         last_message_time = MAX(last_message_time, excluded.last_message_time)`).run(chatJid, chatJid, timestamp);
    }
}
export function storeMessage(msg) {
    db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.id, msg.chat_jid, msg.sender, msg.sender_name, msg.content, msg.timestamp, msg.is_from_me ? 1 : 0, msg.is_bot_message ? 1 : 0);
    const row = db
        .prepare("SELECT rowid as rowid FROM messages WHERE id = ? AND chat_jid = ?")
        .get(msg.id, msg.chat_jid);
    return row?.rowid ?? 0;
}
const DEFAULT_WEB_CONTENT_MAX_CHARS = 65_536;
const WEB_CONTENT_MAX_CHARS = (() => {
    const raw = Number.parseInt(process.env.PICLAW_WEB_MAX_CONTENT_CHARS || "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WEB_CONTENT_MAX_CHARS;
})();
export function clampWebContent(content) {
    const safeContent = typeof content === "string" ? content : String(content ?? "");
    const length = safeContent.length;
    if (length <= WEB_CONTENT_MAX_CHARS)
        return { content: safeContent };
    return {
        content: "",
        meta: {
            truncated: true,
            original_length: length,
            max_length: WEB_CONTENT_MAX_CHARS,
        },
    };
}
function buildInteraction(row, mediaIds = []) {
    const { content, meta } = clampWebContent(row.content);
    return {
        id: row.rowid,
        timestamp: row.timestamp,
        data: {
            type: row.is_bot_message ? "agent_response" : "user_message",
            content,
            content_meta: meta,
            agent_id: "default",
            media_ids: mediaIds,
        },
    };
}
export function attachMediaToMessage(messageRowId, mediaIds) {
    if (mediaIds.length === 0)
        return;
    const stmt = db.prepare("INSERT OR IGNORE INTO message_media (message_rowid, media_id) VALUES (?, ?)");
    for (const mediaId of mediaIds) {
        stmt.run(messageRowId, mediaId);
    }
}
export function getMediaIdsForMessage(messageRowId) {
    const rows = db
        .prepare("SELECT media_id FROM message_media WHERE message_rowid = ? ORDER BY media_id")
        .all(messageRowId);
    return rows.map((row) => row.media_id);
}
export function createMedia(filename, contentType, data, thumbnail, metadata) {
    const res = db
        .prepare(`INSERT INTO media (filename, content_type, data, thumbnail, metadata)
       VALUES (?, ?, ?, ?, ?)`)
        .run(filename, contentType, data, thumbnail, metadata ? JSON.stringify(metadata) : null);
    return Number(res.lastInsertRowid || 0);
}
export function getMediaById(id) {
    const row = db
        .prepare("SELECT id, filename, content_type, data, thumbnail, metadata, created_at FROM media WHERE id = ?")
        .get(id);
    if (!row)
        return undefined;
    return {
        id: row.id,
        filename: row.filename,
        content_type: row.content_type,
        data: row.data,
        thumbnail: row.thumbnail,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        created_at: row.created_at,
    };
}
export function getMediaInfoById(id) {
    const row = db
        .prepare("SELECT id, filename, content_type, metadata, created_at FROM media WHERE id = ?")
        .get(id);
    if (!row)
        return undefined;
    return {
        id: row.id,
        filename: row.filename,
        content_type: row.content_type,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        created_at: row.created_at,
    };
}
export function getMessageByRowId(chatJid, rowId) {
    const row = db
        .prepare("SELECT rowid, chat_jid, sender, sender_name, content, timestamp, is_bot_message FROM messages WHERE chat_jid = ? AND rowid = ?")
        .get(chatJid, rowId);
    if (!row)
        return undefined;
    const mediaIds = getMediaIdsForMessage(row.rowid);
    return buildInteraction(row, mediaIds);
}
export function deleteMessageByRowId(chatJid, rowId) {
    db.prepare("DELETE FROM message_media WHERE message_rowid = ?").run(rowId);
    const res = db.prepare("DELETE FROM messages WHERE chat_jid = ? AND rowid = ?").run(chatJid, rowId);
    return res.changes > 0;
}
export function getTimeline(chatJid, limit, beforeId) {
    const rows = beforeId
        ? db
            .prepare("SELECT rowid, chat_jid, sender, sender_name, content, timestamp, is_bot_message FROM messages WHERE chat_jid = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
            .all(chatJid, beforeId, limit)
        : db
            .prepare("SELECT rowid, chat_jid, sender, sender_name, content, timestamp, is_bot_message FROM messages WHERE chat_jid = ? ORDER BY rowid DESC LIMIT ?")
            .all(chatJid, limit);
    const interactions = rows.map((row) => buildInteraction(row, getMediaIdsForMessage(row.rowid)));
    return interactions.reverse();
}
export function hasOlderMessages(chatJid, oldestId) {
    const row = db
        .prepare("SELECT rowid FROM messages WHERE chat_jid = ? AND rowid < ? LIMIT 1")
        .get(chatJid, oldestId);
    return Boolean(row);
}
export function getMessagesByHashtag(chatJid, hashtag, limit, offset) {
    const pattern = `%#${hashtag}%`;
    const rows = db
        .prepare("SELECT rowid, chat_jid, sender, sender_name, content, timestamp, is_bot_message FROM messages WHERE chat_jid = ? AND content LIKE ? COLLATE NOCASE ORDER BY rowid DESC LIMIT ? OFFSET ?")
        .all(chatJid, pattern, limit, offset);
    return rows.map((row) => buildInteraction(row, getMediaIdsForMessage(row.rowid)));
}
export function searchMessages(chatJid, query, limit, offset) {
    const trimmed = query.trim();
    if (!trimmed)
        return [];
    try {
        const rows = db
            .prepare(`SELECT messages.rowid, messages.chat_jid, messages.sender, messages.sender_name, messages.content, messages.timestamp, messages.is_bot_message
         FROM messages
         JOIN messages_fts ON messages_fts.rowid = messages.rowid
         WHERE messages.chat_jid = ? AND messages_fts MATCH ?
         ORDER BY messages.rowid DESC
         LIMIT ? OFFSET ?`)
            .all(chatJid, trimmed, limit, offset);
        return rows.map((row) => buildInteraction(row, getMediaIdsForMessage(row.rowid)));
    }
    catch {
        const pattern = `%${query}%`;
        const rows = db
            .prepare("SELECT rowid, chat_jid, sender, sender_name, content, timestamp, is_bot_message FROM messages WHERE chat_jid = ? AND content LIKE ? COLLATE NOCASE ORDER BY rowid DESC LIMIT ? OFFSET ?")
            .all(chatJid, pattern, limit, offset);
        return rows.map((row) => buildInteraction(row, getMediaIdsForMessage(row.rowid)));
    }
}
export function getNewMessages(jids, lastTimestamp, botPrefix) {
    if (jids.length === 0)
        return { messages: [], newTimestamp: lastTimestamp };
    const placeholders = jids.map(() => "?").join(",");
    const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
    const rows = db.prepare(sql).all(lastTimestamp, ...jids, `${botPrefix}:%`);
    let newTimestamp = lastTimestamp;
    for (const row of rows) {
        if (row.timestamp > newTimestamp)
            newTimestamp = row.timestamp;
    }
    return { messages: rows, newTimestamp };
}
export function getMessagesSince(chatJid, sinceTimestamp, botPrefix) {
    const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
    return db.prepare(sql).all(chatJid, sinceTimestamp, `${botPrefix}:%`);
}
export function createTask(task) {
    db.prepare(`INSERT INTO scheduled_tasks (id, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(task.id, task.chat_jid, task.prompt, task.schedule_type, task.schedule_value, task.next_run, task.status, task.created_at);
}
export function getTaskById(id) {
    return db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
}
export function updateTask(id, updates) {
    const fields = [];
    const values = [];
    if (updates.prompt !== undefined) {
        fields.push("prompt = ?");
        values.push(updates.prompt);
    }
    if (updates.schedule_type !== undefined) {
        fields.push("schedule_type = ?");
        values.push(updates.schedule_type);
    }
    if (updates.schedule_value !== undefined) {
        fields.push("schedule_value = ?");
        values.push(updates.schedule_value);
    }
    if (updates.next_run !== undefined) {
        fields.push("next_run = ?");
        values.push(updates.next_run);
    }
    if (updates.status !== undefined) {
        fields.push("status = ?");
        values.push(updates.status);
    }
    if (fields.length === 0)
        return;
    values.push(id);
    db.prepare(`UPDATE scheduled_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}
export function deleteTask(id) {
    db.prepare("DELETE FROM task_run_logs WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
}
export function getDueTasks() {
    const now = new Date().toISOString();
    return db
        .prepare(`SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
       ORDER BY next_run`)
        .all(now);
}
export function updateTaskAfterRun(id, nextRun, lastResult) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE scheduled_tasks
     SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
     WHERE id = ?`).run(nextRun, now, lastResult, nextRun, id);
}
export function logTaskRun(log) {
    db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}
export function getTaskRunLogs(taskId) {
    return db
        .prepare("SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at")
        .all(taskId);
}
export function storeToolOutput(record) {
    db.prepare(`INSERT OR REPLACE INTO tool_outputs (id, created_at, source, size_bytes, line_count, summary, path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.created_at, record.source, record.size_bytes, record.line_count, record.summary, record.path);
}
export function insertToolOutputChunk(outputId, content) {
    db.prepare("INSERT INTO tool_outputs_fts (content, output_id) VALUES (?, ?)")
        .run(content, outputId);
}
export function getToolOutputById(id) {
    return db.prepare("SELECT * FROM tool_outputs WHERE id = ?").get(id);
}
export function deleteToolOutputById(id) {
    db.prepare("DELETE FROM tool_outputs WHERE id = ?").run(id);
    db.prepare("DELETE FROM tool_outputs_fts WHERE output_id = ?").run(id);
}
export function deleteToolOutputsBefore(cutoffIso) {
    const rows = db
        .prepare("SELECT * FROM tool_outputs WHERE created_at < ?")
        .all(cutoffIso);
    for (const row of rows) {
        deleteToolOutputById(row.id);
    }
    return rows;
}
export function searchToolOutputSnippets(outputId, query, limit = 5) {
    const stmt = db.prepare("SELECT snippet(tool_outputs_fts, 0, '[', ']', '…', 12) as snippet FROM tool_outputs_fts WHERE tool_outputs_fts MATCH ? AND output_id = ? LIMIT ?");
    const rows = stmt.all(query, outputId, limit);
    return rows.map((row) => row.snippet);
}
// --- Router state accessors ---
export function getRouterState(key) {
    const row = db.prepare("SELECT value FROM router_state WHERE key = ?").get(key);
    return row?.value;
}
export function setRouterState(key, value) {
    db.prepare("INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)").run(key, value);
}
