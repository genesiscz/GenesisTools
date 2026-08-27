import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { sessionMetaPath } from "./paths";
import { type GrokSessionMeta, GrokSessionStore } from "./store";

function makeMeta(): GrokSessionMeta {
    return {
        name: "reviewer",
        sessionId: "3f1d2a9c-0000-4000-8000-000000000000",
        cwd: "/repo",
        workerHome: "/home/worker",
        readOnly: true,
        turns: 0,
        createdAt: new Date(0).toISOString(),
    };
}

describe("GrokSessionStore", () => {
    test("round-trips metadata, updates, and lists sessions", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-store-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new GrokSessionStore();
            const meta = makeMeta();
            store.writeMeta(meta);

            expect(store.readMeta("reviewer")).toEqual(meta);
            expect(store.listNames()).toEqual(["reviewer"]);

            const updated = store.updateMeta("reviewer", {
                turns: 2,
                lastTurn: { turn: 2, ended: true, exitCode: 0, at: new Date(0).toISOString() },
            });
            expect(updated.turns).toBe(2);
            expect(store.readMeta("reviewer")?.lastTurn?.ended).toBe(true);
        });
    });

    test("missing session reads null and update throws", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-store-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new GrokSessionStore();
            expect(store.readMeta("ghost")).toBeNull();
            expect(() => store.updateMeta("ghost", { turns: 1 })).toThrow("Grok session not found");
        });
    });

    test("createMeta claims a name exactly once", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-store-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new GrokSessionStore();
            store.createMeta(makeMeta());

            expect(store.readMeta("reviewer")).toEqual(makeMeta());
            // The second claim must lose rather than overwrite the first record.
            expect(() => store.createMeta({ ...makeMeta(), sessionId: "other" })).toThrow("already exists");
            expect(store.readMeta("reviewer")?.sessionId).toBe(makeMeta().sessionId);
        });
    });

    test("metadata without a sessionId reads as unusable, not as a blank row", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-store-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new GrokSessionStore();
            store.ensureSessionsDir();
            // A record from an older build: the unchecked cast let this reach the
            // sessions table and render an empty id cell, and it cannot be resumed.
            writeFileSync(sessionMetaPath("legacy"), SafeJSON.stringify({ name: "legacy", turns: 1 }));

            expect(store.readMeta("legacy")).toBeNull();
        });
    });

    test("rejects path-escaping session names", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-store-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new GrokSessionStore();
            expect(() => store.writeMeta({ ...makeMeta(), name: "../escape" })).toThrow("Invalid session name");
        });
    });
});
