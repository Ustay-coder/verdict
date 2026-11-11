/**
 * A rubric's `inputSchema`: a small, explicit subset of JSON Schema checked against `json` inputs before ingestion,
 * so a case missing a required field fails as invalid input without any provider call. Keywords outside the subset
 * are rejected when the rubric is parsed instead of being silently ignored, so a schema never promises a check it
 * does not run. Pure and synchronous: safe on Workers.
 */
import { z } from "zod";

export const JsonType = z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]);
export type JsonType = z.infer<typeof JsonType>;

export interface InputSchema {
  type?: JsonType | JsonType[];
  title?: string;
  description?: string;
  properties?: Record<string, InputSchema>;
  required?: string[];
  additionalProperties?: boolean | InputSchema;
  items?: InputSchema;
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

const count = z.number().int().min(0);
const compiles = (p: string) => { try { new RegExp(p); return true; } catch { return false; } };

export const InputSchema: z.ZodType<InputSchema> = z.lazy(() => z.strictObject({
  type: z.union([JsonType, z.array(JsonType).min(1)]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  properties: z.record(z.string(), InputSchema).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.union([z.boolean(), InputSchema]).optional(),
  items: InputSchema.optional(),
  enum: z.array(z.unknown()).min(1).optional(),
  const: z.unknown().optional(),
  minLength: count.optional(),
  maxLength: count.optional(),
  pattern: z.string().refine(compiles, "pattern must be a valid regular expression").optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minItems: count.optional(),
  maxItems: count.optional(),
}));

/** One reason a value does not match. `path` is JSONPath-like: `$`, `$.utterance`, `$.items[2]`. */
export interface InputIssue { path: string; message: string }

/** Every way `value` fails `schema`; empty when it matches. Stops descending at a type mismatch. */
export function checkInput(schema: InputSchema, value: unknown, path = "$"): InputIssue[] {
  const actual = jsonType(value);
  if (schema.type && !typeMatches(schema.type, value, actual)) {
    return [{ path, message: `expected ${[schema.type].flat().join(" or ")}, got ${actual}` }];
  }
  return [
    ...valueIssues(schema, value, path),
    ...(typeof value === "string" ? stringIssues(schema, value, path) : []),
    ...(typeof value === "number" ? numberIssues(schema, value, path) : []),
    ...(Array.isArray(value) ? arrayIssues(schema, value, path) : []),
    ...(actual === "object" ? objectIssues(schema, value as Record<string, unknown>, path) : []),
  ];
}

function jsonType(value: unknown): JsonType | "undefined" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "object") return typeof value as JsonType;
  return "undefined";
}

// An integer also satisfies "number"; nothing else widens.
function typeMatches(type: JsonType | JsonType[], value: unknown, actual: string): boolean {
  return [type].flat().some((t) => t === actual || (t === "number" && typeof value === "number" && Number.isFinite(value)));
}

function valueIssues(schema: InputSchema, value: unknown, path: string): InputIssue[] {
  const issues: InputIssue[] = [];
  if (schema.enum && !schema.enum.some((e) => sameJson(e, value))) issues.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  if ("const" in schema && !sameJson(schema.const, value)) issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  return issues;
}

function stringIssues(schema: InputSchema, value: string, path: string): InputIssue[] {
  const issues: InputIssue[] = [];
  // Length counts code points, as JSON Schema does, so Korean or emoji text is not over-counted.
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) issues.push({ path, message: `must have at least ${schema.minLength} characters` });
  if (schema.maxLength !== undefined && length > schema.maxLength) issues.push({ path, message: `must have at most ${schema.maxLength} characters` });
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) issues.push({ path, message: `must match ${schema.pattern}` });
  return issues;
}

function numberIssues(schema: InputSchema, value: number, path: string): InputIssue[] {
  const issues: InputIssue[] = [];
  if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be at least ${schema.minimum}` });
  if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be at most ${schema.maximum}` });
  return issues;
}

function arrayIssues(schema: InputSchema, value: unknown[], path: string): InputIssue[] {
  const issues: InputIssue[] = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `must have at least ${schema.minItems} items` });
  if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `must have at most ${schema.maxItems} items` });
  if (schema.items) value.forEach((item, i) => issues.push(...checkInput(schema.items!, item, `${path}[${i}]`)));
  return issues;
}

function objectIssues(schema: InputSchema, value: Record<string, unknown>, path: string): InputIssue[] {
  const issues: InputIssue[] = [];
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) issues.push({ path: childPath(path, key), message: "is required" });
  }
  for (const [key, item] of Object.entries(value)) {
    const declared = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (declared) { issues.push(...checkInput(declared, item, childPath(path, key))); continue; }
    if (schema.additionalProperties === false) issues.push({ path: childPath(path, key), message: "is not allowed" });
    else if (typeof schema.additionalProperties === "object") issues.push(...checkInput(schema.additionalProperties, item, childPath(path, key)));
  }
  return issues;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

// Key order does not matter in JSON objects, so compare a canonical form.
function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}
