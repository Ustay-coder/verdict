import { FileAccessError } from "../file-error.js";
import { extractFromBuffer, asUint8Array } from "./extract.js";
import { make } from "./evidence.js";
import type { Ingestor } from "./contracts.js";

export const fileIngestor: Ingestor = async (input, i, o) => {
  if (input.type !== "file") throw new Error("bad input");
  let buf: Uint8Array;
  let name = input.filename ?? "";
  if (input.base64) buf = asUint8Array(Buffer.from(input.base64, "base64"));
  else if (input.path) {
    if (!o.allowLocalFiles) throw new Error("local file paths are disabled; send base64 content instead");
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    try { buf = asUint8Array(await (o.readFile ?? readFile)(input.path)); }
    catch (cause) { throw new FileAccessError(input.path, "read", cause); }
    name ||= basename(input.path);
  } else throw new Error("file input needs `path` or `base64`");
  const { text, json, warnings } = await extractFromBuffer(buf, name, input.mimeType);
  return make(input, i, text, { label: input.label ?? name, source: name, json, warnings }, o.maxChars);
};
