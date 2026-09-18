import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "index.ts");

function help(args: string[]) {
    return spawnSync("bun", [entry, ...args, "--help"], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
    });
}

test("live policy commands advertise their flags", () => {
    const listen = help(["listen"]);
    expect(listen.status).toBe(0);
    expect(listen.stdout).toContain("--stt");
    expect(listen.stdout).toContain("--transcript");
    expect(listen.stdout).toContain("--dry-run");

    const route = help(["route"]);
    expect(route.status).toBe(0);
    expect(route.stdout).toContain("--run");

    const compact = help(["compact"]);
    expect(compact.status).toBe(0);
    expect(compact.stdout).toContain("--llm");
    expect(compact.stdout).toContain("--keep");

    const screen = help(["screen"]);
    expect(screen.status).toBe(0);
    expect(screen.stdout).toContain("--purpose");

    const watch = help(["watch"]);
    expect(watch.status).toBe(0);
    expect(watch.stdout).toContain("--hz");

    const loop = help(["loop"]);
    expect(loop.status).toBe(0);
    expect(loop.stdout).toContain("--browser");

    const wake = help(["wake"]);
    expect(wake.status).toBe(0);
    expect(wake.stdout).toContain("status");

    const demo = help(["control", "demo"]);
    expect(demo.status).toBe(0);
    expect(demo.stdout).toContain("--i-mean-it");
});

test("non-TTY listen without --transcript exits 1", () => {
    const result = spawnSync("bun", [entry, "listen", "--stt", "fixture"], {
        env: { ...process.env, TERM: "dumb" },
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--transcript");
});
