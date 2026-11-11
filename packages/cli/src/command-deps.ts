import { localEngine, remote } from "./remote.js";
import { fail } from "./fail.js";

/** Process access stays at the adapter boundary so handlers can run in memory. */
export const commandDefaults = {
  engine: localEngine,
  remote,
  out: (line: string) => console.log(line),
  fail,
};
export type CommandDependencies = typeof commandDefaults;
