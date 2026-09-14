import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "../../../config/AiConfigStore";
import type { AccountEntry } from "../../../config/schema";
import { discoverGrokHomes, grokAccountNameForHome, grokAccountNameLookup } from "./discover";

function jwt(payload: Record<string, unknown>): string {
    return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(SafeJSON.stringify(payload)).toString("base64url")}.signature`;
}

function writeGrokHome(root: string, name: string, sub: string): string {
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(
        join(home, "auth.json"),
        SafeJSON.stringify({
            default: {
                key: jwt({ sub, tier: 2, exp: Math.floor(Date.now() / 1000) + 3600 }),
                refresh_token: "rt",
                oidc_issuer: "https://issuer.invalid",
                oidc_client_id: "grok-cli",
            },
        })
    );
    return home;
}

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_grok",
        name: "personal",
        provider: "grok-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

let root: string;
let workerRoot: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gt-grok-homes-"));
    workerRoot = mkdtempSync(join(tmpdir(), "gt-grok-workers-"));
});

afterEach(() => {
    root = "";
    workerRoot = "";
});

describe("grokAccountNameLookup", () => {
    test("one config read answers every home in a listing", async () => {
        // `grokAccountNameForHome` read and zod-parsed ~/.genesis-tools/ai/config.json on EVERY
        // call, because `AiConfigStore.readOnly()` has no cache where `load()` returned the
        // singleton. `tools ai usage sessions` calls it once per row: 2627 grok rows here, all
        // resolving the same handful of homes.
        const accounts = [
            account({ id: "acc_a", name: "work", credentials: { authFile: join(root, ".grok/auth.json") } }),
            account({ id: "acc_b", name: "personal", credentials: { authFile: join(root, ".grok-side/auth.json") } }),
        ];
        const reads = spyOn(AiConfigStore, "readOnly").mockResolvedValue({
            accounts: () => accounts,
        } as unknown as AiConfigStore);

        try {
            const lookup = await grokAccountNameLookup();

            expect(lookup(join(root, ".grok"))).toBe("work");
            expect(lookup(join(root, ".grok-side"))).toBe("personal");
            expect(lookup(join(root, ".grok-unknown"))).toBeUndefined();
            expect(reads).toHaveBeenCalledTimes(1);
        } finally {
            reads.mockRestore();
        }
    });

    test("NEGATIVE CONTROL: the single-home convenience still answers on its own", async () => {
        const accounts = [
            account({ id: "acc_a", name: "work", credentials: { authFile: join(root, ".grok/auth.json") } }),
        ];
        const reads = spyOn(AiConfigStore, "readOnly").mockResolvedValue({
            accounts: () => accounts,
        } as unknown as AiConfigStore);

        try {
            expect(await grokAccountNameForHome(join(root, ".grok"))).toBe("work");
        } finally {
            reads.mockRestore();
        }
    });
});

describe("discoverGrokHomes", () => {
    test("an inspection never runs a config migration, even with no accounts injected", async () => {
        // `discoverGrokHomes` is reached from `account show`, `account discover` and the spend
        // reports — all inspections. `AiConfigStore.load()` may run `ensureAiConfigMigrated()`,
        // which writes. The sibling four lines above was fixed and this one was left behind.
        writeGrokHome(root, ".grok", "user-default");
        const readOnly = spyOn(AiConfigStore, "readOnly").mockResolvedValue({
            accounts: () => [],
        } as unknown as AiConfigStore);
        const load = spyOn(AiConfigStore, "load");

        try {
            await discoverGrokHomes({ root, workerRoot });

            expect(readOnly).toHaveBeenCalled();
            expect(load).not.toHaveBeenCalled();
        } finally {
            readOnly.mockRestore();
            load.mockRestore();
        }
    });

    test("lists the default home and every ~/.grok-* sibling, with the subject decoded", async () => {
        writeGrokHome(root, ".grok", "user-default");
        writeGrokHome(root, ".grok-work", "user-work");

        const found = await discoverGrokHomes({ root, workerRoot, accounts: [] });

        expect(found.map((home) => home.home)).toEqual([join(root, ".grok"), join(root, ".grok-work")]);
        expect(found[0].identity?.accountUuid).toBe("user-default");
        expect(found[0].identity?.plan).toBe("tier 2");
        expect(found[1].identity?.accountUuid).toBe("user-work");
    });

    // The harness makes one worker home per parallel handoff, and they hold real
    // transcripts. They carry no auth.json: `GROK_AUTH_PATH` points them at the
    // default login, so that login's account owns them.
    test("every worker-home* is listed and bound to the default login's account", async () => {
        writeGrokHome(root, ".grok", "user-default");
        mkdirSync(join(workerRoot, "worker-home"), { recursive: true });
        mkdirSync(join(workerRoot, "worker-home-2"), { recursive: true });
        mkdirSync(join(workerRoot, "sessions"), { recursive: true });

        const found = await discoverGrokHomes({
            root,
            workerRoot,
            accounts: [account({ credentials: { authFile: join(root, ".grok", "auth.json") } })],
        });

        const workers = found.filter((home) => home.home.startsWith(workerRoot));

        expect(workers.map((home) => home.home)).toEqual([
            join(workerRoot, "worker-home"),
            join(workerRoot, "worker-home-2"),
        ]);
        expect(workers.every((home) => home.boundToAccountId === "acc_grok")).toBe(true);
        expect(workers.every((home) => home.authFile === undefined)).toBe(true);
        // `sessions/` is not a home.
        expect(found.some((home) => home.home.endsWith("/sessions"))).toBe(false);
    });

    test("a home without auth.json is skipped, and no accounts means no binding", async () => {
        mkdirSync(join(root, ".grok-empty"), { recursive: true });
        writeGrokHome(root, ".grok", "user-default");

        const found = await discoverGrokHomes({ root, workerRoot, accounts: [] });

        expect(found).toHaveLength(1);
        expect(found[0].boundToAccountId).toBeUndefined();
    });
});
