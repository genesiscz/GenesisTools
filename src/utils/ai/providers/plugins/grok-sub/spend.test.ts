import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "../../../config/schema";
import { grokSpendScope } from "./spend";

/** Fixture handles only — never a live account name. */
function account(id: string, name: string, authFile: string): AccountEntry {
    return { id, name, provider: "grok-sub", credentials: { authFile } } as AccountEntry;
}

describe("grokSpendScope", () => {
    let root: string;
    let workerRoot: string;
    let defaultAuthFile: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "grok-spend-"));
        workerRoot = join(root, ".genesis-tools", "grok");
        defaultAuthFile = join(root, ".grok", "auth.json");

        mkdirSync(join(root, ".grok"), { recursive: true });
        writeFileSync(defaultAuthFile, "{}");

        // Two worker homes plus one directory that is not one.
        mkdirSync(join(workerRoot, "worker-home", "sessions"), { recursive: true });
        mkdirSync(join(workerRoot, "worker-home-2", "sessions"), { recursive: true });
        mkdirSync(join(workerRoot, "sessions"), { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test("the default login owns every worker home, not just the first one", () => {
        const scope = grokSpendScope(account("acc_work", "work", defaultAuthFile), { workerRoot, defaultAuthFile });

        expect(scope).toEqual({
            source: "grok",
            transcriptRoots: [
                join(root, ".grok", "sessions"),
                join(workerRoot, "worker-home", "sessions"),
                join(workerRoot, "worker-home-2", "sessions"),
            ],
        });
    });

    test("a second login gets its own home only — the workers borrow the default credential", () => {
        const other = join(root, ".grok-side", "auth.json");
        const scope = grokSpendScope(account("acc_side", "side", other), { workerRoot, defaultAuthFile });

        expect(scope?.transcriptRoots).toEqual([join(root, ".grok-side", "sessions")]);
    });

    test("an account with no credential file claims no tree", () => {
        const bare = { id: "acc_bare", name: "side", provider: "grok-sub", credentials: {} } as AccountEntry;

        expect(grokSpendScope(bare, { workerRoot, defaultAuthFile })).toBeUndefined();
    });
});
