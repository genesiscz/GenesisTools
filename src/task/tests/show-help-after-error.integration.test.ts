import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

test("tools task <unknown> prints usage after error (B3)", () => {
    const result = spawnSync("bun", [TASK_TOOL, "task", "definitely-not-a-real-subcommand"], {
        encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("Usage:");
    expect(combined.toLowerCase()).toContain("definitely-not-a-real-subcommand");
});

test("tools question <unknown> prints usage after error (B3 — cross-tool)", () => {
    const result = spawnSync("bun", [TASK_TOOL, "question", "definitely-not-a-real-subcommand"], {
        encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("Usage:");
});
