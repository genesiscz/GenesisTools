import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { agentHomeEnvPatch } from "../drivers/test-env";
import type { CodexAnalysis } from "./reviews";

test("ai-usage alias reports a review pass and daily pricing coverage from real fixture files", async () => {
    const home = mkdtempSync(join(tmpdir(), "ai-usage-cli-"));
    const sessions = join(home, ".codex", "sessions", "2026", "09", "07");
    mkdirSync(sessions, { recursive: true });
    const timestamp = "2026-09-07T10:00:00Z";
    const lines = [
        { type: "session_meta", payload: { id: "synthetic", source: "cli" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "pass" } },
        { type: "turn_context", payload: { turn_id: "pass", model: "gpt-6-astra" } },
        { type: "event_msg", payload: { type: "entered_review_mode" } },
        {
            type: "event_msg",
            payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 272001, cached_input_tokens: 270000, output_tokens: 1000 } },
            },
        },
        { type: "event_msg", payload: { type: "task_complete" } },
    ];
    writeFileSync(
        join(sessions, "rollout-synthetic.jsonl"),
        lines.map((row) => SafeJSON.stringify({ timestamp, ...row })).join("\n")
    );

    async function run(kind: string): Promise<string> {
        const child = Bun.spawn(
            [
                "bun",
                join(import.meta.dir, "../../../ai-usage/index.ts"),
                "codex",
                kind,
                "--since",
                "2026-09-07",
                "--until",
                "2026-09-07",
                "--json",
            ],
            {
                env: {
                    ...process.env,
                    ...agentHomeEnvPatch(),
                    HOME: home,
                    GENESIS_TOOLS_HOME: join(home, ".genesis-tools"),
                },
                stdout: "pipe",
                stderr: "pipe",
            }
        );
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect({ code, stderr }).toMatchObject({ code: 0 });
        return stdout;
    }
    const review = SafeJSON.parse(await run("reviews"), { strict: true }) as CodexAnalysis;
    expect(review.passes[0]).toMatchObject({ activity: "code-review", evidence: "metadata", completed: true });
    expect(review.totals.costUSD).toBeCloseTo(0.65502, 10);
    const daily = SafeJSON.parse(await run("daily"), { strict: true }) as { analysis: CodexAnalysis };
    expect(daily.analysis.totals.longContextRequests).toBe(1);
}, 20_000);
