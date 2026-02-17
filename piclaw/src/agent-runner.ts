import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AGENT_TIMEOUT, DATA_DIR, SESSIONS_DIR, WORKSPACE_DIR } from "./config.js";

export interface AgentOutput {
  status: "success" | "error";
  result: string | null;
  error?: string;
}

export async function runAgent(prompt: string, chatJid: string): Promise<AgentOutput> {
  const startTime = Date.now();
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const logsDir = join(WORKSPACE_DIR, "logs");
  mkdirSync(logsDir, { recursive: true });

  // LLM provider/model/keys are configured via pi's own settings
  // (~/.pi/agent/settings.json) — no API keys needed here.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: process.env.HOME || "/home/agent",
    TERM: "xterm-256color",
    PICLAW_DATA: DATA_DIR,
    PICLAW_CHAT_JID: chatJid,
  };

  const args = ["pi", "--print", "--session-dir", SESSIONS_DIR, "-c", prompt];
  console.log(`[agent] Spawning pi (${prompt.length} chars)`);

  const proc = Bun.spawn(args, { cwd: WORKSPACE_DIR, env, stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // SIGKILL fallback if SIGTERM doesn't terminate the process
    setTimeout(() => { try { proc.kill(9); } catch {} }, 5000);
  }, AGENT_TIMEOUT);

  const collect = async (s: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!s) return "";
    const chunks: Uint8Array[] = [];
    for await (const chunk of s) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf-8");
  };

  const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
  clearTimeout(timeout);

  const duration = Date.now() - startTime;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(logsDir, `agent-${ts}.log`), `Duration: ${duration}ms\nExit: ${exitCode}\nTimedOut: ${timedOut}\n\n=== stdout ===\n${stdout.slice(0, 50000)}\n\n=== stderr ===\n${stderr.slice(0, 10000)}`);

  if (timedOut) return { status: "error", result: null, error: `Timed out after ${AGENT_TIMEOUT}ms` };
  if (exitCode !== 0) return { status: "error", result: null, error: `Exit code ${exitCode}: ${stderr.slice(-200)}` };

  const result = stdout.trim();
  console.log(`[agent] Done in ${duration}ms (${result.length} chars)`);
  return { status: "success", result: result || null };
}
