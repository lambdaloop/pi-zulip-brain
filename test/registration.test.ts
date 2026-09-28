import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { formatPostResult } from "../src/tools.ts";
import { wrapSelectionIndex } from "../src/commands/picker.ts";

test("searchable picker wraps navigation between first and last options", () => {
  assert.equal(wrapSelectionIndex(0, -1, 4), 3);
  assert.equal(wrapSelectionIndex(3, 1, 4), 0);
  assert.equal(wrapSelectionIndex(0, 1, 0), 0);
});

test("zulip_post tool result echoes the sent text and attachments into the Pi session", () => {
  assert.equal(formatPostResult(42, "  Status: done  ", ["artifacts/preview.png"]),
    "Posted to the attached Zulip topic (message 42):\n\nStatus: done\n\nAttachments uploaded: artifacts/preview.png");
});

test("registers commands and five dynamically gated tools without starting network work", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  let activeTools = ["read", "bash"];
  const api = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => { events.push(event); return () => undefined; },
    getActiveTools: () => { throw new Error("actions are unavailable while loading"); },
    setActiveTools: (names: string[]) => { activeTools = names; },
  } as unknown as ExtensionAPI;

  extension(api);
  assert.deepEqual(tools.sort(), ["zulip_answer", "zulip_ask", "zulip_post", "zulip_read", "zulip_status", "zulip_wait"]);
  assert.deepEqual(commands.sort(), ["zulip-login", "zulip-logout", "zulip-resolve", "zulip-start", "zulip-status", "zulip-stop"]);
  assert.deepEqual(activeTools, ["read", "bash"]);
  assert.deepEqual(events.sort(), ["before_agent_start", "session_shutdown", "session_start"]);
});
