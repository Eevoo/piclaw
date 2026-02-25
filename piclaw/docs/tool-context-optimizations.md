# Tool Context Optimizations

This document describes the tool-output context reduction system used by PiClaw to reduce prompt bloat from large tool outputs, while keeping results searchable and retrievable.

## Goals

- Reduce context usage when tools (especially `bash`) return large outputs.
- Persist full output for later reference.
- Provide fast search over stored output.
- Automatically clean up old stored outputs.

## How it works

### 1) Intercept large tool outputs

The context-mode extension listens for `bash` tool results. When output exceeds a configured threshold (bytes or line count), it:

1. Reads the full tool output (including from `fullOutputPath` when the base tool truncates).
2. Stores the full output to disk and indexes it in SQLite FTS.
3. Replaces the tool result with a compact summary and a handle.

The summary includes:

- A storage handle (`tool-output:<id>`)
- Line and byte counts
- A short preview
- Instructions to use `tool_output_search`

### 2) Persist output for later retrieval

Tool outputs are stored under:

- `DATA_DIR/tool-output/<id>.log`

Metadata and FTS indexing are stored in the `messages.db` SQLite database.

### 3) Search stored output

A custom tool `tool_output_search` searches stored output using SQLite FTS and returns compact snippets:

```text
tool_output_search
- handle: out_...
- query: <search terms>
- limit: 5 (optional)
```

### 4) Batch exec helper

A second tool, `batch_exec`, runs multiple shell commands and returns concise summaries for each. It uses the same context-aware bash wrapper for output handling.

## Extension entry point

The behavior is enabled by a project-local extension:

- `/workspace/.pi/extensions/context-mode.ts`

A template copy is also available for new projects:

- `/workspace/piclaw/skel/.pi/extensions/context-mode.ts`

## Data model

The following tables are created in `messages.db`:

- `tool_outputs`
  - `id` (TEXT, primary key)
  - `created_at` (TEXT)
  - `source` (TEXT)
  - `size_bytes` (INTEGER)
  - `line_count` (INTEGER)
  - `summary` (TEXT)
  - `path` (TEXT)
- `tool_outputs_fts` (FTS5)
  - `content`
  - `output_id`

These tables are created by `initDatabase()` in `src/db.ts`.

## Cleanup and retention

Tool outputs are pruned on startup and periodically thereafter.

- Default retention: 7 days
- Default cleanup interval: 12 hours

The cleanup removes:

- Database records from `tool_outputs` and `tool_outputs_fts`
- Corresponding files under `DATA_DIR/tool-output`

The cleanup loop is started in `src/index.ts` via:

```ts
startToolOutputCleanup(TOOL_OUTPUT_RETENTION_DAYS, TOOL_OUTPUT_CLEANUP_INTERVAL_MS);
```

## Environment configuration

### Storage thresholds

- `PICLAW_TOOL_OUTPUT_STORE_BYTES` (default: `4096`)
- `PICLAW_TOOL_OUTPUT_STORE_LINES` (default: `40`)

If either threshold is exceeded, the output is stored and summarized.

### Preview size

- `PICLAW_TOOL_OUTPUT_PREVIEW_LINES` (default: `8`)
- `PICLAW_TOOL_OUTPUT_PREVIEW_LINE_CHARS` (default: `200`)

### Retention

- `PICLAW_TOOL_OUTPUT_RETENTION_DAYS` (default: `7`)
- `PICLAW_TOOL_OUTPUT_CLEANUP_INTERVAL_MS` (default: `43200000`)

## Implementation files

- `src/tool-output.ts`
  - Stores full output, builds preview, chunks text for FTS, handles cleanup.
- `src/tools/context-tools.ts`
  - Context-aware bash wrapper, `tool_output_search`, `batch_exec`.
- `.pi/extensions/context-mode.ts`
  - Extension that intercepts bash tool results and registers custom tools.
- `src/db.ts`
  - Database schema and FTS operations for tool outputs.
- `src/config.ts`
  - Retention and cleanup interval configuration.

## Typical flow example

1. `bash` runs a command that outputs 500 lines.
2. Extension stores the output and replaces the tool result with a preview and handle.
3. User searches the output:

```text
tool_output_search
- handle: out_1700000000000_abcdef12
- query: error
```

## Troubleshooting

- If you see raw, large outputs in the assistant response, check the thresholds and ensure the extension is loaded.
- If `tool_output_search` returns no results, verify that `messages.db` contains `tool_outputs` rows and the `.log` file exists.
- If results appear but links are missing, confirm the handle is correct and the output wasn’t pruned.
