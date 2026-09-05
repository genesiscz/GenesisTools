import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import { claudeDriver } from "./claude";
import { codexDriver } from "./codex";
import { isolateAgentHomeEnv } from "./test-env";

registerBuiltInPlugins();
isolateAgentHomeEnv();

/** Fixture handles only — never a live account name. */
function anthropic(): AccountEntry {
    return { id: "acc_work", name: "work", provider: "anthropic-sub", credentials: {} } as AccountEntry;
}

function codex(id: string, name: string, home: string): AccountEntry {
    return { id, name, provider: "openai-sub", credentials: { authFile: join(home, "auth.json") } } as AccountEntry;
}

describe("rootsForAccounts", () => {
    test("codex tags each account's own home, and reports the home it came from", () => {
        const roots = codexDriver.rootsForAccounts?.([codex("acc_work", "work", "/fixture/.codex-work")], "/fixture");

        expect(roots).toEqual([
            { path: "/fixture/.codex-work/sessions", accountId: "acc_work", home: "/fixture/.codex-work" },
            { path: "/fixture/.codex-work/archived_sessions", accountId: "acc_work", home: "/fixture/.codex-work" },
        ]);
    });

    test("an account of another provider contributes nothing", () => {
        expect(codexDriver.rootsForAccounts?.([anthropic()], "/fixture")).toEqual([]);
    });

    test("the claude tree is emitted once, untagged — decision D6", () => {
        const roots = claudeDriver.rootsForAccounts?.([anthropic(), anthropic()], homedir()) ?? [];

        expect(roots.map((root) => root.path)).toEqual(nativeSessionRoots("claude"));
        expect(roots.every((root) => root.accountId === undefined)).toBe(true);
    });

    /**
     * Negative control for the `within` guard. The anthropic `spendScope` can
     * only answer for the process's real `$HOME`; without the intersection an
     * injected home would quietly walk the developer's own transcripts.
     */
    test("the shared claude tree never escapes the home the caller asked about", () => {
        expect(claudeDriver.rootsForAccounts?.([anthropic()], "/fixture/home")).toEqual([]);
    });
});
