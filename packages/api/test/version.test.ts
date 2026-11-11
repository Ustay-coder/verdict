import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Engine, MemoryStore } from "@verdict-ai/core";
import { createApp } from "../src/app.js";
import { VERSION } from "../src/version.js";

const published = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

it("says the version it was published as at the root and in the OpenAPI document", async () => {
  // Workers have no package.json to read, so the number is a constant the release script writes; this holds it.
  expect(VERSION).toBe(published);
  const app = createApp({ engine: new Engine({ store: new MemoryStore() }), auth: { resolve: () => "t1" } });
  expect(await (await app.request("/")).json()).toMatchObject({ name: "verdict", version: published });
  const openapi = await (await app.request("/v1/openapi.json", { headers: { authorization: "Bearer k" } })).json() as { info: { version: string } };
  expect(openapi.info.version).toBe(published);
});
