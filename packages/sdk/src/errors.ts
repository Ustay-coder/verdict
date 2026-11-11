/**
 * Carries transport status, error type and optional API issues for failed client requests. `details` is the API's
 * whole error object: a refused promotion (`type: "pointer_conflict"`) lists where the pointers are in `details.current`.
 */
export class VerdictError extends Error {
  constructor(public status: number, public type: string, message: string, public issues?: unknown, public details?: Record<string, unknown>) { super(message); }
}
