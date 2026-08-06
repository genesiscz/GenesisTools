import { mkdtemp, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { findRecentSessions, projectSlug } from "./limit-kill";

const CWD = "/Users/me/Work/app";

let root: string | undefined;

async function makeRoot(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "limit-kill-test-"));
    await mkdir(join(root, projectSlug(CWD)), { recursive: true });
    return root;
}

/** Write a transcript and backdate it, mimicking Claude Code's JSONL layout. */
async function writeSession(
    id: string,
    records: unknown[],
    opts: { ageMs?: number; cwd?: string; dir?: string } = {}
): Promise<void> {
    const dir = join(root!, opts.dir ?? projectSlug(CWD));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    const withCwd = records.map((r) => ({ cwd: opts.cwd ?? CWD, sessionId: id, ...(r as object) }));
    await writeFile(path, `${withCwd.map((r) => SafeJSON.stringify(r)).join("\n")}\n`);

    if (opts.ageMs) {
        const when = new Date(Date.now() - opts.ageMs);
        await utimes(path, when, when);
    }
}

const limitRecord = {
    type: "assistant",
    isApiErrorMessage: true,
    error: "rate_limit",
    apiErrorStatus: 429,
    message: { role: "assistant", content: [{ type: "text", text: "You've reached your Fable 5 limit." }] },
};

afterEach(async () => {
    if (root) {
        await Bun.$`rm -rf ${root}`.quiet();
        root = undefined;
    }
});

describe("projectSlug", () => {
    test("maps every non-alphanumeric character to a dash", () => {
        expect(projectSlug("/Users/me/Work/app")).toBe("-Users-me-Work-app");
        expect(projectSlug("/Users/me/.claude")).toBe("-Users-me--claude");
        expect(projectSlug("/Users/me/Work/app/.worktrees/fix_it")).toBe("-Users-me-Work-app--worktrees-fix-it");
    });
});

describe("findRecentSessions", () => {
    test("returns nothing when the project has no transcripts", async () => {
        await makeRoot();
        expect(await findRecentSessions("/Users/me/Work/other", { root })).toEqual([]);
    });

    test("flags the rate-limited ending and carries the last prompt", async () => {
        await makeRoot();
        await writeSession("aaaaaaaa-1111-2222-3333-444444444444", [
            { type: "last-prompt", lastPrompt: "/vitrinka:answers  now\nplease" },
            limitRecord,
        ]);

        const [session] = await findRecentSessions(CWD, { root });
        expect(session.id).toBe("aaaaaaaa-1111-2222-3333-444444444444");
        expect(session.limitStop).toBe("You've reached your Fable 5 limit.");
        expect(session.lastPrompt).toBe("/vitrinka:answers now please");
    });

    test("a session that kept working after the limit is not flagged", async () => {
        await makeRoot();
        await writeSession("bbbbbbbb-1111-2222-3333-444444444444", [
            limitRecord,
            ...Array.from({ length: 3 }, () => ({
                type: "assistant",
                message: { model: "claude-opus-5", content: [{ type: "text", text: "back at it" }] },
            })),
            { type: "last-prompt", lastPrompt: "carry on with Opus" },
        ]);

        const [session] = await findRecentSessions(CWD, { root });
        expect(session.limitStop).toBeNull();
        expect(session.lastPrompt).toBe("carry on with Opus");
    });

    test("still flags the limit when shutdown noise buries it", async () => {
        await makeRoot();
        // What a real limit death leaves behind: agents stopping, the exit
        // interrupt, queued input — 18+ records, none of them a model turn.
        await writeSession("ffffffff-1111-2222-3333-444444444444", [
            limitRecord,
            ...Array.from({ length: 8 }, () => ({ type: "queue-operation" })),
            { type: "system" },
            { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
            { type: "attachment" },
            { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "No response." }] } },
            ...Array.from({ length: 8 }, () => ({ type: "queue-operation" })),
            { type: "last-prompt", lastPrompt: "we can continue" },
        ]);

        const [session] = await findRecentSessions(CWD, { root });
        expect(session.limitStop).toBe("You've reached your Fable 5 limit.");
        expect(session.lastPrompt).toBe("we can continue");
    });

    test("skips subagent transcripts even when they are the newest", async () => {
        await makeRoot();
        await writeSession("aaaaaaaa-1111-2222-3333-444444444444", [limitRecord], { ageMs: 120_000 });
        // Background agents keep writing after the session that spawned them died.
        await writeSession("99999999-1111-2222-3333-444444444444", [
            { type: "agent-setting", agentSetting: "Explore" },
            { type: "last-prompt", lastPrompt: "<teammate-message …>" },
        ]);

        const found = await findRecentSessions(CWD, { root });
        expect(found.map((s) => s.id.slice(0, 8))).toEqual(["aaaaaaaa"]);
        expect(found[0].limitStop).not.toBeNull();
    });

    test("orders newest first, drops stale ones, and caps the list", async () => {
        await makeRoot();
        await writeSession("11111111-0000-0000-0000-000000000000", [limitRecord], { ageMs: 60_000 });
        await writeSession("22222222-0000-0000-0000-000000000000", [{ type: "last-prompt", lastPrompt: "older" }], {
            ageMs: 2 * 3_600_000,
        });
        await writeSession("33333333-0000-0000-0000-000000000000", [{ type: "last-prompt", lastPrompt: "ancient" }], {
            ageMs: 30 * 3_600_000,
        });

        const found = await findRecentSessions(CWD, { root });
        expect(found.map((s) => s.id.slice(0, 2))).toEqual(["11", "22"]);

        expect((await findRecentSessions(CWD, { root, limit: 1 })).length).toBe(1);
    });

    test("keeps a session that moved into a worktree and names the subdirectory", async () => {
        await makeRoot();
        const path = join(root!, projectSlug(CWD), "eeeeeeee-0000-0000-0000-000000000000.jsonl");
        await writeFile(
            path,
            [
                SafeJSON.stringify({ cwd: CWD, type: "last-prompt", lastPrompt: "start here" }),
                SafeJSON.stringify({ cwd: `${CWD}/.worktrees/fix`, type: "last-prompt", lastPrompt: "now in the worktree" }),
                SafeJSON.stringify({ cwd: `${CWD}/.worktrees/fix`, ...limitRecord }),
            ].join("\n")
        );

        const [session] = await findRecentSessions(CWD, { root });
        expect(session.subdir).toBe(".worktrees/fix");
        expect(session.limitStop).toBe("You've reached your Fable 5 limit.");
    });

    test("rejects a transcript whose own cwd disagrees (slug collision)", async () => {
        await makeRoot();
        // "/Users/me/Work-app" slugs identically to "/Users/me/Work/app".
        await writeSession("cccccccc-0000-0000-0000-000000000000", [limitRecord], {
            cwd: "/Users/me/Work-app",
            dir: projectSlug(CWD),
        });

        expect(await findRecentSessions(CWD, { root })).toEqual([]);
    });

    test("survives a torn last line", async () => {
        await makeRoot();
        const dir = join(root!, projectSlug(CWD));
        const path = join(dir, "dddddddd-0000-0000-0000-000000000000.jsonl");
        await writeFile(
            path,
            `${SafeJSON.stringify({ cwd: CWD, type: "last-prompt", lastPrompt: "intact" })}\n{"cwd":"${CWD}","type":"assi`
        );

        const [session] = await findRecentSessions(CWD, { root });
        expect(session.lastPrompt).toBe("intact");
    });
});
