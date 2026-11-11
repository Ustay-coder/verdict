import { expect, it } from "vitest";
import { StoreError, storeOperation } from "../src/errors.js";

it("retains the operation and driver cause without wrapping a StoreError twice", async () => {
  const cause = new Error("connection lost");
  const failure = await storeOperation("getEvaluation:eval_1", () => { throw cause; }).catch(error => error);
  expect(failure).toBeInstanceOf(StoreError);
  expect(failure.operation).toBe("getEvaluation:eval_1");
  expect(failure.cause).toBe(cause);
  await expect(storeOperation("outer", () => { throw failure; })).rejects.toBe(failure);
});
