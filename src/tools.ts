import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ImageContent, SessionAttachment, ZulipMessage } from "./types.ts";
import { formatAttachment, messagePlainText, senderName } from "./session/format.ts";
import { ZulipConnection } from "./session/connection.ts";

export interface ToolRuntime {
  getAttachment(): SessionAttachment | undefined;
  getConnection(): ZulipConnection | undefined;
}

const postParams = Type.Object({
  level: Type.Union([Type.Literal("needs_you"), Type.Literal("milestone")], { description: "Blocking decision/issue or a meaningful milestone" }),
  text: Type.String({ minLength: 1, maxLength: 20000, description: "Concise update for the attached Zulip topic" }),
  files: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Optional project-relative files the user explicitly requested to share. Each may be at most 15 MiB; all files together may be at most 30 MiB. Prefer PNG/JPEG images and H.264 video with yuv420p; avoid uploading large files." })),
});

const readParams = Type.Object({
  anchor: Type.Optional(Type.Number({ minimum: 1, description: "Message ID to page backward from; omit for the latest topic messages" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum messages to return (default 30)" })),
  download_images: Type.Optional(Type.Boolean({ description: "Include small image attachments as image content" })),
});

const statusParams = Type.Object({
  goal: Type.Optional(Type.String({ maxLength: 300 })),
  status: Type.Optional(Type.String({ maxLength: 300 })),
  checklist: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 30 })),
  decision: Type.Optional(Type.String({ maxLength: 500, description: "Append a small decision to the status card's decision log" })),
});

const askParams = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 2, maxItems: 5 }),
  recommended: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Recommended option number, starting at 1" })),
});

const waitParams = Type.Object({ question_id: Type.String({ minLength: 3, maxLength: 80 }) });

export function registerTools(pi: ExtensionAPI, runtime: ToolRuntime): void {
  pi.registerTool({
    name: "zulip_post",
    label: "Zulip Post",
    description: "Post a message directly to this session's attached Zulip topic. Files included in the request are uploaded automatically.",
    promptSnippet: "Post an update to the currently attached Zulip topic.",
    promptGuidelines: ["Post ordinary updates directly without a milestone header. Use needs_you only for a genuine blocker or important decision.", "Keep updates concise and link or attach details instead of pasting long output.", "Attach files only when the user explicitly requests sharing them. Prefer PNG or JPEG images and web-safe video encoded as H.264 with yuv420p pixel format.", "Each attachment may be at most 15 MiB; the combined size of attachments in one post may be at most 30 MiB, with at most five files. Do not waste time uploading oversized files; explain the limit and offer a smaller/compressed version."],
    parameters: postParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const connection = runtime.getConnection();
      if (!connection) return textResult("Not attached to Zulip; use /zulip-start first.");
      try {
        const files = params.files ?? [];
        const id = await connection.post(params.level, params.text, files, ctx.cwd);
        return textResult(formatPostResult(id, params.text, files));
      } catch (error) {
        return textResult(`Zulip post failed: ${safeError(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "zulip_read",
    label: "Zulip Read",
    description: "Read a bounded page of history from this session's owned Zulip topic only. Never query another channel or topic.",
    promptSnippet: "Read recent or earlier messages from the attached Zulip topic.",
    parameters: readParams,
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const connection = runtime.getConnection();
      if (!connection) return textResult("Not attached to Zulip; use /zulip-start first.");
      try {
        const messages = await connection.read(params.anchor, params.limit ?? 30, signal);
        if (!messages.length) return textResult("No messages found in the attached topic.");
        const content: Array<{ type: "text"; text: string } | ImageContent> = [];
        let imageCount = 0;
        for (const message of messages) {
          content.push({ type: "text", text: formatReadMessage(message) });
          if (params.download_images && imageCount < 3) {
            const images = await connection.imagesForMessage(message, signal);
            content.push(...images.slice(0, 3 - imageCount));
            imageCount += Math.min(images.length, 3 - imageCount);
          }
        }
        return { content, details: {} };
      } catch (error) {
        return textResult(`Zulip read failed: ${safeError(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "zulip_status",
    label: "Zulip Status",
    description: "Inspect or update this session's Zulip status card. Use decision to record small decisions and proceed without blocking.",
    promptSnippet: "Inspect or update the attached Zulip status card and decision log.",
    parameters: statusParams,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const connection = runtime.getConnection();
      if (!connection) return textResult("Not attached to Zulip; use /zulip-start first.");
      try {
        if (params.goal !== undefined || params.status !== undefined || params.checklist !== undefined || params.decision !== undefined) {
          await connection.updateStatusCard(params);
        }
        return textResult(await connection.getStatus());
      } catch (error) {
        return textResult(`Zulip status update failed: ${safeError(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "zulip_ask",
    label: "Zulip Ask",
    description: "Ask the configured human a blocking decision by posting a 🔴 question with numbered reaction options. Returns immediately so independent work can continue.",
    promptSnippet: "Ask a high-impact decision in Zulip without waiting for the answer.",
    parameters: askParams,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const connection = runtime.getConnection();
      if (!connection) return textResult("Not attached to Zulip; use /zulip-start first.");
      try {
        const result = await connection.createQuestion(params.question, params.options, params.recommended === undefined ? undefined : params.recommended - 1);
        const reactions = result.reactionErrors.length
          ? `Pre-added ${result.reactionsAdded}/${params.options.length} numbered reactions; failures: ${result.reactionErrors.join("; ")}. The human can still reply with the question ID.`
          : `Pre-added ${result.reactionsAdded} numbered reaction answers.`;
        return textResult(`Asked the human in Zulip. Question ID: ${result.id}. ${reactions} Continue independent work; call zulip_wait only if this turn must pause for the answer.`);
      } catch (error) {
        return textResult(`Could not ask in Zulip: ${safeError(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "zulip_wait",
    label: "Wait for Zulip Answer",
    description: "Wait without a timeout for a previously asked Zulip question. Use only when the current turn cannot continue independently.",
    promptSnippet: "Wait for a human answer to a specific open Zulip question.",
    parameters: waitParams,
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const connection = runtime.getConnection();
      if (!connection) return textResult("Not attached to Zulip; cannot wait for an answer.");
      try {
        const answer = await connection.waitForQuestion(params.question_id, signal);
        return textResult(`Human answered ${params.question_id}: ${answer}`);
      } catch (error) {
        return textResult(`Zulip wait ended: ${safeError(error)}`);
      }
    },
  });
}

export function formatPostResult(id: number, text: string, files: string[] = []): string {
  const attachments = files.length ? `\n\nAttachments uploaded: ${files.join(", ")}` : "";
  return `Posted to the attached Zulip topic (message ${id}):\n\n${text.trim()}${attachments}`;
}

function formatReadMessage(message: ZulipMessage): string {
  const attachments = (message.attachments ?? []).map(formatAttachment).join(", ");
  const text = messagePlainText(message, 6000) || "(empty message)";
  return `#${message.id} — ${senderName(message)}${message.subject ? ` in ${message.subject}` : ""}\n${text}${attachments ? `\nAttachments: ${attachments}` : ""}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "<server>").slice(0, 300) : "unknown error";
}
