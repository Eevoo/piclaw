import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function formatDay(d: Date) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${dayNames[d.getDay()]} ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("token chart outputs chart first and summary lines", () => {
  const sessionsDir = join(tmpdir(), `piclaw-sessions-${Date.now()}`);
  mkdirSync(sessionsDir, { recursive: true });

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const entries = [
    {
      type: "message",
      timestamp: now.toISOString(),
      message: {
        role: "assistant",
        usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      timestamp: yesterday.toISOString(),
      message: {
        role: "assistant",
        usage: { input: 300, output: 200, cacheRead: 100, cacheWrite: 50 },
        timestamp: Date.now(),
      },
    },
  ];

  writeFileSync(join(sessionsDir, "session.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n"));

  const proc = Bun.spawnSync([
    "bun",
    "/workspace/piclaw/scripts/token-chart.ts",
    "--days",
    "2",
    "--sessions-dir",
    sessionsDir,
  ]);

  const output = proc.stdout.toString();
  const lines = output.trim().split("\n");

  expect(lines[0].startsWith("![token-chart](data:image/svg+xml;base64,"))
    .toBe(true);

  const todayLine = lines.find((line) => line.includes(formatDay(now)));
  const yesterdayLine = lines.find((line) => line.includes(formatDay(yesterday)));

  expect(todayLine).toContain("1.8K tokens");
  expect(yesterdayLine).toContain("650 tokens");
  expect(todayLine).toContain("cached 300");
  expect(yesterdayLine).toContain("cached 150");
});
