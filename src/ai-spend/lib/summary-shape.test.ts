import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { agentHomeEnvPatch } from "./drivers/test-env";
import type { Report } from "./types";

/**
 * Characterization of the three transcript views (`summary`, `sessions`,
 * `today`, plus the bare default) BEFORE `lib/discover.ts` is replaced by
 * `reports/load.ts`.
 *
 * It spawns the real CLI rather than calling the aggregator, because what has
 * to survive the swap is the JSON a caller sees on stdout: the `Report` keys,
 * the leaderboard shapes and the numbers, not an internal function signature.
 * The fixture HOME carries only `~/.claude/projects`, so the wider native
 * discovery stack (`~/.config/claude/projects`, `CLAUDE_CONFIG_DIR`) finds
 * nothing extra and the two stacks are comparable. The three provider-home
 * overrides are cleared from the child's environment for the same reason.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "src", "ai-spend", "index.ts");

/** claude-3-5-haiku: $0.8/M in, $4/M out, $1.0/M cache write, $0.08/M cache read. */
const MODEL = "claude-3-5-haiku";

function assistantLine(options: {
    id: string;
    iso: string;
    sessionId: string;
    cwd: string;
    usage: Record<string, number>;
}): string {
    return SafeJSON.stringify({
        type: "assistant",
        timestamp: options.iso,
        cwd: options.cwd,
        sessionId: options.sessionId,
        message: { id: options.id, model: MODEL, usage: options.usage },
    });
}

function runView(home: string, toolsHome: string, view: string): Report {
    const argv = view === "" ? [CLI, "--json"] : [CLI, view, "--json"];
    const proc = Bun.spawnSync({
        cmd: ["bun", "run", ...argv],
        cwd: REPO_ROOT,
        // The patch comes AFTER the spread: a developer with CODEX_HOME or
        // GROK_HOME set would otherwise have the child walk a real transcript
        // tree, which moves total.cost and projectCount and fails the run.
        env: { ...process.env, ...agentHomeEnvPatch(), HOME: home, GENESIS_TOOLS_HOME: toolsHome },
    });

    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();

    // Never swallow the child's stderr: an empty stdout from a crashed process
    // and an empty report are indistinguishable otherwise.
    if (proc.exitCode !== 0) {
        throw new Error(`ai-spend ${view || "(root)"} exited ${proc.exitCode}\n${stderr}`);
    }

    return SafeJSON.parse(stdout.trim(), { strict: true }) as Report;
}

describe("ai-spend transcript views (characterization)", () => {
    let home: string;
    let toolsHome: string;
    let today: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ai-spend-shape-home-"));
        toolsHome = mkdtempSync(join(tmpdir(), "ai-spend-shape-gt-"));
        today = new Date().toISOString().slice(0, 10);

        const workDir = join(home, ".claude", "projects", "-tmp-work");
        const shopDir = join(home, ".claude", "projects", "-tmp-shop");
        mkdirSync(workDir, { recursive: true });
        mkdirSync(shopDir, { recursive: true });

        const iso = `${today}T10:00:00.000Z`;
        writeFileSync(
            join(workDir, "s1.jsonl"),
            [
                assistantLine({
                    id: "m1",
                    iso,
                    sessionId: "s1",
                    cwd: "/tmp/work",
                    usage: { input_tokens: 1_000_000, output_tokens: 200_000 },
                }),
                // Duplicate message id: both stacks keep the first copy only.
                assistantLine({
                    id: "m1",
                    iso,
                    sessionId: "s1",
                    cwd: "/tmp/work",
                    usage: { input_tokens: 999_000_000 },
                }),
                "{not json}",
                "",
            ].join("\n")
        );
        writeFileSync(
            join(shopDir, "s2.jsonl"),
            `${assistantLine({
                id: "m2",
                iso,
                sessionId: "s2",
                cwd: "/tmp/shop",
                usage: { input_tokens: 500_000, cache_read_input_tokens: 1_000_000 },
            })}\n`
        );
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(toolsHome, { recursive: true, force: true });
    });

    test("summary --json carries the full Report shape and the priced totals", () => {
        const report = runView(home, toolsHome, "summary");

        expect(Object.keys(report).sort()).toEqual([
            "days",
            "models",
            "projectCount",
            "projects",
            "sessionCount",
            "sessions",
            "total",
            "windowEndDay",
            "windowStartDay",
        ]);

        expect(report.projectCount).toBe(2);
        expect(report.sessionCount).toBe(2);
        // m1: 1M in ($0.80) + 0.2M out ($0.80) · m2: 0.5M in ($0.40) + 1M cacheRead ($0.08)
        expect(report.total.cost).toBeCloseTo(2.08, 6);
        expect(report.total.tokens).toEqual({ input: 1_500_000, output: 200_000, cacheWrite: 0, cacheRead: 1_000_000 });
        expect(report.total.totalTokens).toBe(2_700_000);
        expect(report.total.cacheHitRate).toBeCloseTo(1_000_000 / 2_500_000, 6);
        expect(report.windowEndDay).toBe(today);
    });

    test("models, projects, days and sessions rows keep their field sets", () => {
        const report = runView(home, toolsHome, "summary");

        expect(report.models).toEqual([
            {
                model: MODEL,
                priced: true,
                tokens: { input: 1_500_000, output: 200_000, cacheWrite: 0, cacheRead: 1_000_000 },
                totalTokens: 2_700_000,
                cost: report.models[0].cost,
            },
        ]);
        expect(report.days).toEqual([{ day: today, totalTokens: 2_700_000, cost: report.days[0].cost }]);
        expect(report.projects.map((project) => project.project).sort()).toEqual(["/tmp/shop", "/tmp/work"]);
        expect(Object.keys(report.projects[0]).sort()).toEqual(["cost", "project", "sessions", "totalTokens"]);
        expect(report.projects.every((project) => project.sessions === 1)).toBe(true);
    });

    test("sessions --json ranks sessions by cost and keeps the session row fields", () => {
        const report = runView(home, toolsHome, "sessions");

        expect(report.sessions.map((session) => session.sessionId)).toEqual(["s1", "s2"]);
        expect(Object.keys(report.sessions[0]).sort()).toEqual([
            "cost",
            "lastDay",
            "project",
            "sessionId",
            "totalTokens",
        ]);
        expect(report.sessions[0]).toEqual({
            sessionId: "s1",
            project: "/tmp/work",
            lastDay: today,
            totalTokens: 1_200_000,
            cost: report.sessions[0].cost,
        });
        expect(report.sessions[0].cost).toBeCloseTo(1.6, 6);
        expect(report.sessions[1].cost).toBeCloseTo(0.48, 6);
    });

    test("today --json narrows the window to the UTC day and keeps the same shape", () => {
        const report = runView(home, toolsHome, "today");

        expect(report.windowStartDay).toBe(today);
        expect(report.windowEndDay).toBe(today);
        expect(report.total.cost).toBeCloseTo(2.08, 6);
        expect(report.days).toEqual([{ day: today, totalTokens: 2_700_000, cost: report.days[0].cost }]);
    });

    test("the bare command is the summary view", () => {
        expect(runView(home, toolsHome, "")).toEqual(runView(home, toolsHome, "summary"));
    });
});
