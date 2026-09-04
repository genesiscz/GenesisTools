import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * Like record-hook.test.ts: the cmux-refs hook is a standalone plugin script
 * (it cannot import src/), so it is tested the way Claude Code runs it — a
 * real process, payload on stdin, assertions on the journal it leaves behind.
 *
 * The tty gate exists because a headless child (`claude -p` from a Bash tool)
 * inherits the parent's CMUX_SURFACE_ID and, recorded, RELABELS the parent's
 * tab — `cmux tree` and monitor presence then call the pane's real session
 * "not in cmux" (2026-09-01, surface:108).
 */
const HOOK = join(
    findProjectRoot(import.meta.dir) ?? process.cwd(),
    "plugins/genesis-tools/hooks/record-session-cmux.ts"
);

let home: string;

async function runHook(payload: string, env: Record<string, string> = {}): Promise<number> {
    const proc = Bun.spawn(["bun", HOOK], {
        stdin: new TextEncoder().encode(payload),
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            GENESIS_TOOLS_HOME: home,
            CMUX_WORKSPACE_ID: "TEST-WS",
            CMUX_SURFACE_ID: "TEST-SURFACE",
            TMUX_PANE: "",
            CLAUDE_PID: "",
            ...env,
        },
    });

    return await proc.exited;
}

async function readJournal(): Promise<Record<string, unknown>[]> {
    const path = join(home, ".genesis-tools", "claude-code", "cmux-refs.jsonl");
    const text = await readFile(path, "utf8").catch(() => "");

    return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => SafeJSON.parse(line, { strict: true }) as Record<string, unknown>);
}

const PAYLOAD = SafeJSON.stringify({ session_id: "11111111-aaaa-bbbb-cccc-000000000001", cwd: "/tmp" });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "record-cmux-hook-"));
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

describe("record-session-cmux tty gate", () => {
    test("a headless claude (tty '??') is not recorded", async () => {
        // A plain spawned sleep has no controlling tty, same as `claude -p`.
        const headless = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

        try {
            await runHook(PAYLOAD, { CLAUDE_PID: String(headless.pid) });
            expect(await readJournal()).toEqual([]);
        } finally {
            headless.kill();
        }
    });

    test("no CLAUDE_PID fails open and records", async () => {
        await runHook(PAYLOAD);
        const entries = await readJournal();

        expect(entries).toHaveLength(1);
        expect(entries[0].sessionId).toBe("11111111-aaaa-bbbb-cccc-000000000001");
        expect(entries[0].surfaceId).toBe("TEST-SURFACE");
    });

    test("a dead CLAUDE_PID fails open and records", async () => {
        // A pid ps cannot answer for must not read as "headless": losing the
        // journal entirely is worse than one stray line.
        await runHook(PAYLOAD, { CLAUDE_PID: "999999" });

        expect(await readJournal()).toHaveLength(1);
    });

    test("no cmux surface and no tmux pane records nothing", async () => {
        await runHook(PAYLOAD, { CMUX_SURFACE_ID: "", CMUX_WORKSPACE_ID: "" });

        expect(await readJournal()).toEqual([]);
    });
});
