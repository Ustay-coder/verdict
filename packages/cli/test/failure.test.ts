import { expect, it, vi } from "vitest";
import { buildCli } from "../src/index.js";

it("reports invalid rubric files with a failing exit code", async () => {
  const previous = process.exitCode;
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await buildCli().parseAsync(["node", "verdict", "rubric", "validate", "/missing/verdict-rubric.yaml"]);
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("check the input and configuration"));
    expect(stderr.mock.calls[0]![0]).not.toContain("\n");
  } finally { process.exitCode = previous; stderr.mockRestore(); }
});
