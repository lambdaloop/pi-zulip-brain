import type { StatusCard, ZulipAttachment, ZulipMessage, ZulipUser } from "../types.ts";

export function renderStatusCard(card: StatusCard): string {
  const lines = [`**Goal:** ${card.goal || "(not set)"}`, `**Status:** ${card.status || "working"}`];
  if (card.checklist.length) lines.push("", "**Checklist**", ...card.checklist.map((item) => `- ${item}`));
  if (card.decisions.length) lines.push("", "**Decision log**", ...card.decisions.map((item) => `- ${item}`));
  return lines.join("\n");
}

export function formatOutbound(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 1200) return trimmed;
  const fence = "```";
  return `${fence}spoiler Full details\n${trimmed}\n${fence}`;
}

export function mentionUser(user: Pick<ZulipUser, "user_id" | "full_name">): string {
  const name = user.full_name.replace(/[|*\[\]<>]/g, "").trim() || "user";
  return `@**${name}|${user.user_id}**`;
}

export function senderName(message: ZulipMessage, user?: Pick<ZulipUser, "full_name">): string {
  return user?.full_name || message.sender_full_name || message.sender_email || `user ${message.sender_id}`;
}

export function messagePlainText(message: ZulipMessage, maxLength = 8000): string {
  const html = typeof message.content === "string" ? message.content : "";
  const text = htmlToText(html).trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[…truncated]` : text;
}

export function formatIncomingMessage(
  message: ZulipMessage,
  sender: Pick<ZulipUser, "full_name"> | undefined,
  channelName: string,
  topic: string,
  extra?: string,
): string {
  const body = messagePlainText(message) || "(empty message)";
  const attachments = (message.attachments ?? []).map((attachment) => formatAttachment(attachment)).filter(Boolean);
  const suffix = attachments.length ? `\nAttachments: ${attachments.join(", ")}` : "";
  const prefix = extra ? `${extra}\n` : "";
  return `${prefix}[Zulip steering — ${senderName(message, sender)} in #${channelName} > ${topic}]\n${body}${suffix}`;
}

export function formatAttachment(attachment: ZulipAttachment): string {
  const path = attachment.path.startsWith("/") ? attachment.path : `/${attachment.path}`;
  const size = typeof attachment.size === "number" ? `, ${formatBytes(attachment.size)}` : "";
  return `[${attachment.name}${size}](${path})`;
}

export function isImageAttachment(attachment: ZulipAttachment): boolean {
  const name = attachment.name.toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/.test(name) ||
    ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"].includes(attachment.content_type ?? "");
}

export function attachmentMimeType(attachment: ZulipAttachment, responseType?: string): string {
  if (responseType?.startsWith("image/")) return responseType.split(";")[0];
  if (attachment.content_type?.startsWith("image/")) return attachment.content_type;
  const extension = attachment.name.toLowerCase().split(".").pop();
  const byExtension: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  };
  return byExtension[extension ?? ""] ?? "application/octet-stream";
}

export function htmlToText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const content = stripTags(label).trim();
      return content && content !== href ? `${content} (${href})` : href;
    })
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_match, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, "");
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
