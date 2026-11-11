/**
 * Resolves pluggable generative providers by name.
 * Registration replaces a name deliberately; unknown names fail before any network request.
 */

import { type LlmProviderAdapter } from "./contracts.js";
const providers = new Map<string, LlmProviderAdapter>();
/** Registers or replaces an LLM adapter by name; does not call the provider. */
export function registerLlmProvider(p: LlmProviderAdapter) { providers.set(p.name, p); }
/** Returns a registered LLM adapter or throws for an unknown provider name. */
export function getLlmProvider(name: string): LlmProviderAdapter {
  const p = providers.get(name);
  if (!p) throw new Error(`unknown LLM provider "${name}" (registered: ${[...providers.keys()].join(", ")})`);
  return p;
}

