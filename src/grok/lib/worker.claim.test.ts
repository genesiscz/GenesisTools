import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { sessionMetaPath, turnLogPath } from "./paths";
import { GrokSessionStore } from "./store";
import { claimTurnLog, promptArgs, runSession, steerSession } from "./worker";

/**
 * Regression tests: PR #330 review. `createMeta` is an O_EXCL claim on the
 * session name, so anything that can fail deterministically has to fail BEFORE
 * it. A throw afterwards leaves valid metadata for a session that never
 * started, and every later `run` of that name is rejected as already existing.
 */
describe("runSession claims a name only once it can start", () => {
    test("a missing prompt fails without claiming the name", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-claim-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await expect(runSession({ name: "reviewer", cwd: "/repo", readOnly: true })).rejects.toThrow(
                "A prompt is required"
            );

            expect(existsSync(sessionMetaPath("reviewer"))).toBe(false);
            expect(new GrokSessionStore().readMeta("reviewer")).toBeNull();
        });
    });

    test("a --cwd that does not exist fails without claiming the name", async () => {
        // `--cwd` is mandatory on grok (the cwd IS the sandbox), so every invocation now types
        // the path. An unchecked typo reached `Bun.spawn`, which throws ENOENT AFTER `createMeta`
        // has reserved the name: the session never starts and the name is burned for good.
        const home = mkdtempSync(join(tmpdir(), "gt-grok-claim-cwd-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await expect(
                runSession({
                    name: "typo",
                    cwd: join(tmpdir(), "gt-grok-definitely-not-here-xyz"),
                    prompt: "do the thing",
                    readOnly: false,
                })
            ).rejects.toThrow(/does not exist/);

            expect(existsSync(sessionMetaPath("typo"))).toBe(false);
            expect(new GrokSessionStore().readMeta("typo")).toBeNull();
        });
    });

    test("a --cwd that is a FILE is refused too, because grok chdirs into it", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-claim-file-"));
        const file = join(home, "brief.md");
        writeFileSync(file, "not a directory");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await expect(
                runSession({ name: "afile", cwd: file, prompt: "do the thing", readOnly: false })
            ).rejects.toThrow(/not a directory/);

            expect(new GrokSessionStore().readMeta("afile")).toBeNull();
        });
    });
});

describe("listNames does not create the sessions directory", () => {
    test("listing on a fresh home reads empty and writes nothing", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-list-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new GrokSessionStore();

            expect(store.listNames()).toEqual([]);
            // `sessions` is a diagnostic. Inspecting grok must not leave a directory behind.
            expect(existsSync(join(home, ".genesis-tools", "grok", "sessions"))).toBe(false);
        });
    });
});

describe("turn reservations", () => {
    test("a dead launcher leaves a high-water mark so the next turn advances", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-turn-reservation-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const store = new GrokSessionStore();
            store.createMeta({
                name: "reviewer",
                sessionId: "3f1d2a9c-0000-4000-8000-000000000000",
                cwd: home,
                workerHome: join(home, "worker"),
                readOnly: true,
                turns: 0,
                createdAt: new Date(0).toISOString(),
            });

            closeSync(claimTurnLog({ store, name: "reviewer", turn: 1 }));
            const next = (store.readMeta("reviewer")?.turns ?? 0) + 1;
            closeSync(claimTurnLog({ store, name: "reviewer", turn: next }));

            expect(next).toBe(2);
            expect(store.readMeta("reviewer")?.turns).toBe(2);
            expect(existsSync(turnLogPath("reviewer", 1))).toBe(true);
            expect(existsSync(turnLogPath("reviewer", 2))).toBe(true);
        });
    });

    test("a live orphan child blocks a competing turn after its launcher dies", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-turn-owner-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new GrokSessionStore();
            store.createMeta({
                name: "reviewer",
                sessionId: "3f1d2a9c-0000-4000-8000-000000000000",
                cwd: home,
                workerHome: join(home, "worker"),
                readOnly: true,
                turns: 1,
                createdAt: new Date(0).toISOString(),
                activeTurn: {
                    turn: 1,
                    ownerPid: -1,
                    childPid: process.pid,
                    startedAt: new Date().toISOString(),
                },
            });

            await expect(steerSession({ name: "reviewer", prompt: "next" })).rejects.toThrow(
                /still has turn 1 running/
            );
        });
    });
});

describe("promptArgs", () => {
    test("makes a relative --prompt-file absolute against the caller's cwd", () => {
        // grok chdirs to --cwd before reading the file, so a bare relative path
        // would resolve against the session directory rather than the shell the
        // command was typed in. Resolving here is what keeps `./brief.md`
        // meaning what the user meant.
        const args = promptArgs({ promptFile: "./brief.md" });

        expect(args).toEqual(["--prompt-file", join(process.cwd(), "brief.md")]);
    });

    test("an absolute --prompt-file is passed through unchanged", () => {
        expect(promptArgs({ promptFile: "/repo/brief.md" })).toEqual(["--prompt-file", "/repo/brief.md"]);
    });

    test("an inline prompt uses -p, which is what redactArgs must match", () => {
        expect(promptArgs({ prompt: "review this" })).toEqual(["-p", "review this"]);
    });
});
