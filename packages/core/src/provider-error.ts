/**
 * Validates untrusted provider payloads before judge mapping.
 * Provider and field context survive conversion into error ratings; no Node APIs are required.
 */
import { z } from "zod";

/** Identifies provider transport or payload failure; status is absent before an HTTP response. */
export class ProviderError extends Error {
  constructor(public provider: string, message: string, public status?: number, options?: ErrorOptions) {
    super(`${provider}: ${message}`, options);
    this.name = "ProviderError";
  }
}

/** Returns validated data or throws ProviderError naming the first invalid field. */
export function parseProvider<T>(provider: string, schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new ProviderError(provider, `invalid ${issue.path.join(".") || "response"}: ${issue.message}`, undefined, { cause: result.error });
}

export const SystemOneAnswerSchema = z.object({
  type: z.string().optional(), score: z.number().optional(),
  legend: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
  probabilities: z.union([z.array(z.number()), z.record(z.string(), z.number())]).optional(),
  confidence: z.number().optional(), noul: z.number().optional(), choice: z.string().optional(),
});
export const SystemOneResponseSchema = z.object({
  answers: z.record(z.string(), SystemOneAnswerSchema).optional(),
  model: z.string().optional(),
  usage: z.object({ input_tokens: z.number().optional(), prompt_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
}).refine(data => data.answers !== undefined, { message: "answers is required", path: ["answers"] });

/** Reads provider JSON or throws ProviderError with transport status and decode context. */
export async function readProviderJson(provider: string, response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new ProviderError(provider, `HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
  try { return JSON.parse(text); }
  catch (cause) { throw new ProviderError(provider, "invalid response JSON", response.status, { cause }); }
}

/** Calls the injected transport or throws ProviderError when no HTTP response is available. */
export async function fetchProvider(provider: string, fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try { return await fetchImpl(url, init); }
  catch (cause) { throw new ProviderError(provider, cause instanceof Error ? cause.message : String(cause), undefined, { cause }); }
}
