import { describe, expect, it } from "vitest";
import { acquireReservationLock, resolveReservation } from "../src/engine/idempotent.js";

describe("reservation lock", () => {
  it("waits for publication and preserves the next owner's lock during cleanup", async () => {
    const locks = new Map<string, Promise<void>>();
    const first = await acquireReservationLock(locks, "tenant/key");
    let entered = false;
    const waiting = acquireReservationLock(locks, "tenant/key").then(lock => { entered = true; return lock; });
    await Promise.resolve();
    expect(entered).toBe(false);
    first.release();
    const second = await waiting;
    first.dispose();
    expect(locks.has("tenant/key")).toBe(true);
    second.dispose();
    expect(locks.size).toBe(0);
  });
});

it("replays the winner after losing an atomic reservation race without a store", async () => {
  let reads = 0, attempts = 0;
  const result = await resolveReservation(async () => ++reads === 2 ? ["winner"] : undefined, async () => { attempts++; return undefined; });
  expect(result).toEqual({ replayed: true, value: ["winner"] });
  expect(attempts).toBe(1);
});

it("returns a fresh reservation when no replay exists", async () => {
  expect(await resolveReservation(async () => undefined, async () => ({ id: "reserved" }))).toEqual({ replayed: false, value: { id: "reserved" } });
});
