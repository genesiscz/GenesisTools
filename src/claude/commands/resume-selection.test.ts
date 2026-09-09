import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DisplaySession, resumeDirectory, selectClaudeResumeSession } from "./resume";

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
        selectClaudeResumeSession({
            candidates: [session("first"), session("second")],
            query: "invoice",
            interactive: false,
        })
    ).rejects.toThrow(/unique session|ambiguous/i);
});

test("an empty Claude resume selection names the lack of matches", async () => {
    await expect(selectClaudeResumeSession({ candidates: [], query: "invoice", interactive: false })).rejects.toThrow(
        /no .*sessions/i
    );
});

test("one proven Claude resume result still works without a TTY", async () => {
    const selected = await selectClaudeResumeSession({
        candidates: [session("first")],
        query: "invoice",
        interactive: false,
    });
    expect(selected.sessionId).toBe("first");
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
