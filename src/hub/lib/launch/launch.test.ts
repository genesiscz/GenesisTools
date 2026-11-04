import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionAgent } from "@app/cmux/lib/session-agents";
import { type AccountEntry, accountEntrySchema } from "@genesiscz/utils/ai/config/schema";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { launchOptions, startAgent } from "./index";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const CODEX = sessionAgent("codex").provider;

function account(name: string, provider: string, enabled = true): AccountEntry {
    return accountEntrySchema.parse({
        id: `acc_${name}`,
        name,
        provider,
        enabled,
        billing: { mode: "subscription" },
        credentials: {},
    });
}

function snapshot(name: string, fiveHour: number, weekly: number): AccountUsageSnapshot {
    const resetsAt = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
    return {
        provider: CODEX,
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: NOW.toISOString(),
        limits: [
            { key: "primary", label: "5h", kind: "session", percentUsed: fiveHour, resetsAt },
            { key: "secondary", label: "Weekly", kind: "weekly", percentUsed: weekly, resetsAt },
        ],
    };
}

describe("launchOptions", () => {
    it("ranks each harness's enabled accounts by headroom from the cache, an unread one last", async () => {
        const options = await launchOptions({
            accounts: async () => [
                account("work", CODEX),
                account("personal", CODEX),
                account("side", CODEX),
                account("off", CODEX, false),
            ],
            snapshots: async () => ({ [CODEX]: [snapshot("work", 90, 100), snapshot("personal", 10, 20)] }),
            repos: () => ["shop", "site"],
            now: NOW,
        });
        const codex = options.agents.find((agent) => agent.id === "codex");

        expect(codex?.accounts.map((entry) => [entry.name, entry.tier])).toEqual([
            ["personal", "ready"],
            ["work", "weekly-blocked"],
            ["side", "no-data"],
        ]);
        expect(codex?.accounts[0]).toMatchObject({ sessionLeftPct: 90, longLeftPct: 80 });
        expect(options.repos).toEqual(["shop", "site"]);
    });
});

describe("startAgent", () => {
    it("runs agents new with the picked account and reads the record it printed", async () => {
        const calls: string[][] = [];
        const receipt = await startAgent(
            { agent: "codex", repo: "shop", account: "personal", prompt: "Fix the build" },
            {
                run: async (args) => {
                    calls.push(args);
                    return {
                        stdout: '{"name":"codex-shop-ab12","workspace":"workspace:7","cwd":"/work/shop"}',
                        stderr: "",
                        exitCode: 0,
                    };
                },
            }
        );

        expect(calls).toEqual([
            [
                "cmux",
                "agents",
                "new",
                "codex",
                "--repo",
                "shop",
                "--account",
                "personal",
                "--json",
                "--prompt",
                "Fix the build",
            ],
        ]);
        expect(receipt).toEqual({
            started: true,
            name: "codex-shop-ab12",
            workspace: "workspace:7",
            cwd: "/work/shop",
            error: null,
        });
    });

    it("passes a long prompt as a file, and a refusal as the tool's last error line", async () => {
        const dir = mkdtempSync(join(tmpdir(), "launch-"));
        const prompt = "x".repeat(3_000);
        let args: string[] = [];
        const receipt = await startAgent(
            { agent: "claude", repo: "shop", account: "work", prompt },
            {
                promptDir: () => dir,
                run: async (argv) => {
                    args = argv;
                    return { stdout: "", stderr: 'starting\nNo project named "shop"', exitCode: 1 };
                },
            }
        );

        expect(readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8")).toBe(prompt);
        expect(receipt).toEqual({
            started: false,
            name: null,
            workspace: null,
            cwd: null,
            error: 'No project named "shop"',
        });
    });

    it("refuses an agent that is not a harness without running anything", async () => {
        const receipt = await startAgent(
            { agent: "bash", repo: "shop", account: "work" },
            {
                run: () => {
                    throw new Error("must not run");
                },
            }
        );

        expect(receipt.started).toBe(false);
    });
});
