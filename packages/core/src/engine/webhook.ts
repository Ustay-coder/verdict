/**
 * Delivers terminal evaluation webhooks with optional HMAC authentication.
 * Webhook failures surface as events and must not undo a completed evaluation.
 */
import type { Evaluation } from "../schema/evaluation.js";
import type { EngineEvent } from "./types.js";

/** Notification failures are observable without changing an already persisted evaluation. */
export async function deliverWebhook(ev: Evaluation, fetchImpl: typeof fetch, secret?: string, onEvent?: (event: EngineEvent) => void) {

  if (!ev.webhook) return;
  try {
    const body = JSON.stringify({ type: `evaluation.${ev.status}`, data: ev });
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "verdict-webhooks/0.1" };
    if (secret) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
      headers["verdict-signature"] = `sha256=${Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("")}`;
    }
    const response = await fetchImpl(ev.webhook, { method: "POST", headers, body });
    if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
  } catch (error) {
    onEvent?.({ type: "webhook.failed", evaluationId: ev.id, error: (error as Error).message });
  }
}
