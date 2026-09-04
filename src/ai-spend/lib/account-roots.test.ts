import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { accountIdForFile, resolveDriverRoots } from "./account-roots";
import type { DriverRoot, MonitorDriver } from "./drivers";
import { isolateAgentHomeEnv } from "./drivers/test-env";

isolateAgentHomeEnv();

function fakeDriver(options: {
    id: MonitorDriver["id"];
    roots: string[];
    rootsForAccounts?: (accounts: AccountEntry[]) => DriverRoot[];
}): MonitorDriver {
    return {
        id: options.id,
        roots: () => options.roots,
        rootsForAccounts: options.rootsForAccounts,
        isTranscript: (name) => name.endsWith(".jsonl"),
        maxDepth: 4,
        createParser: () => ({ parseLine: () => undefined, snapshot: () => undefined }),
        priceCandidates: (model) => [model],
    };
}

/** Only the fields `resolveDriverRoots` reads; the store's entries are far wider. */
function account(id: string): AccountEntry {
    return { id, name: id, provider: "openai-sub", credentials: {} } as AccountEntry;
}

describe("resolveDriverRoots", () => {
    test("without accounts every default root is unbound", () => {
        const roots = resolveDriverRoots({
            driver: fakeDriver({ id: "codex", roots: ["/u/.codex/sessions"] }),
            userHome: "/u",
        });

        expect(roots).toEqual([{ path: "/u/.codex/sessions" }]);
    });

    test("a bound root wins over the unbound copy of the same path", () => {
        const roots = resolveDriverRoots({
            driver: fakeDriver({
                id: "codex",
                roots: ["/u/.codex/sessions", "/u/.codex/archived_sessions"],
                rootsForAccounts: () => [{ path: "/u/.codex/sessions", accountId: "acc_work", home: "/u/.codex" }],
            }),
            userHome: "/u",
            accounts: [account("acc_work")],
        });

        expect(roots).toEqual([
            { path: "/u/.codex/sessions", accountId: "acc_work", home: "/u/.codex" },
            { path: "/u/.codex/archived_sessions" },
        ]);
    });

    test("a driver with no rootsForAccounts keeps its defaults even when accounts exist", () => {
        const roots = resolveDriverRoots({
            driver: fakeDriver({ id: "claude", roots: ["/u/.claude/projects"] }),
            userHome: "/u",
            accounts: [account("acc_work")],
        });

        expect(roots).toEqual([{ path: "/u/.claude/projects" }]);
    });

    test("discovered homes add unbound roots; ones already bound are not added twice", () => {
        const homes: DiscoveredHome[] = [
            { home: "/u/.codex-shop" },
            { home: "/u/.codex-work", boundToAccountId: "acc_work" },
        ];
        const roots = resolveDriverRoots({
            driver: fakeDriver({
                id: "codex",
                roots: ["/u/.codex/sessions"],
                rootsForAccounts: () => [{ path: "/u/.codex-work/sessions", accountId: "acc_work" }],
            }),
            userHome: "/u",
            accounts: [account("acc_work")],
            discoveredHomes: homes,
        });

        expect(roots.map((root) => root.path)).toEqual([
            "/u/.codex/sessions",
            "/u/.codex-work/sessions",
            "/u/.codex-shop/sessions",
            "/u/.codex-shop/archived_sessions",
        ]);
        expect(roots.filter((root) => root.accountId === "acc_work").map((root) => root.path)).toEqual([
            "/u/.codex-work/sessions",
        ]);
    });
});

describe("accountIdForFile", () => {
    const roots: DriverRoot[] = [
        { path: "/u/.codex" },
        { path: "/u/.codex/sessions", accountId: "acc_work" },
        { path: "/u/.codex-shop/sessions", accountId: "acc_shop" },
    ];

    test("the longest matching root decides, so a nested bound root beats its parent", () => {
        expect(accountIdForFile("/u/.codex/sessions/2026/a.jsonl", roots)).toBe("acc_work");
        expect(accountIdForFile("/u/.codex-shop/sessions/b.jsonl", roots)).toBe("acc_shop");
    });

    test("a file under an unbound root, or under none, has no account", () => {
        expect(accountIdForFile("/u/.codex/archived_sessions/c.jsonl", roots)).toBeUndefined();
        expect(accountIdForFile("/elsewhere/d.jsonl", roots)).toBeUndefined();
    });

    test("a sibling directory that merely shares a prefix never matches", () => {
        expect(accountIdForFile("/u/.codex/sessions-old/e.jsonl", roots)).toBeUndefined();
    });
});
