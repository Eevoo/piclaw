/**
 * Built-in extension factories embedded in the piclaw package.
 * Passed to DefaultResourceLoader via extensionFactories so they load
 * without any file on disk.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { modelControl } from "./model-control.js";
import { scheduledTasks } from "./scheduled-tasks.js";

export const builtinExtensionFactories: ExtensionFactory[] = [
  modelControl,
  scheduledTasks,
];
