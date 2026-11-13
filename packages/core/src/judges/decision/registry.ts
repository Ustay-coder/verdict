/**
 * Name-based registry of decision adapters, holding the built-in ones from the start.
 * The table is built from a value it imports, not filled by an import or a call that runs for its effect: packages are
 * marked `"sideEffects": false`, so a bundler (esbuild in `wrangler`) leaves such a statement out whenever the module
 * it sits in is otherwise unused, and the registry would be empty. Whatever uses the registry carries the built-ins.
 */
import type { DecisionProviderAdapter } from "./contracts.js";
import { builtInDecisionProviders } from "./providers.js";

const providers = new Map<string, DecisionProviderAdapter>(builtInDecisionProviders.map((p) => [p.name, p]));
/** Registers or replaces a decision adapter by name, a built-in one included; does not call the provider. */
export function registerDecisionProvider(p: DecisionProviderAdapter) { providers.set(p.name, p); }
/** Returns a registered decision adapter or throws for an unknown provider name. */
export function getDecisionProvider(name: string): DecisionProviderAdapter {
  const p = providers.get(name);
  if (!p) throw new Error(`unknown decision provider "${name}" (registered: ${[...providers.keys()].join(", ")})`);
  return p;
}
