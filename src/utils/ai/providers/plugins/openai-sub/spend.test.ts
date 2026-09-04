import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import type { AccountEntry } from "../../../config/schema";
import { codexSpendScope } from "./spend";

/** Fixture handles only — never a live account name. */
function account(credentials: Partial<AccountEntry["credentials"]>): AccountEntry {
    return { id: "acc_work", name: "work", provider: "openai-sub", credentials } as AccountEntry;
}

describe("codexSpendScope", () => {
    test("an account's home is the directory holding its auth file", () => {
        const scope = codexSpendScope(account({ authFile: "/fixture/.codex-work/auth.json" }));

        expect(scope).toEqual({
            source: "codex",
            transcriptRoots: [
                join("/fixture/.codex-work", "sessions"),
                join("/fixture/.codex-work", "archived_sessions"),
            ],
        });
    });

    test("an explicit dataDir stands in for the auth file", () => {
        expect(codexSpendScope(account({ dataDir: "/fixture/.codex-shop" }))?.transcriptRoots).toEqual([
            join("/fixture/.codex-shop", "sessions"),
            join("/fixture/.codex-shop", "archived_sessions"),
        ]);
    });

    test("an account with neither claims no tree at all", () => {
        expect(codexSpendScope(account({}))).toBeUndefined();
    });

    test("CODEX_HOME does not leak into an account's scope", async () => {
        await env.testing.withOverrides({ CODEX_HOME: "/elsewhere/.codex-other" }, () => {
            expect(codexSpendScope(account({ authFile: "/fixture/.codex-work/auth.json" }))?.transcriptRoots).toEqual([
                join("/fixture/.codex-work", "sessions"),
                join("/fixture/.codex-work", "archived_sessions"),
            ]);
        });
    });
});
