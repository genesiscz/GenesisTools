import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_SECTION, type ResumeRow, RUNNING_SECTION } from "@genesiscz/utils/agent-sessions/session-display";
import type { RunningCmuxSession } from "@genesiscz/utils/ai/active-sessions";
import type { TableSelectOptions } from "@genesiscz/utils/prompts/clack/table-select";
import { chooseClaudeResumeSession, type DisplaySession, resumeDirectory } from "./resume";

function session(sessionId: string): DisplaySession {
    return {
        sessionId,
        name: "Invoice work",
        summary: "",
        branch: "",
        project: "shop",
        modified: "2026-09-01",
        source: "search",
        firstPrompt: "",
    };
}

test("ambiguous Claude resume never silently selects the first result outside a TTY", async () => {
    await expect(
        chooseClaudeResumeSession({
            candidates: [session("first"), session("second")],
            query: "invoice",
            interactive: false,
        })
    ).rejects.toThrow(/unique session|ambiguous/i);
});

test("an empty Claude resume selection names the lack of matches", async () => {
    await expect(chooseClaudeResumeSession({ candidates: [], query: "invoice", interactive: false })).rejects.toThrow(
        /no .*sessions/i
    );
});

test("one proven Claude resume result still works without a TTY", async () => {
    const selected = await chooseClaudeResumeSession({
        candidates: [session("first")],
        query: "invoice",
        interactive: false,
    });
    expect(selected).toEqual({ action: "resume", session: session("first") });
});

test("resume falls back to the current directory when the recorded one is gone", () => {
    // 629 of 1,617 indexed sessions here name a directory that no longer exists. Bun.spawn
    // rejects a missing cwd with `ENOENT ... posix_spawn '/bin/zsh'`, which reads as a broken
    // shell rather than a stale path, so resume died for more than a third of all sessions.
    const live = mkdtempSync(join(tmpdir(), "gt-resume-cwd-"));
    const gone = join(live, "removed-worktree");

    expect(resumeDirectory({ ...session("live"), cwd: live })).toEqual({ cwd: live });
    expect(resumeDirectory({ ...session("gone"), cwd: gone })).toEqual({ cwd: process.cwd(), missing: gone });
    expect(resumeDirectory({ ...session("none"), cwd: "" })).toEqual({ cwd: process.cwd() });
});

// 2026-11-03: a bare `--resume` picker listed "mac-bottleneck" like any other session while it ran in a cmux tab,
// and Enter on it opened a second Claude process on that session.
describe("the bare resume picker and sessions that already run", () => {
    const tab = (sessionId: string, cwd = "/projects/shop"): RunningCmuxSession => ({
        sessionId,
        title: `title ${sessionId}`,
        cwd,
        pid: process.pid,
        surfaceId: `surface-uuid-${sessionId}`,
        surfaceRef: `surface:${sessionId.length}`,
    });

    function picker(choose = 0) {
        const shown: Array<TableSelectOptions<ResumeRow>> = [];
        const pick = async <T>(opts: TableSelectOptions<T>): Promise<T | null> => {
            shown.push(opts as unknown as TableSelectOptions<ResumeRow>);
            return opts.rows[choose]?.value ?? null;
        };

        return { shown, pick };
    }

    test("a running session is marked live on top, and Enter on it focuses its tab", async () => {
        const { shown, pick } = picker(0);
        const choice = await chooseClaudeResumeSession({
            candidates: [session("idle"), session("live")],
            interactive: true,
            cwd: "/projects/shop",
            running: [tab("live")],
            pick,
        });

        expect(choice).toEqual({ action: "focus", running: tab("live") });
        expect(shown[0].rows.map((row) => [row.section, row.value.action, row.value.display.sessionId])).toEqual([
            [RUNNING_SECTION, "focus", "live"],
            [HISTORY_SECTION, "resume", "idle"],
            [HISTORY_SECTION, "resume", "live"],
        ]);
    });

    test("a lone session that already runs opens the picker instead of resuming a second copy", async () => {
        const { shown, pick } = picker(0);
        const choice = await chooseClaudeResumeSession({
            candidates: [session("live")],
            interactive: true,
            cwd: "/projects/shop",
            running: [tab("live")],
            pick,
        });

        expect(shown.length).toBe(1);
        expect(choice.action).toBe("focus");
    });

    test("a session running in this folder is offered even when the listing did not reach it", async () => {
        const { shown, pick } = picker(0);
        await chooseClaudeResumeSession({
            candidates: [session("idle")],
            interactive: true,
            cwd: "/projects/shop",
            running: [tab("older"), tab("elsewhere", "/projects/other")],
            pick,
        });

        expect(shown[0].rows.map((row) => [row.value.action, row.value.display.sessionId])).toEqual([
            ["focus", "older"],
            ["resume", "idle"],
        ]);
    });

    test("NEGATIVE CONTROL: with nothing running, a lone session still resumes without a picker", async () => {
        const { shown, pick } = picker(0);
        const choice = await chooseClaudeResumeSession({
            candidates: [session("first")],
            interactive: true,
            cwd: "/projects/shop",
            running: [],
            pick,
        });

        expect(shown.length).toBe(0);
        expect(choice).toEqual({ action: "resume", session: session("first") });
    });
});
