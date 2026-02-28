import { expect, test } from "bun:test";

import { AttachmentRegistry } from "../src/agent-pool/attachments.js";
import { createSessionTools } from "../src/agent-pool/tools.js";
import { createTrackedBashOperations } from "../src/tools/tracked-bash.js";
import { getTestWorkspace } from "./helpers.js";

test("createSessionTools returns base and custom tools", () => {
  const ws = getTestWorkspace();
  const registry = new AttachmentRegistry();
  const { tools, customTools } = createSessionTools(
    ws.workspace,
    createTrackedBashOperations(),
    "web:default",
    registry,
  );

  expect(tools.length).toBe(4);
  expect(customTools.length).toBe(2);
  const names = customTools.map((tool) => tool.name).sort();
  expect(names).toEqual(["attach_file", "search_messages"]);
});
