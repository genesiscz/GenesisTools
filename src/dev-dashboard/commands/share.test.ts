import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@genesiscz/utils/env";
import { listPublications, updateShareConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { out } from "@genesiscz/utils/logger";
import { makeTestBackend } from "@genesiscz/utils/prompts/p/__tests__/test-backend";
import { getBackend, setBackend } from "@genesiscz/utils/prompts/p/backend";
import type { PublishTarget } from "@genesiscz/utils/publish/targets";
import { resolveShareTargetFlags, runShareSync } from "./share";

let dir: string;
let previousHome: string | undefined;
let priorExit: typeof process.exitCode;
const targets: PublishTarget[] = ["desk", "backup"].map((name) => ({
    name,
    publicBase: "https://live.example.com",
    transport: { kind: "mac-live", mounts: { md: "/share" } },
}));

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "share-sync-"));
    previousHome = env.get("GENESIS_TOOLS_HOME");
    priorExit = process.exitCode;
    process.exitCode = 0;
    env.testing.set("GENESIS_TOOLS_HOME", dir);
    resetDevDashboardStorage();
    const vault = join(dir, "vault");
    mkdirSync(vault);
    const publishedNotes = ["Alpha", "Beta"].map((title) => {
        const vaultPath = `${title}.md`;
        writeFileSync(join(vault, vaultPath), `# ${title}\n`);
        return { slug: title, vaultPath, publishedAt: "2026-01-01T00:00:00.000Z" };
    });
    await getDevDashboardStorage().setConfig({ obsidianVault: vault, publishedNotes });
    await updateShareConfig((config) => ({ ...config, targets }));
});

afterEach(() => {
    if (previousHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", previousHome);
    }

    resetDevDashboardStorage();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = priorExit;
});

test("share sync --all sends a never-sent note to the configured default", async () => {
    await updateShareConfig((config) => ({ ...config, defaults: { target: "desk" } }));
    await runShareSync([], { all: true, targets: [], prune: false });
    expect((await listPublications("md")).map(({ syncs }) => Object.keys(syncs))).toEqual([["desk"], ["desk"]]);
    expect(process.exitCode).toBe(0);
});

test("non-interactive sync without a default suggests one command with both targets", async () => {
    const print = spyOn(out, "printlnErr");
    try {
        await runShareSync([], { all: true, targets: [], prune: false });
        const suggestions = print.mock.calls.flat().filter((value) => String(value).includes("--target"));
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0]).toContain("desk");
        expect(suggestions[0]).toContain("backup");
        expect(suggestions[0]).toContain("share sync --all --target desk");
        expect(process.exitCode).toBe(1);
        expect(await listPublications("md")).toEqual([]);
    } finally {
        print.mockRestore();
    }
});

test("a bare target flag uses the TTY picker", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const backend = getBackend();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    setBackend(makeTestBackend({ select: "backup" }));
    try {
        expect(await resolveShareTargetFlags([true], ["share", "sync", "--all"])).toEqual(["backup"]);
    } finally {
        setBackend(backend);
        if (descriptor) {
            Object.defineProperty(process.stdin, "isTTY", descriptor);
        } else {
            Reflect.deleteProperty(process.stdin, "isTTY");
        }
    }
});
