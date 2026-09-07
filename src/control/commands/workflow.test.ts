import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "index.ts");

test("snapshot inspection exposes its window selection without touching a live app", () => {
    const result = spawnSync("bun", [entry, "see", "--help"], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--window-index");
    expect(result.stdout).toContain("--path");
});

test("action help exposes native drag selection and paste options", () => {
    const result = spawnSync("bun", [entry, "act", "--help"], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--to");
    expect(result.stdout).toContain("--range");
    expect(result.stdout).toContain("--format");
    expect(result.stdout).toContain("--to");
    expect(result.stdout).toContain("--range");
    expect(result.stdout).toContain("--format");
});

test("an invalid drag button is rejected before native resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "drag",
            "--button",
            "middleish",
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--button");
    expect(result.stderr).not.toContain("app not found");
});

test("an unknown action is rejected before app resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "launch-missiles",
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--action");
    expect(result.stderr).not.toContain("app not found");
});
