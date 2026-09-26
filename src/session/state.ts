import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionAttachment, StatusCard } from "../types.ts";

export const SESSION_STATE_ENTRY = "pi-zulip.attachment.v1";

export function readAttachmentFromBranch(entries: unknown[]): SessionAttachment | undefined {
  let latest: SessionAttachment | undefined;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== SESSION_STATE_ENTRY || !isAttachment(item.data)) continue;
    latest = structuredClone(item.data);
  }
  return latest;
}

export function isAttachment(value: unknown): value is SessionAttachment {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<SessionAttachment>;
  return state.version === 1 && typeof state.attached === "boolean" &&
    typeof state.serverHost === "string" && typeof state.channelName === "string" &&
    typeof state.streamId === "number" && typeof state.topic === "string" &&
    typeof state.botEmail === "string" && typeof state.botUserId === "number" &&
    typeof state.notifyUserId === "number" && typeof state.statusMessageId === "number" && Array.isArray(state.ownedMessageIds) &&
    typeof state.lastHandledMessageId === "number" && typeof state.statusCard === "object" &&
    state.statusCard !== null && Array.isArray(state.openQuestions);
}

export function persistAttachment(pi: ExtensionAPI, state: SessionAttachment): void {
  state.updatedAt = new Date().toISOString();
  // API keys and passwords are intentionally absent from the serialized session entry.
  pi.appendEntry(SESSION_STATE_ENTRY, structuredClone(state));
}

export function addOwnedMessage(state: SessionAttachment, messageId: number): void {
  if (!state.ownedMessageIds.includes(messageId)) state.ownedMessageIds.push(messageId);
  if (state.ownedMessageIds.length > 1000) state.ownedMessageIds = state.ownedMessageIds.slice(-1000);
}

export function makeStatusCard(goal: string, status = "working"): StatusCard {
  return { goal, status, checklist: [], decisions: [] };
}
