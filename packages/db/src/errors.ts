/** A persistence failure retains the operation and original driver cause for recovery. */
export class StoreError extends Error {
  constructor(public readonly operation: string, cause: unknown) {
    super(`Store ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StoreError";
  }
}

/** Keep driver details as a cause while exposing a stable persistence error contract. */
export async function storeOperation<T>(operation: string, run: () => PromiseLike<T> | T): Promise<T> {
  try { return await run(); }
  catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw new StoreError(operation, cause);
  }
}
