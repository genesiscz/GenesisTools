import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";

/**
 * A fixed home for the byte goldens of `tools ai-spend daily`, `weekly` and `statusline`: two Claude sessions
 * over two ISO weeks and one Codex rollout, every timestamp in September 2026, so no window ever reaches the real
 * clock. The goldens were written from the code before the spend library moved into `@genesiscz/utils` (design
 * 2026-11-01, step U8); the move and every alias door must print the same bytes.
 */

const REPO_ROOT = join(moduleDir(import.meta), "..", "..", "..");

export const GOLDEN_DIR = moduleDir(import.meta);

/** The `tools <tool>` entrypoints a golden case may run. */
export const GOLDEN_ENTRYPOINTS = {
    "ai-spend": join(REPO_ROOT, "src", "ai-spend", "index.ts"),
    ai: join(REPO_ROOT, "src", "ai", "index.ts"),
} as const;

export type GoldenEntrypoint = keyof typeof GOLDEN_ENTRYPOINTS;

const WINDOW = ["--since", "2026-09-07", "--until", "2026-09-16", "--timezone", "UTC"];

/** The statusline hook of the golden session; no `cost`, so the line shows the cost ai-spend computed. */
const STATUSLINE_HOOK = {
    session_id: "sess-golden-a",
    model: { id: "claude-opus-4-8", display_name: "Opus" },
    workspace: { current_dir: "/work/acme" },
    context_window: { total_input_tokens: 42_000, context_window_size: 200_000 },
};

export interface GoldenCase {
    /** The golden file under `__fixtures__/`, without `.golden`. */
    name: string;
    /** The `tools ai-spend` arguments; an alias door prefixes its own path. */
    args: string[];
    stdin?: string;
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
    { name: "daily", args: ["daily", ...WINDOW] },
    { name: "daily-json", args: ["daily", ...WINDOW, "--json"] },
    { name: "weekly", args: ["weekly", ...WINDOW] },
    { name: "weekly-json", args: ["weekly", ...WINDOW, "--json"] },
    {
        name: "statusline",
        args: ["statusline", "--since", "2026-09-07", "--timezone", "UTC"],
        stdin: SafeJSON.stringify(STATUSLINE_HOOK),
    },
];

function claudeLine(options: {
    id: string;
    sessionId: string;
    timestamp: string;
    model: string;
    usage: [input: number, output: number, cacheWrite: number, cacheRead: number];
}): string {
    const [input, output, cacheWrite, cacheRead] = options.usage;

    return SafeJSON.stringify({
        type: "assistant",
        timestamp: options.timestamp,
        cwd: "/work/acme",
        sessionId: options.sessionId,
        message: {
            id: options.id,
            model: options.model,
            usage: {
                input_tokens: input,
                output_tokens: output,
                cache_creation_input_tokens: cacheWrite,
                cache_read_input_tokens: cacheRead,
            },
        },
    });
}

function codexRollout(): string {
    const timestamp = "2026-09-14T09:30:00Z";
    const rows = [
        { type: "session_meta", payload: { id: "codex-golden", source: "cli", cwd: "/work/acme" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
        { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-6-astra" } },
        {
            type: "event_msg",
            payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 12_000, cached_input_tokens: 8_000, output_tokens: 900 } },
            },
        },
        { type: "event_msg", payload: { type: "task_complete" } },
    ];

    return rows.map((row) => SafeJSON.stringify({ timestamp, ...row })).join("\n");
}

/** Writes the fixture home and returns its path. */
export function writeGoldenHome(): string {
    const home = mkdtempSync(join(tmpdir(), "ai-spend-golden-"));
    const claude = join(home, ".claude", "projects", "-work-acme");
    mkdirSync(claude, { recursive: true });
    writeFileSync(
        join(claude, "sess-golden-a.jsonl"),
        [
            claudeLine({
                id: "msg-a1",
                sessionId: "sess-golden-a",
                timestamp: "2026-09-07T08:15:00.000Z",
                model: "claude-opus-4-8",
                usage: [1200, 340, 5000, 18_000],
            }),
            claudeLine({
                id: "msg-a2",
                sessionId: "sess-golden-a",
                timestamp: "2026-09-07T09:40:00.000Z",
                model: "claude-opus-4-8",
                usage: [800, 1210, 0, 26_000],
            }),
            claudeLine({
                id: "msg-a3",
                sessionId: "sess-golden-a",
                timestamp: "2026-09-09T14:05:00.000Z",
                model: "claude-sonnet-4-5",
                usage: [2400, 610, 1200, 9000],
            }),
        ].join("\n")
    );
    writeFileSync(
        join(claude, "sess-golden-b.jsonl"),
        [
            claudeLine({
                id: "msg-b1",
                sessionId: "sess-golden-b",
                timestamp: "2026-09-14T11:00:00.000Z",
                model: "claude-sonnet-4-5",
                usage: [3100, 920, 4000, 12_500],
            }),
            claudeLine({
                id: "msg-b2",
                sessionId: "sess-golden-b",
                timestamp: "2026-09-15T16:45:00.000Z",
                model: "claude-opus-4-8",
                usage: [500, 2200, 0, 31_000],
            }),
        ].join("\n")
    );

    const codex = join(home, ".codex", "sessions", "2026", "09", "14");
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, "rollout-2026-09-14T09-30-00-codex-golden.jsonl"), codexRollout());

    return home;
}

export interface GoldenRun {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * Runs one case through an entrypoint. The child gets a minimal environment, not this process's: the goldens are
 * written outside the test runner, and a variable only one side has (a colour flag, a provider home) would change
 * the bytes.
 */
export async function runGoldenCase(options: {
    home: string;
    entrypoint: GoldenEntrypoint;
    /** The command path in front of the case's arguments (`["usage", "spend"]` for `tools ai usage spend`). */
    prefix?: string[];
    golden: GoldenCase;
}): Promise<GoldenRun> {
    const child = Bun.spawn(
        ["bun", GOLDEN_ENTRYPOINTS[options.entrypoint], ...(options.prefix ?? []), ...options.golden.args],
        {
            env: {
                PATH: env.getProcessEnv().PATH,
                HOME: options.home,
                GENESIS_TOOLS_HOME: genesisToolsDirIn(options.home),
                TZ: "UTC",
                LANG: "en_US.UTF-8",
                LC_ALL: "en_US.UTF-8",
                NO_COLOR: "1",
            },
            stdin: options.golden.stdin === undefined ? "ignore" : new Blob([options.golden.stdin]),
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);

    return { stdout, stderr, code };
}

export function goldenPath(name: string): string {
    return join(GOLDEN_DIR, `${name}.golden`);
}
