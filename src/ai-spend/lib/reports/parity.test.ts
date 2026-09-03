import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { isolateAgentHomeEnv } from "../drivers/test-env";

isolateAgentHomeEnv();

const AI_SPEND = join(import.meta.dir, "../../index.ts");

function claudeLine(over: {
    id: string;
    sessionId: string;
    timestamp: string;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    model?: string;
}): string {
    return SafeJSON.stringify({
        type: "assistant",
        timestamp: over.timestamp,
        cwd: "/p/fix",
        sessionId: over.sessionId,
        message: {
            id: over.id,
            model: over.model ?? "claude-3-5-haiku",
            usage: {
                input_tokens: over.input,
                output_tokens: over.output,
                cache_creation_input_tokens: over.cacheWrite,
                cache_read_input_tokens: over.cacheRead,
            },
        },
    });
}

function writeFixtureHome(): string {
    const home = mkdtempSync(join(tmpdir(), "ai-spend-parity-"));
    const claudeDir = join(home, ".claude", "projects", "proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
        join(claudeDir, "sess-parity.jsonl"),
        [
            claudeLine({
                id: "msg-1",
                sessionId: "sess-parity",
                timestamp: "2026-06-01T10:15:00.000Z",
                input: 100,
                output: 20,
                cacheWrite: 10,
                cacheRead: 40,
            }),
            claudeLine({
                id: "msg-2",
                sessionId: "sess-parity",
                timestamp: "2026-06-01T16:20:00.000Z",
                input: 50,
                output: 5,
                cacheWrite: 0,
                cacheRead: 15,
            }),
        ].join("\n")
    );
    return home;
}

async function spawnJson(command: string[], env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
    const proc = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exit !== 0) {
        throw new Error(`${command.join(" ")} exited ${exit}\n${stderr}\n${stdout}`);
    }

    const trimmed = stdout.trim();
    const start = trimmed.indexOf("{");
    return SafeJSON.parse(start >= 0 ? trimmed.slice(start) : trimmed, { strict: true }) as Record<string, unknown>;
}

function tokenFields(row: Record<string, unknown>): Record<string, number> {
    return {
        inputTokens: Number(row.inputTokens ?? 0),
        outputTokens: Number(row.outputTokens ?? 0),
        cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
        cacheReadTokens: Number(row.cacheReadTokens ?? 0),
        totalTokens: Number(row.totalTokens ?? 0),
    };
}

describe("ccusage JSON parity on a fixture HOME", () => {
    it("daily grouping keys and token fields match ccusage --json --offline", async () => {
        const home = writeFixtureHome();
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TZ: "UTC" };
        delete env.CLAUDE_CONFIG_DIR;
        const since = ["--since", "20260601", "--until", "20260601"];
        const ccusageBin = Bun.which("ccusage");

        if (!ccusageBin) {
            throw new Error("ccusage binary is required for the parity spawn");
        }

        const cc = await spawnJson(
            [ccusageBin, "claude", "daily", "--json", "--offline", "--timezone", "UTC", ...since],
            env
        );
        const ours = await spawnJson(
            [
                "bun",
                AI_SPEND,
                "claude",
                "daily",
                "--json",
                "--timezone",
                "UTC",
                "--since",
                "2026-06-01",
                "--until",
                "2026-06-01",
            ],
            env
        );
        const ccRows = (cc.daily as Array<Record<string, unknown>>) ?? [];
        const ourRows = (ours.daily as Array<Record<string, unknown>>) ?? [];
        expect(ourRows.map((row) => row.date ?? row.period)).toEqual(ccRows.map((row) => row.date ?? row.period));
        expect(tokenFields(ourRows[0])).toEqual(tokenFields(ccRows[0]));
        expect(tokenFields(ours.totals as Record<string, unknown>)).toEqual(
            tokenFields(cc.totals as Record<string, unknown>)
        );
    });

    it("session grouping keys and token fields match ccusage", async () => {
        const home = writeFixtureHome();
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TZ: "UTC" };
        delete env.CLAUDE_CONFIG_DIR;
        const ccusageBin = Bun.which("ccusage");

        if (!ccusageBin) {
            throw new Error("ccusage binary is required for the parity spawn");
        }

        // ccusage `claude session --since/--until` drops this fixture even
        // though `claude daily` with the same window keeps it. Compare the
        // unwindowed session report, which both tools emit for this one-day tree.
        const cc = await spawnJson([ccusageBin, "claude", "session", "--json", "--offline", "--timezone", "UTC"], env);
        const ours = await spawnJson(["bun", AI_SPEND, "claude", "session", "--json", "--timezone", "UTC"], env);
        const ccRows = (cc.sessions as Array<Record<string, unknown>>) ?? [];
        const ourRows = (ours.sessions as Array<Record<string, unknown>>) ?? [];
        expect(ourRows.map((row) => row.sessionId).sort()).toEqual(ccRows.map((row) => row.sessionId).sort());
        expect(tokenFields(ourRows[0])).toEqual(tokenFields(ccRows[0]));
    });

    it("blocks split the 5-hour window the same way as ccusage", async () => {
        const home = writeFixtureHome();
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TZ: "UTC" };
        delete env.CLAUDE_CONFIG_DIR;
        const ccusageBin = Bun.which("ccusage");

        if (!ccusageBin) {
            throw new Error("ccusage binary is required for the parity spawn");
        }

        const cc = await spawnJson(
            [
                ccusageBin,
                "blocks",
                "--json",
                "--offline",
                "--timezone",
                "UTC",
                "--since",
                "20260601",
                "--until",
                "20260601",
            ],
            env
        );
        const ours = await spawnJson(
            [
                "bun",
                AI_SPEND,
                "blocks",
                "--json",
                "--timezone",
                "UTC",
                "--since",
                "2026-06-01",
                "--until",
                "2026-06-01",
            ],
            env
        );
        const ccBlocks = ((cc.blocks as Array<Record<string, unknown>>) ?? []).filter((row) => !row.isGap);
        const ourBlocks = ((ours.blocks as Array<Record<string, unknown>>) ?? []).filter((row) => !row.isGap);
        expect(ourBlocks.map((row) => row.id)).toEqual(ccBlocks.map((row) => row.id));
        expect(ourBlocks.map((row) => row.totalTokens)).toEqual(ccBlocks.map((row) => row.totalTokens));
    });
});
