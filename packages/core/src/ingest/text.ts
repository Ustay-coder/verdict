import { make } from "./evidence.js";
import type { Ingestor } from "./contracts.js";

export const textIngestor: Ingestor = async (input, i, o) => {
  if (input.type !== "text") throw new Error("bad input");
  return make(input, i, input.text, {}, o.maxChars);
};

export const jsonIngestor: Ingestor = async (input, i, o) => {
  if (input.type !== "json") throw new Error("bad input");
  return make(input, i, JSON.stringify(input.data, null, 2), { json: input.data }, o.maxChars);
};
