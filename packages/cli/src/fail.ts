/**
 * Presents command failures at the process boundary without terminating embedded callers.
 * A failed command must leave a nonzero exit code; stderr stays on one line for shell logs.
 */
/** Prints an actionable failure and sets exitCode to 1; never throws. */
export function fail(message: string): void {
  console.error(`error: ${message.replace(/\s+/g, " ")} — check the input and configuration`);
  process.exitCode = 1;
}
