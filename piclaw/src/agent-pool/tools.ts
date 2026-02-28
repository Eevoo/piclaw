import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { createAttachmentTool, type AttachmentRegistry } from "./attachments.js";
import { createMessageSearchTool } from "./message-search.js";

export function createSessionTools(
  workspaceDir: string,
  bashOperations: BashOperations,
  chatJid: string,
  attachments: AttachmentRegistry,
) {
  const tools = [
    createReadTool(workspaceDir),
    createBashTool(workspaceDir, { operations: bashOperations }),
    createEditTool(workspaceDir),
    createWriteTool(workspaceDir),
  ];
  const customTools: ToolDefinition[] = [
    createAttachmentTool(chatJid, attachments) as unknown as ToolDefinition,
    createMessageSearchTool(chatJid) as unknown as ToolDefinition,
  ];

  return { tools, customTools };
}
