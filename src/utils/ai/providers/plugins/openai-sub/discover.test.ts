import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { AccountEntry } from "../../../config/schema";
import { discoverCodexHomes } from "./discover";

/**
 * Discovery is a DIAGNOSTIC: every claim below comes out of the JWT already on
 * disk. Nothing here touches the network, and the fixtures use invented
 * addresses.
 */
function jwt(payload: Record<string, unknown>): string {
    return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(SafeJSON.stringify(payload)).toString("base64url")}.signature`;
}

function writeCodexHome(root: string, name: string, payload: Record<string, unknown>): string {
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(
        join(home, "auth.json"),
        SafeJSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
                id_token: jwt(payload),
                access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                refresh_token: "rt",
            },
        })
    );
    return home;
}

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_codex",
        name: "work",
        provider: "openai-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gt-codex-homes-"));
});

afterEach(() => {
    root = "";
});

describe("discoverCodexHomes", () => {
    test("lists ~/.codex and every ~/.codex-* sibling, with the email decoded", async () => {
        writeCodexHome(root, ".codex", {
            email: "alice@example.com",
            "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
        });
        writeCodexHome(root, ".codex-shop", { email: "shop@example.com" });
        mkdirSync(join(root, ".config"), { recursive: true });

        const found = await discoverCodexHomes({ root, accounts: [] });

        expect(found.map((home) => home.home)).toEqual([join(root, ".codex"), join(root, ".codex-shop")]);
        expect(found[0].identity?.email).toBe("alice@example.com");
        expect(found[0].identity?.plan).toBe("plus");
        expect(found[1].identity?.email).toBe("shop@example.com");
        expect(found[0].authFile).toBe(join(root, ".codex", "auth.json"));
    });

    test("marks a home an account already points into", async () => {
        writeCodexHome(root, ".codex", { email: "alice@example.com" });
        writeCodexHome(root, ".codex-side", { email: "side@example.com" });

        const found = await discoverCodexHomes({
            root,
            accounts: [account({ credentials: { authFile: join(root, ".codex-side", "auth.json") } })],
        });

        expect(found.find((home) => home.home.endsWith(".codex"))?.boundToAccountId).toBeUndefined();
        expect(found.find((home) => home.home.endsWith(".codex-side"))?.boundToAccountId).toBe("acc_codex");
    });

    test("a home without auth.json is still listed, without an identity", async () => {
        mkdirSync(join(root, ".codex-empty"), { recursive: true });

        const found = await discoverCodexHomes({ root, accounts: [] });

        expect(found).toHaveLength(1);
        expect(found[0].authFile).toBeUndefined();
        expect(found[0].identity).toBeUndefined();
    });

    test("a root with no codex homes yields nothing rather than throwing", async () => {
        expect(await discoverCodexHomes({ root: join(root, "nope"), accounts: [] })).toEqual([]);
    });
});
