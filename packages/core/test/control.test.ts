import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, hasControl, MemoryStore } from "../src/index.js";
import { controlStoreContract } from "./control-contract.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "verdict-control-"));
  directories.push(dir);
  return dir;
}

describe("control store in memory", () => {
  controlStoreContract(async () => new MemoryStore().control);
});

describe("control store on files", () => {
  controlStoreContract(async () => new FileStore(await temporary()).control);

  it("survives a restart and releases its lock after a refused change", async () => {
    const dir = await temporary();
    const first = new FileStore(dir).control;
    await first.createProject({ name: "support-bot", createdAt: "2026-11-10T00:00:00.000Z" });
    expect(await first.createProject({ name: "support-bot", createdAt: "2026-11-10T00:00:01.000Z" })).toBe(false);
    expect(await readdir(dir)).not.toContain("control.lock");
    expect((await new FileStore(dir).control.listProjects(undefined)).map((p) => p.name)).toEqual(["support-bot"]);
  });
});

it("recognises stores that keep the control plane", () => {
  expect(hasControl(new MemoryStore())).toBe(true);
  expect(hasControl({})).toBe(false);
});
