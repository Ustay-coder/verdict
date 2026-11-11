/**
 * Classifies filesystem failures without importing Node at module load time.
 * Missing paths and permission failures need different remedies across CLI and persistence adapters.
 */
export type FileFailure = "missing" | "permission" | "io";

/** Reports a file operation failure with its path and OS code; corrupt JSON remains SyntaxError. */
export class FileAccessError extends Error {
  readonly code?: string;
  readonly kind: FileFailure;
  constructor(public path: string, public operation: string, cause: unknown) {
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    const kind = code === "ENOENT" ? "missing" : code === "EACCES" || code === "EPERM" ? "permission" : "io";
    const remedy = kind === "missing" ? "path does not exist" : kind === "permission" ? "permission denied; check access rights" : "check the path and filesystem";
    super(`Cannot ${operation} ${path}: ${remedy}`, { cause });
    this.name = "FileAccessError";
    this.code = code;
    this.kind = kind;
  }
}
