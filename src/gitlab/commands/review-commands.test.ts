import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerComments } from "@app/gitlab/commands/review-drafts";
import { registerCommentsPost, registerReviewJudgements, runStep } from "@app/gitlab/commands/review-judgements";
import { mergeConfig, NEUTRAL_CONFIG } from "@app/gitlab/lib/config";
import {
    baseRoutes,
    FAKE_HOST,
    FAKE_PROJECT,
    FAKE_TOKEN,
    FakeGitLab,
    fakeConfig,
    installFakeConfig,
    mrRoutes,
    PROJECT_API,
    scoped,
    startFakeRuntime,
    status,
    stopFakeRuntime,
} from "@app/gitlab/lib/fake-gitlab";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";

interface Ran {
    stdout: string;
    stderr: string;
}

let dir = "";

beforeAll(async () => {
    await installFakeConfig();
    startFakeRuntime();
});

afterAll(() => {
    stopFakeRuntime();
});

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gt-gitlab-review-cmd-")));
    env.testing.set("GITLAB_TOKEN", FAKE_TOKEN);
    fakeConfig.current = mergeConfig({}, NEUTRAL_CONFIG);
});

afterEach(() => {
    env.testing.unset("GITLAB_TOKEN");
    process.exitCode = 0;
});

const TARGET = ["--host", FAKE_HOST, "--project", FAKE_PROJECT];
const POST_BASE = ["comments", "post"];

/** Runs `gitlab pr comments <args>` against the fake GitLab. */
async function run(fake: FakeGitLab, ...args: string[]): Promise<Ran> {
    const { stdout, stderr } = await scoped(fake, async () => {
        const program = new Command();
        program.exitOverride();
        const pr = program.command("pr");
        const comments = registerComments(pr);
        registerCommentsPost(comments);
        registerReviewJudgements(pr.command("review"));
        await program.parseAsync(["pr", ...args], { from: "user" });
    });

    return { stdout, stderr };
}

const THREAD = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const OTHER_THREAD = "a1ffffffffffffffffffffffffffffffffffffff";
const MY_THREAD = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";

function rawDiscussion(
    id: string,
    options: { author?: string; body?: string; resolved?: boolean; path?: string; line?: number; notes?: number }
): Record<string, unknown> {
    const first = {
        id: 1000,
        author: { username: options.author ?? "carol" },
        body: options.body ?? "Why this?",
        system: false,
        resolvable: true,
        resolved: options.resolved ?? false,
        ...(options.path ? { position: { new_path: options.path, new_line: options.line ?? 1 } } : {}),
    };
    const more = Array.from({ length: (options.notes ?? 1) - 1 }, (_, i) => ({
        id: 1001 + i,
        author: { username: "me" },
        body: `reply ${i}`,
        system: false,
    }));

    return { id, notes: [{ id: 999, author: { username: "gitlab" }, body: "assigned", system: true }, first, ...more] };
}

function threadFake(iid: number): FakeGitLab {
    const fake = baseRoutes(new FakeGitLab());
    mrRoutes(fake, iid);
    fake.get(`${PROJECT_API}/merge_requests/${iid}/discussions`, [
        rawDiscussion(THREAD, { path: "src/a.ts", line: 3, notes: 2 }),
        rawDiscussion(MY_THREAD, { author: "me", body: "My own\n  question", resolved: true }),
        { id: "dddddddddddddddddddddddddddddddddddddddd", notes: [{ id: 5, body: "only system", system: true }] },
    ]);

    return fake;
}

describe("comments list", () => {
    test("prints every thread with who started it, whether it is resolved and where it is anchored", async () => {
        const ran = await run(threadFake(7), "comments", "list", "7", ...TARGET);

        expect(ran.stdout).toContain("!7 — 2 thread(s)\n");
        expect(ran.stdout).toContain("id            author           state     n  anchor");
        expect(ran.stdout).toContain("a1b2c3d4e5f6  carol            open      2  src/a.ts:3\n    Why this?");
        expect(ran.stdout).toContain("c0ffee00c0ff  me               resolved  1  TOP-LEVEL\n    My own question");
        expect(ran.stdout).toContain("Second person in a reply addresses the thread's author shown above.");
    });

    test("--unresolved, --mine and --author narrow the list, and --json prints the summaries", async () => {
        const fake = threadFake(7);

        const open = await run(fake, "comments", "list", "7", "--unresolved", ...TARGET);
        const mine = await run(fake, "comments", "list", "7", "--mine", ...TARGET);
        const byAuthor = await run(fake, "comments", "list", "7", "--author", "carol", "--json", ...TARGET);
        const none = await run(fake, "comments", "list", "7", "--author", "nobody", ...TARGET);

        expect(open.stdout).toContain("!7 — 1 thread(s)");
        expect(open.stdout).not.toContain("c0ffee00c0ff");
        expect(mine.stdout).toContain("!7 — 1 thread(s)");
        expect(mine.stdout).toContain("c0ffee00c0ff");
        expect(SafeJSON.parse(byAuthor.stdout)).toMatchObject([
            { id: THREAD, author: "carol", noteCount: 2, resolved: false },
        ]);
        expect(none.stdout).toBe("No matching threads.\n");
    });
});

describe("comments drafts", () => {
    const drafts = [
        { id: 501, note: "Reply text", discussion_id: THREAD },
        { id: 502, note: "A top-level\nthought" },
        { id: 503, note: "Line note", position: { new_path: "src/a.ts", new_line: 3 } },
    ];

    test("lists my pending drafts, warns about top-level ones and prints the publish command", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.get(`${PROJECT_API}/merge_requests/7/draft_notes`, drafts);

        const ran = await run(fake, "comments", "drafts", "7", ...TARGET);

        expect(ran.stdout).toContain("!7 — 3 pending draft(s)");
        expect(ran.stdout).toContain("   501  reply → a1b2c3d4e5f6        10 chars");
        expect(ran.stdout).toContain("   503  new thread on a line         9 chars  src/a.ts:3");
        expect(ran.stdout).toContain(
            "⚠️  1 draft(s) are top-level. Intentional, or a bad discussion id:\n    502: A top-level thought"
        );
        expect(ran.stdout).toContain("Publish with: ");
        expect(ran.stdout).toContain("--expect 501,502,503");
    });

    test("--json prints the drafts and an MR without drafts says so", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.get(`${PROJECT_API}/merge_requests/7/draft_notes`, drafts);
        fake.get(`${PROJECT_API}/merge_requests/8/draft_notes`, []);

        const json = await run(fake, "comments", "drafts", "7", "--json", ...TARGET);
        const none = await run(fake, "comments", "drafts", "8", ...TARGET);

        expect(SafeJSON.parse(json.stdout)).toMatchObject([
            { id: 501, discussionId: THREAD, side: null },
            { id: 502, discussionId: null, path: null },
            { id: 503, path: "src/a.ts", line: 3, side: "new" },
        ]);
        expect(none.stdout).toBe("!8 — no pending drafts.\n");
    });
});

describe("comments reply", () => {
    function replyFake(): FakeGitLab {
        const fake = threadFake(7);
        fake.get(`${PROJECT_API}/merge_requests/7/draft_notes`, []);

        return fake;
    }

    test("creates a draft reply in the thread named by its full id, without looking the thread up", async () => {
        const fake = replyFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, { id: 601, discussion_id: THREAD });

        const ran = await run(fake, "comments", "reply", "7", THREAD, "--body", "Fixed.", ...TARGET);

        expect(fake.writes().map((w) => [w.method, w.body])).toEqual([
            ["POST", { note: "Fixed.", in_reply_to_discussion_id: THREAD }],
        ]);
        expect(fake.calls("GET", `${PROJECT_API}/merge_requests/7/discussions`)).toEqual([]);
        expect(ran.stdout).toContain("✅ draft 601 created");
        expect(ran.stdout).toContain(`   discussion_id: ${THREAD}`);
    });

    test("a unique prefix finds the thread, --resolve resolves it after the reply, and a body file is read", async () => {
        const fake = replyFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, { id: 602, discussion_id: THREAD });
        fake.on("PUT", `${PROJECT_API}/merge_requests/7/discussions/${THREAD}`, {});
        const file = join(dir, "reply.md");
        writeFileSync(file, "From a file.\n");

        const ran = await run(fake, "comments", "reply", "7", "a1b2c3", "--body-file", file, "--resolve", ...TARGET);

        expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
            [
                "POST",
                `${PROJECT_API}/merge_requests/7/draft_notes`,
                { note: "From a file.\n", in_reply_to_discussion_id: THREAD },
            ],
            ["PUT", `${PROJECT_API}/merge_requests/7/discussions/${THREAD}`, { resolved: true }],
        ]);
        expect(ran.stdout).toContain("   thread resolved");
    });

    test("a draft that already exists on the thread is updated, or extended with --append", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.get(`${PROJECT_API}/merge_requests/7/draft_notes`, [{ id: 501, note: "First", discussion_id: THREAD }]);
        fake.on("PUT", `${PROJECT_API}/merge_requests/7/draft_notes/501`, {});

        const replaced = await run(fake, "comments", "reply", "7", THREAD, "--body", "Second", ...TARGET);
        const appended = await run(fake, "comments", "reply", "7", THREAD, "--body", "Second", "--append", ...TARGET);

        expect(fake.writes().map((w) => w.body)).toEqual([{ note: "Second" }, { note: "First\n\n---\n\nSecond" }]);
        expect(replaced.stdout).toContain("✅ draft 501 updated (a draft already existed on this thread)");
        expect(appended.stdout).toContain("✅ draft 501 updated");
    });

    test("a reply GitLab stores without a thread is flagged and sets the exit code", async () => {
        const fake = replyFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, { id: 603, discussion_id: null });

        const ran = await run(fake, "comments", "reply", "7", THREAD, "--body", "Lost.", "--resolve", ...TARGET);

        expect(ran.stdout).toContain("   discussion_id: null — NOT a reply, check the discussion id");
        expect(process.exitCode).toBe(1);
        expect(ran.stdout).not.toContain("thread resolved");
    });

    test("--now posts the reply at once, and a failed resolve afterwards is reported as such", async () => {
        const fake = replyFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/discussions/${THREAD}/notes`, { id: 77 });
        fake.on("PUT", `${PROJECT_API}/merge_requests/7/discussions/${THREAD}`, {});

        const ran = await run(
            fake,
            "comments",
            "reply",
            "7",
            THREAD,
            "--body",
            "Done.",
            "--now",
            "--resolve",
            ...TARGET
        );

        expect(ran.stdout).toContain("✅ note 77 published in a1b2c3d4e5f6");
        expect(ran.stdout).toContain("   thread resolved");

        fake.on("PUT", `${PROJECT_API}/merge_requests/7/discussions/${THREAD}`, status(403, { message: "no" }));

        await expect(
            run(fake, "comments", "reply", "7", THREAD, "--body", "Done.", "--now", "--resolve", ...TARGET)
        ).rejects.toThrow("reply landed but resolve failed: 403 ");
    });

    test("it names an ambiguous or unknown thread prefix and a body that is missing", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.get(`${PROJECT_API}/merge_requests/7/discussions`, [
            rawDiscussion(THREAD, { path: "src/a.ts", line: 3 }),
            rawDiscussion(OTHER_THREAD, {}),
        ]);

        await expect(run(fake, "comments", "reply", "7", "a1", "--body", "x", ...TARGET)).rejects.toThrow(
            `"a1" matches 2 threads. Use a longer prefix:\n  ${THREAD}  src/a.ts\n  ${OTHER_THREAD}  TOP-LEVEL`
        );
        await expect(run(fake, "comments", "reply", "7", "zz", "--body", "x", ...TARGET)).rejects.toThrow(
            'No thread on !7 matches "zz".'
        );
        await expect(run(fake, "comments", "reply", "7", THREAD, ...TARGET)).rejects.toThrow(
            "Give --body-file <path> (preferred) or --body <text>."
        );
        expect(fake.writes()).toEqual([]);
    });

    test("a draft GitLab refuses is an error carrying the status", async () => {
        const fake = replyFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, status(422, { message: "taken" }));

        await expect(run(fake, "comments", "reply", "7", THREAD, "--body", "x", ...TARGET)).rejects.toThrow("422 ");
    });
});

describe("comments add", () => {
    const diff = "@@ -1,2 +1,3 @@\n line one\n+added line two\n line three\n";

    function addFake(): FakeGitLab {
        const fake = baseRoutes(new FakeGitLab());
        mrRoutes(fake, 7, {
            mr: { diff_refs: { base_sha: "b".repeat(40), start_sha: "s".repeat(40), head_sha: "h".repeat(40) } },
        });
        fake.get(`${PROJECT_API}/merge_requests/7/diffs`, [
            {
                old_path: "src/a.ts",
                new_path: "src/a.ts",
                new_file: false,
                renamed_file: false,
                deleted_file: false,
                diff,
            },
        ]);

        return fake;
    }

    test("anchors a draft to a line of the diff and reads the stored anchor back", async () => {
        const fake = addFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, (request) => ({
            id: 701,
            position: (request.body as { position: Record<string, unknown> }).position,
        }));

        const ran = await run(
            fake,
            "comments",
            "add",
            "7",
            "--file",
            "src/a.ts",
            "--line",
            "2",
            "--body",
            "Why?",
            ...TARGET
        );

        expect(fake.writes()[0]?.body).toMatchObject({
            note: "Why?",
            position: {
                position_type: "text",
                new_path: "src/a.ts",
                old_path: "src/a.ts",
                new_line: 2,
                old_line: null,
            },
        });
        expect(ran.stdout).toContain("✅ draft 701 anchored to src/a.ts:2");
    });

    test("a line outside the diff, a draft GitLab stored off its anchor, and a wrong flag mix fail before or without a stray note", async () => {
        const fake = addFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, { id: 702, position: null });
        fake.on("DELETE", `${PROJECT_API}/merge_requests/7/draft_notes/702`, status(204));

        await expect(
            run(fake, "comments", "add", "7", "--file", "src/a.ts", "--line", "40", "--body", "x", ...TARGET)
        ).rejects.toThrow(
            "src/a.ts: line 40 on the new side is not in the MR diff, so GitLab cannot anchor a comment there."
        );
        await expect(
            run(fake, "comments", "add", "7", "--file", "src/zzz.ts", "--line", "1", "--body", "x", ...TARGET)
        ).rejects.toThrow("src/zzz.ts is not in the MR diff, so GitLab cannot anchor a comment there.");
        await expect(
            run(fake, "comments", "add", "7", "--file", "src/a.ts", "--line", "2", "--body", "x", ...TARGET)
        ).rejects.toThrow("GitLab dropped the anchor for src/a.ts:2; the draft it created was deleted again.");
        await expect(run(fake, "comments", "add", "7", "--file", "src/a.ts", "--body", "x", ...TARGET)).rejects.toThrow(
            "--file and --line go together."
        );
        await expect(
            run(fake, "comments", "add", "7", "--file", "src/a.ts", "--line", "3x", "--body", "x", ...TARGET)
        ).rejects.toThrow('--line must be a positive line number, got "3x"');
        await expect(run(fake, "comments", "add", "7", "--body", "x", ...TARGET)).rejects.toThrow(
            "Give --discussion <id>, or --file/--line, or --top-level."
        );
        expect(fake.writes().map((w) => w.method)).toEqual(["POST", "DELETE"]);
    });

    test("--top-level makes a draft with no anchor, and one MR never takes --now or --dry-run", async () => {
        const fake = addFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, { id: 703 });

        const ran = await run(fake, "comments", "add", "7", "--top-level", "--body", "Overall: fine.", ...TARGET);

        expect(ran.stdout).toContain("✅ draft 703 created as a top-level note on !7");
        expect(fake.writes()[0]?.body).toEqual({ note: "Overall: fine." });
        await expect(
            run(fake, "comments", "add", "7", "--top-level", "--now", "--body", "x", ...TARGET)
        ).rejects.toThrow("--now and --dry-run on `comments add` are for a comma list of MRs.");
    });

    test("a comma list of MRs posts one top-level note on each, skips a repeat and says what a dry run would do", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.on("POST", `${PROJECT_API}/merge_requests/71/notes`, { id: 7101 });
        fake.on("POST", `${PROJECT_API}/merge_requests/72/notes`, status(403, { message: "no" }));

        const dry = await run(
            fake,
            "comments",
            "add",
            "71,72",
            "--top-level",
            "--dry-run",
            "--body",
            "Rebased.",
            ...TARGET
        );

        expect(dry.stdout).toContain("[DRY] !71 — would comment");
        expect(dry.stdout).toContain("[DRY] !72 — would comment");
        expect(fake.writes()).toEqual([]);

        const ran = await run(
            fake,
            "comments",
            "add",
            "71,72",
            "--top-level",
            "--now",
            "--body",
            "Rebased.",
            ...TARGET
        );

        expect(ran.stdout).toContain("✅ !71 — ok (201, note #7101)");
        expect(ran.stdout).toContain("❌ !72 — FAIL: ");
        expect(ran.stdout).toContain("Posted: 1  Skipped (dup): 0  Failed: 1");
        expect(process.exitCode).toBe(1);

        const repeat = await run(
            fake,
            "comments",
            "add",
            "71,73",
            "--top-level",
            "--now",
            "--body",
            "Rebased.",
            ...TARGET
        );

        expect(repeat.stdout).toContain("⏭️  !71 — SKIPPED (duplicate: same message already posted)");
    });

    test("a comma list refuses anchors, and needs --now or --dry-run", async () => {
        const fake = baseRoutes(new FakeGitLab());

        await expect(run(fake, "comments", "add", "71,72", "--body", "x", ...TARGET)).rejects.toThrow(
            "A comma list of MRs takes only --top-level comments."
        );
        await expect(run(fake, "comments", "add", "71,72", "--top-level", "--body", "x", ...TARGET)).rejects.toThrow(
            "A comma list of MRs posts at once (no drafts): add --now, or --dry-run to see what would be posted."
        );
        expect(fake.writes()).toEqual([]);
    });
});

describe("comments delete, resolve and publish", () => {
    test("delete removes each draft named by its number and stops at a refused one", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.on("DELETE", `${PROJECT_API}/merge_requests/7/draft_notes/501`, status(204));
        fake.on("DELETE", `${PROJECT_API}/merge_requests/7/draft_notes/502`, status(404, { message: "gone" }));

        const ran = await run(fake, "comments", "delete", "7", "501", ...TARGET);

        expect(ran.stdout).toContain("✅ draft 501 deleted");
        await expect(run(fake, "comments", "delete", "7", "502", "501", ...TARGET)).rejects.toThrow("draft 502: 404 ");
        await expect(run(fake, "comments", "delete", "7", "D01", ...TARGET)).rejects.toThrow(
            "A draft id is a number (see `"
        );
    });

    test("resolve resolves or reopens each thread named by a full id or a prefix", async () => {
        const fake = threadFake(7);
        fake.on("PUT", `${PROJECT_API}/merge_requests/7/discussions/${THREAD}`, {});
        fake.on("PUT", `${PROJECT_API}/merge_requests/7/discussions/${MY_THREAD}`, status(403, { message: "no" }));

        const resolved = await run(fake, "comments", "resolve", "7", "a1b2c3", ...TARGET);
        const reopened = await run(fake, "comments", "resolve", "7", THREAD, "--unresolve", ...TARGET);

        expect(resolved.stdout).toContain("✅ a1b2c3d4e5f6 resolved");
        expect(reopened.stdout).toContain("✅ a1b2c3d4e5f6 reopened");
        expect(fake.writes().map((w) => w.body)).toEqual([{ resolved: true }, { resolved: false }]);
        await expect(run(fake, "comments", "resolve", "7", MY_THREAD, ...TARGET)).rejects.toThrow("c0ffee00c0ff: 403 ");
    });

    function publishFake(iid: number): FakeGitLab {
        const fake = baseRoutes(new FakeGitLab());
        fake.get(`${PROJECT_API}/merge_requests/${iid}/draft_notes`, [
            { id: 801, note: "Reply text", discussion_id: THREAD },
            { id: 802, note: "Line note", position: { new_path: "src/a.ts", new_line: 3 } },
        ]);
        fake.get(`${PROJECT_API}/merge_requests/${iid}/discussions`, [
            rawDiscussion(THREAD, { path: "src/a.ts", line: 3 }),
            rawDiscussion(MY_THREAD, { author: "me", body: "Line note", path: "src/a.ts", line: 3 }),
        ]);
        fake.on("POST", `${PROJECT_API}/merge_requests/${iid}/draft_notes/bulk_publish`, status(204));

        return fake;
    }

    test("publish is a dry run until --apply, which publishes every draft and records the threads they became", async () => {
        const fake = publishFake(7);

        const dry = await run(fake, "comments", "publish", "7", ...TARGET);

        expect(dry.stdout).toContain("!7 — 2 pending draft(s) would be published:");
        expect(dry.stdout).toContain("Dry run. Publish with: ");
        expect(dry.stdout).toContain("--expect 801,802 --apply");
        expect(fake.writes()).toEqual([]);

        const applied = await run(fake, "comments", "publish", "7", "--apply", ...TARGET);

        expect(applied.stdout).toContain("✅ published 2 draft(s) on !7");
        expect(applied.stdout).not.toContain("⚠");
        expect(fake.writes().map((w) => w.path)).toEqual([`${PROJECT_API}/merge_requests/7/draft_notes/bulk_publish`]);
    });

    test("--expect refuses a pending set that differs from the approved one and an id it does not know", async () => {
        const fake = publishFake(7);

        const ok = await run(fake, "comments", "publish", "7", "--expect", "801,802", ...TARGET);

        expect(ok.stdout).toContain("Dry run. Publish with: ");
        await expect(run(fake, "comments", "publish", "7", "--expect", "801", "--apply", ...TARGET)).rejects.toThrow(
            "The pending drafts differ from --expect; nothing was published."
        );
        await expect(run(fake, "comments", "publish", "7", "--expect", "801,802,803", ...TARGET)).rejects.toThrow(
            "The pending drafts differ from --expect; nothing was published."
        );
        await expect(run(fake, "comments", "publish", "7", "--expect", "D77", ...TARGET)).rejects.toThrow(
            "--expect names D77, which this MR's id map does not know; nothing was published."
        );
        expect(fake.writes()).toEqual([]);
    });

    test("a refused bulk publish prints the warning and sets the exit code, and an MR without drafts has nothing to publish", async () => {
        const fake = publishFake(7);
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes/bulk_publish`, status(500, { message: "boom" }));
        fake.get(`${PROJECT_API}/merge_requests/8/draft_notes`, []);

        const failed = await run(fake, "comments", "publish", "7", "--apply", ...TARGET);

        expect(failed.stdout).toContain("⛔ Publishing failed: 500 ");
        expect(failed.stdout).toContain("A failed publish may already have posted some drafts.");
        expect(process.exitCode).toBe(1);

        const none = await run(fake, "comments", "publish", "8", "--apply", ...TARGET);

        expect(none.stdout).toBe("!8 — nothing to publish.\n");
    });

    test("when reading the threads back fails after a good publish, the publish still counts", async () => {
        const fake = publishFake(7);
        fake.get(`${PROJECT_API}/merge_requests/7/discussions`, status(403, { message: "no" }));

        const ran = await run(fake, "comments", "publish", "7", "--apply", ...TARGET);

        expect(ran.stdout).toContain("✅ published 2 draft(s) on !7");
        expect(ran.stdout).toContain("⚠  published, but recording which thread each D id became failed (");
        expect(process.exitCode ?? 0).toBe(0);
    });
});

interface StoredDraft {
    id: number;
    note: string;
    position?: Record<string, unknown>;
    discussion_id?: string | null;
}

/** The draft notes of one MR as a small server: list, read, create, update and delete. */
function draftServer(fake: FakeGitLab, iid: number, initial: StoredDraft[] = []): StoredDraft[] {
    const base = `${PROJECT_API}/merge_requests/${iid}/draft_notes`;
    const drafts = [...initial];
    let nextId = 900 + initial.length;
    const one = new RegExp(`^${base}/(\\d+)$`);
    const find = (path: string) => drafts.find((d) => d.id === Number(one.exec(path)?.[1]));

    fake.get(base, () => drafts);
    fake.get(one, (request) => find(request.path) ?? status(404));
    fake.on("POST", base, (request) => {
        const body = request.body as {
            note: string;
            position?: Record<string, unknown>;
            in_reply_to_discussion_id?: string;
        };
        const created: StoredDraft = {
            id: nextId++,
            note: body.note,
            position: body.position,
            discussion_id: body.in_reply_to_discussion_id ?? null,
        };
        drafts.push(created);

        return created;
    });
    fake.on("PUT", one, (request) => {
        const draft = find(request.path);
        if (!draft) {
            return status(404);
        }

        draft.note = (request.body as { note: string }).note;

        return draft;
    });
    fake.on("DELETE", one, (request) => {
        const draft = find(request.path);
        if (draft) {
            drafts.splice(drafts.indexOf(draft), 1);
        }

        return status(204);
    });

    return drafts;
}

const DIFF = "@@ -1,2 +1,3 @@\n line one\n+added line two\n line three\n";

function reviewFake(iid: number, options: { mr?: Record<string, unknown>; drafts?: StoredDraft[] } = {}) {
    const fake = baseRoutes(new FakeGitLab());
    mrRoutes(fake, iid, {
        mr: {
            diff_refs: { base_sha: "b".repeat(40), start_sha: "s".repeat(40), head_sha: "h".repeat(40) },
            ...options.mr,
        },
    });
    fake.get(`${PROJECT_API}/merge_requests/${iid}/discussions`, [
        rawDiscussion(THREAD, { path: "src/a.ts", line: 3 }),
        rawDiscussion(MY_THREAD, { author: "me", body: "My question", path: "src/a.ts", line: 3 }),
    ]);
    fake.get(`${PROJECT_API}/merge_requests/${iid}/diffs`, [
        {
            old_path: "src/a.ts",
            new_path: "src/a.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: DIFF,
        },
    ]);
    const drafts = draftServer(
        fake,
        iid,
        options.drafts ?? [{ id: 900, note: "Draft text", position: storedPosition(2) }]
    );

    return { fake, drafts };
}

function storedPosition(line: number): Record<string, unknown> {
    return { new_path: "src/a.ts", old_path: "src/a.ts", new_line: line, old_line: line > 1 ? line - 1 : line };
}

describe("review skeleton", () => {
    test("--print shows the file for the threads others started on my MR, and writes nothing", async () => {
        const { fake } = reviewFake(91);

        const ran = await run(fake, "review", "skeleton", "91", "--receive", "--print", ...TARGET);

        expect(ran.stdout).toStartWith("# MR !91 · receive · head 00000091ca\n- Overall: \n");
        expect(ran.stdout).toContain("# T01 Why this? · discussion a1b2c3d4e5f6 · src/a.ts:3");
        expect(ran.stdout).not.toContain("Y01");
        expect(fake.writes()).toEqual([]);
    });

    test("it writes the file, refuses to overwrite it without --force, and writes JSON for a .json name or --format", async () => {
        const { fake } = reviewFake(92);
        const file = join(dir, "judgements.md");

        const ran = await run(fake, "review", "skeleton", "92", "--give", "--file", file, ...TARGET);

        expect(ran.stderr).toContain(`ℹ  2 item(s) to judge → ${file}`);
        expect(ran.stderr).toContain(`ℹ  then: tools gitlab pr 92 review check --give --file ${file}`);
        const text = readFileSync(file, "utf8");
        expect(text).toContain("# D01 Draft text · draft 900 · src/a.ts:2");
        expect(text).toContain("# Y01 My question · discussion c0ffee00c0ff · src/a.ts:3");
        expect(text).toContain("# N01 <short title of the concern>");
        await expect(run(fake, "review", "skeleton", "92", "--give", "--file", file, ...TARGET)).rejects.toThrow(
            `${file} exists; pass --force to start over, or edit it.`
        );

        await run(fake, "review", "skeleton", "92", "--give", "--file", file, "--force", ...TARGET);
        const asJson = join(dir, "judgements.json");
        await run(fake, "review", "skeleton", "92", "--give", "--file", asJson, ...TARGET);

        expect(SafeJSON.parse(readFileSync(asJson, "utf8"))).toMatchObject({ mr: 92, mode: "give" });
        const printed = await run(fake, "review", "skeleton", "92", "--give", "--format", "json", "--print", ...TARGET);

        const items = (SafeJSON.parse(printed.stdout) as { items: Array<{ id: string }> }).items;

        expect(items.map((item) => item.id)).toEqual(["D01", "Y01", "N01"]);
        await expect(run(fake, "review", "skeleton", "92", "--give", "--format", "xml", ...TARGET)).rejects.toThrow(
            '--format must be md or json, got "xml".'
        );
    });

    test("without a flag the mode follows who wrote the MR, and a bad iid or both flags are refused", async () => {
        const { fake } = reviewFake(93);
        const mine = reviewFake(94, { mr: { author: { username: "me", name: "Me", id: 99, state: "active" } } });

        const given = await run(fake, "review", "skeleton", "93", "--print", ...TARGET);
        const received = await run(mine.fake, "review", "skeleton", "94", "--print", ...TARGET);

        expect(given.stderr).toContain("mode: give (@alice is the author of !93; pass --receive or --give to choose)");
        expect(received.stderr).toContain(
            "mode: receive (you are the author of !94; pass --receive or --give to choose)"
        );
        await expect(run(fake, "review", "skeleton", "x", "--print", ...TARGET)).rejects.toThrow(
            'The MR iid must be a positive integer; got "x".'
        );
        await expect(run(fake, "review", "skeleton", "93", "--receive", "--give", ...TARGET)).rejects.toThrow(
            "Pick one: --receive (threads on my MR) or --give (someone else's MR)."
        );
    });
});

const RECEIVE_FILE = [
    "# MR !{iid} · receive · head 000000{iid}ca",
    "- Overall: Approve with comments",
    "",
    "# T01 Why this? · discussion a1b2c3d4e5f6 · src/a.ts:3",
    "- Verdict: Valid [90%]",
    "- Proposal: Fix it in the next commit.",
    "- Rationale:",
    "  - The helper is never called.",
    "- Action: reply-resolve",
    "- Proposed draft reply:",
    "",
    "```markdown",
    "@carol Fixed in the next commit.",
    "```",
    "",
].join("\n");

const GIVE_FILE = [
    "# MR !{iid} · give · head 000000{iid}ca",
    "- Overall: Approve with comments",
    "",
    "# D01 Draft text · draft 900 · src/a.ts:2",
    "- Verdict on the comment: Unclear [70%]",
    "- Rationale:",
    "  - The wording is vague.",
    "- Action: reword",
    "- Proposed rewording:",
    "",
    "```markdown",
    "Reworded text",
    "```",
    "",
    "# Y01 My question · discussion c0ffee00c0ff · src/a.ts:3",
    "- Verdict on the comment: Answered by the code [80%]",
    "- Rationale:",
    "  - The code answers it.",
    "- Action: none",
    "",
    "# N01 A new finding",
    "- Severity: nit",
    "- Anchor: src/a.ts:2 (new) `added line two`",
    "- Verdict: Nit [60%]",
    "- Proposal: Post anchored draft",
    "- Rationale:",
    "  - Reads oddly.",
    "- Action: comment",
    "- Proposed draft comment:",
    "",
    "```markdown",
    "Consider a clearer name.",
    "```",
    "",
].join("\n");

const filled = (template: string, iid: number): string => template.replaceAll("{iid}", String(iid));

describe("review check", () => {
    test("a complete file is ready to render and post", async () => {
        const { fake } = reviewFake(95);
        const file = join(dir, "j.md");
        writeFileSync(file, filled(RECEIVE_FILE, 95));

        const ran = await run(fake, "review", "check", "95", "--receive", "--file", file, ...TARGET);

        expect(ran.stdout).toContain(`✓  ${file} is ready to render and post`);
        expect(process.exitCode ?? 0).toBe(0);
    });

    test("a give file is checked against the diff, and a new finding on a line that is not there is an error", async () => {
        const { fake } = reviewFake(96);
        const good = join(dir, "good.md");
        const bad = join(dir, "bad.md");
        writeFileSync(good, filled(GIVE_FILE, 96));
        writeFileSync(bad, filled(GIVE_FILE, 96).replace("`added line two`", "`something else`"));

        const ok = await run(fake, "review", "check", "96", "--give", "--file", good, ...TARGET);
        const broken = await run(fake, "review", "check", "96", "--give", "--file", bad, ...TARGET);

        expect(ok.stdout).toContain("is ready to render and post");
        expect(broken.stdout).toContain("error(s) in ");
        expect(process.exitCode).toBe(1);
    });

    test("it says where the file is missing, warns about an item left unjudged, and counts the errors of a broken one", async () => {
        const { fake } = reviewFake(97);
        const file = join(dir, "missing.md");

        await expect(run(fake, "review", "check", "97", "--receive", "--file", file, ...TARGET)).rejects.toThrow(
            `${file} does not exist; write it with \``
        );

        await run(fake, "review", "skeleton", "97", "--receive", "--file", file, ...TARGET);
        const unjudged = await run(fake, "review", "check", "97", "--receive", "--file", file, ...TARGET);

        expect(unjudged.stdout).toContain("⚠  T01 (line 4): not judged (no verdict); it will be left out");
        expect(unjudged.stdout).toContain("is ready to render and post");

        writeFileSync(file, filled(RECEIVE_FILE, 97).replace("@carol Fixed in the next commit.\n", ""));
        const broken = await run(fake, "review", "check", "97", "--receive", "--file", file, ...TARGET);

        expect(broken.stdout).toMatch(/\n\d+ error\(s\) in /);
        expect(process.exitCode).toBe(1);
    });
});

describe("review render", () => {
    const prepared = (iid: number, text = RECEIVE_FILE) => {
        const { fake } = reviewFake(iid);
        const file = join(dir, `j${iid}.md`);
        writeFileSync(file, filled(text, iid));

        return { fake, file };
    };

    test("--digest prints one card per item with the quoted comment and the proposed reply", async () => {
        const { fake, file } = prepared(98);

        const ran = await run(
            fake,
            "review",
            "render",
            "98",
            "--receive",
            "--file",
            file,
            "--repo",
            dir,
            "--digest",
            ...TARGET
        );

        expect(ran.stdout).toStartWith("# Digest: !98 MR 98\n");
        expect(ran.stdout).toContain("- Review received · `feature/98` → `main` · head `00000098ca`");
        expect(ran.stdout).toContain("**@carol**:\n> Why this?");
        expect(ran.stdout).toContain("- **Verdict:** Valid [90%]");
        expect(ran.stdout).toContain("**Action:** Reply and resolve");
        expect(ran.stdout).toContain("@carol Fixed in the next commit.");
    });

    test("--item prints chosen items in the full layout, and --proposal prints the review proposal JSON", async () => {
        const { fake, file } = prepared(98);

        const item = await run(
            fake,
            "review",
            "render",
            "98",
            "--receive",
            "--file",
            file,
            "--repo",
            dir,
            "--item",
            "T01",
            ...TARGET
        );
        const proposal = await run(
            fake,
            "review",
            "render",
            "98",
            "--receive",
            "--file",
            file,
            "--repo",
            dir,
            "--proposal",
            ...TARGET
        );

        expect(item.stdout).toContain("## T01");
        expect(item.stdout).toContain("**Rationale:**\n\n- The helper is never called.");
        const parsed = SafeJSON.parse(proposal.stdout) as { threads: Array<Record<string, unknown>> };
        expect(parsed).toMatchObject({
            provider: "gitlab",
            number: 98,
            title: "MR 98",
            sourceBranch: "feature/98",
            verdict: { decision: "comment", summary: "Approve with comments" },
        });
        expect(parsed.threads.find((thread) => thread.threadId === THREAD)).toMatchObject({
            path: "src/a.ts",
            verdict: "valid",
            confidence: 90,
        });
    });

    test("the full layout goes beside the judgements file, or to --out, and never over the judgements file itself", async () => {
        const { fake, file } = prepared(98);

        const ran = await run(fake, "review", "render", "98", "--receive", "--file", file, "--repo", dir, ...TARGET);

        const report = join(dir, "j98-report.md");
        expect(ran.stdout).toBe(`${report}\n`);
        expect(ran.stderr).toContain(`ℹ  full layout → ${report}`);
        expect(readFileSync(report, "utf8")).toContain("# Review: !98 MR 98");
        const custom = join(dir, "custom.md");
        await run(
            fake,
            "review",
            "render",
            "98",
            "--receive",
            "--file",
            file,
            "--repo",
            dir,
            "--out",
            custom,
            ...TARGET
        );

        expect(existsSync(custom)).toBe(true);
        await expect(
            run(fake, "review", "render", "98", "--receive", "--file", file, "--repo", dir, "--out", file, ...TARGET)
        ).rejects.toThrow(`The report would overwrite the judgements file ${file}; name another path with --out.`);
    });

    test("without --repo the links point at the current directory with a warning when no worktree has the MR branch", async () => {
        const { fake, file } = prepared(98);
        const cwd = spyOn(process, "cwd").mockReturnValue(dir);

        try {
            const ran = await run(fake, "review", "render", "98", "--receive", "--file", file, "--digest", ...TARGET);

            expect(ran.stderr).toContain(
                `⚠  no worktree has feature/98 checked out; file links point into ${dir}, which may hold other code.`
            );
            expect(ran.stdout).toContain("# Digest: !98 MR 98");
        } finally {
            cwd.mockRestore();
        }
    });

    test("a broken file renders nothing and a missing file says how to write one", async () => {
        const { fake, file } = prepared(98);
        writeFileSync(file, filled(RECEIVE_FILE, 98).replace("@carol Fixed in the next commit.\n", ""));

        const ran = await run(
            fake,
            "review",
            "render",
            "98",
            "--receive",
            "--file",
            file,
            "--repo",
            dir,
            "--digest",
            ...TARGET
        );

        expect(ran.stderr).toMatch(/\d+ error\(s\) in .*; nothing was rendered\./);
        expect(ran.stdout).toBe("");
        expect(process.exitCode).toBe(1);
        await expect(
            run(fake, "review", "render", "98", "--receive", "--file", join(dir, "none.md"), ...TARGET)
        ).rejects.toThrow("does not exist; write it with `");
    });
});

describe("comments post", () => {
    test("a dry run lists the steps and the command that would post them, and posts nothing", async () => {
        const { fake } = reviewFake(99);
        const file = join(dir, "j99.md");
        writeFileSync(file, filled(RECEIVE_FILE, 99));

        const ran = await run(fake, ...POST_BASE, "99", "--receive", "--file", file, "--do", "T01", ...TARGET);

        expect(ran.stdout).toContain("T01  reply+resolve thread a1b2c3d4 at src/a.ts:3");
        expect(ran.stdout).toContain(
            `Dry run, nothing posted. Post with: tools gitlab pr 99 comments post --receive --file ${file} --do T01 --apply`
        );
        expect(fake.writes()).toEqual([]);
    });

    test("--apply creates the reply draft, reads it back, and a rerun skips the step it already posted", async () => {
        const { fake, drafts } = reviewFake(99);
        const file = join(dir, "j99.md");
        writeFileSync(file, filled(RECEIVE_FILE, 99));

        const ran = await run(
            fake,
            ...POST_BASE,
            "99",
            "--receive",
            "--file",
            file,
            "--do",
            "T01",
            "--apply",
            ...TARGET
        );

        expect(fake.writes().map((w) => [w.method, w.body])).toEqual([
            [
                "POST",
                {
                    note: "@carol Fixed in the next commit.",
                    in_reply_to_discussion_id: THREAD,
                    resolve_discussion: true,
                },
            ],
        ]);
        expect(drafts.map((d) => d.note)).toContain("@carol Fixed in the next commit.");
        expect(ran.stdout).toContain("✅ 1 step(s) posted as drafts and read back on !99.");

        const again = await run(
            fake,
            ...POST_BASE,
            "99",
            "--receive",
            "--file",
            file,
            "--do",
            "T01",
            "--apply",
            ...TARGET
        );

        expect(fake.writes()).toHaveLength(1);
        expect(again.stdout).toMatch(/\(already posted .*, skipped\)/);
        expect(again.stdout).toContain("✅ 0 step(s) posted as drafts and read back on !99.");
    });

    test("a give file rewords my draft in place and anchors a new finding to its diff line", async () => {
        const { fake, drafts } = reviewFake(100);
        const file = join(dir, "j100.md");
        writeFileSync(file, filled(GIVE_FILE, 100));

        const ran = await run(
            fake,
            ...POST_BASE,
            "100",
            "--give",
            "--file",
            file,
            "--do",
            "D01,N01",
            "--apply",
            ...TARGET
        );

        expect(ran.stdout).toContain("D01");
        expect(ran.stdout).toContain("✅ 2 step(s) posted as drafts and read back on !100.");
        expect(drafts.map((d) => d.note)).toEqual(["Reworded text", "Consider a clearer name."]);
        expect(drafts[1]?.position).toMatchObject({ new_path: "src/a.ts", new_line: 2, position_type: "text" });
        expect(fake.writes().map((w) => w.method)).toEqual(["PUT", "POST"]);
    });

    test("it names what to post, refuses an unknown item and a file with errors before posting anything", async () => {
        const { fake } = reviewFake(101);
        const file = join(dir, "j101.md");
        writeFileSync(file, filled(RECEIVE_FILE, 101));

        await expect(run(fake, ...POST_BASE, "101", "--receive", "--file", file, ...TARGET)).rejects.toThrow(
            "Name what to post: --do T01,N01 (each item's Action) and/or --answers D05"
        );
        await expect(
            run(fake, ...POST_BASE, "101", "--receive", "--file", join(dir, "none.md"), "--do", "T01", ...TARGET)
        ).rejects.toThrow("does not exist; write it with `");

        const unknown = await run(
            fake,
            ...POST_BASE,
            "101",
            "--receive",
            "--file",
            file,
            "--do",
            "T99",
            "--apply",
            ...TARGET
        );

        expect(unknown.stdout).toContain("✗  T99: ");
        expect(unknown.stdout).toContain("Nothing was posted. Fix the file and run `");
        expect(process.exitCode).toBe(1);
        expect(fake.writes()).toEqual([]);
    });

    test("a refused draft stops the run, tells the user to rerun after the fix, and keeps the ledger of what landed", async () => {
        const { fake } = reviewFake(102);
        fake.on("POST", `${PROJECT_API}/merge_requests/102/draft_notes`, status(422, { message: "taken" }));
        const file = join(dir, "j102.md");
        writeFileSync(file, filled(RECEIVE_FILE, 102));

        const ran = await run(
            fake,
            ...POST_BASE,
            "102",
            "--receive",
            "--file",
            file,
            "--do",
            "T01",
            "--apply",
            ...TARGET
        );

        expect(ran.stdout).toContain("⛔ T01: 422 ");
        expect(ran.stdout).toContain(
            "Stopped; the steps before it were posted. Run the same command again after the fix"
        );
        expect(process.exitCode).toBe(1);
    });

    test("a draft that GitLab stores differently from the step is reported as a read-back mismatch", async () => {
        const { fake } = reviewFake(103);
        let created = false;
        fake.get(`${PROJECT_API}/merge_requests/103/draft_notes`, () =>
            created ? [{ id: 905, note: "Something else entirely", discussion_id: THREAD }] : []
        );
        fake.on("POST", `${PROJECT_API}/merge_requests/103/draft_notes`, () => {
            created = true;

            return { id: 905, discussion_id: THREAD };
        });
        const file = join(dir, "j103.md");
        writeFileSync(file, filled(RECEIVE_FILE, 103));

        const ran = await run(
            fake,
            ...POST_BASE,
            "103",
            "--receive",
            "--file",
            file,
            "--do",
            "T01",
            "--apply",
            ...TARGET
        );

        expect(ran.stdout).toContain("⛔ read back:\n  T01: ");
        expect(ran.stdout).toContain("a re-run reads them back again and does not post them twice.");
        expect(process.exitCode).toBe(1);
    });
});

describe("review gaps: uploads, refusals and warnings", () => {
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    function replyFake(): FakeGitLab {
        const fake = threadFake(7);
        fake.get(`${PROJECT_API}/merge_requests/7/draft_notes`, []);

        return fake;
    }

    test("a reply body file with a local image uploads it first and sends the uploaded URL", async () => {
        const fake = replyFake();
        fake.on("POST", `${PROJECT_API}/uploads`, { url: "/uploads/abc123/shot.png" });
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, { id: 604, discussion_id: THREAD });
        writeFileSync(join(dir, "shot.png"), PNG);
        const file = join(dir, "reply.md");
        writeFileSync(file, "See ![the popup](shot.png) now.\n");

        const ran = await run(fake, "comments", "reply", "7", THREAD, "--body-file", file, ...TARGET);

        expect(ran.stdout).toContain(`📎 uploaded ${join(dir, "shot.png")} → /uploads/abc123/shot.png`);
        expect(fake.writes().map((w) => w.path)).toEqual([
            `${PROJECT_API}/uploads`,
            `${PROJECT_API}/merge_requests/7/draft_notes`,
        ]);
        expect(fake.writes()[1]?.body).toMatchObject({ note: "See ![the popup](/uploads/abc123/shot.png) now.\n" });
    });

    test("a missing image uploads nothing and a refused immediate reply is an error", async () => {
        const fake = replyFake();
        const file = join(dir, "reply.md");
        writeFileSync(file, "![gone](missing.png)\n");

        await expect(run(fake, "comments", "reply", "7", THREAD, "--body-file", file, ...TARGET)).rejects.toThrow(
            "Nothing was uploaded: image file not found: "
        );
        expect(fake.writes()).toEqual([]);

        fake.on("POST", `${PROJECT_API}/merge_requests/7/discussions/${THREAD}/notes`, status(403, { message: "no" }));

        await expect(
            run(fake, "comments", "reply", "7", THREAD, "--body", "Done.", "--now", ...TARGET)
        ).rejects.toThrow("403 ");
    });

    test("an anchored draft that GitLab refuses is an error carrying the status", async () => {
        const fake = baseRoutes(new FakeGitLab());
        mrRoutes(fake, 7, {
            mr: { diff_refs: { base_sha: "b".repeat(40), start_sha: "s".repeat(40), head_sha: "h".repeat(40) } },
        });
        fake.get(`${PROJECT_API}/merge_requests/7/diffs`, [{ old_path: "src/a.ts", new_path: "src/a.ts", diff: DIFF }]);
        fake.on("POST", `${PROJECT_API}/merge_requests/7/draft_notes`, status(422, { message: "bad position" }));

        await expect(
            run(fake, "comments", "add", "7", "--file", "src/a.ts", "--line", "2", "--body", "x", ...TARGET)
        ).rejects.toThrow("422 ");
    });

    test("publishing a new thread whose thread GitLab has not listed yet warns that --answers cannot reach it", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.get(`${PROJECT_API}/merge_requests/8/draft_notes`, [
            { id: 811, note: "Line note", position: { new_path: "src/a.ts", new_line: 3 } },
        ]);
        fake.get(`${PROJECT_API}/merge_requests/8/discussions`, []);
        fake.on("POST", `${PROJECT_API}/merge_requests/8/draft_notes/bulk_publish`, status(204));

        const ran = await run(fake, "comments", "publish", "8", "--apply", ...TARGET);

        expect(ran.stdout).toContain("✅ published 1 draft(s) on !8");
        expect(ran.stdout).toMatch(/⚠ {2}no thread found yet for D\d+; `--answers` cannot reach them/);
    });

    test("post shows the warning for an item left unjudged and the reason an item is skipped", async () => {
        const { fake } = reviewFake(104);
        const file = join(dir, "j104.md");
        const withoutY = filled(GIVE_FILE, 104).replace(
            "- Verdict on the comment: Answered by the code [80%]",
            "- Verdict on the comment: "
        );
        writeFileSync(file, withoutY);

        const ran = await run(fake, ...POST_BASE, "104", "--give", "--file", file, "--do", "D01,N01", ...TARGET);

        expect(ran.stderr).toMatch(/⚠ {2}Y01 .*not judged/);
        expect(ran.stdout).toContain('D01  reword        draft 900 at src/a.ts:2  "Reworded text"');

        writeFileSync(file, filled(GIVE_FILE, 104));
        const skipped = await run(fake, ...POST_BASE, "104", "--give", "--file", file, "--do", "Y01", ...TARGET);

        expect(skipped.stdout).toContain("Y01  skipped       Action none");
    });

    test("a step that landed but failed its read-back is read back again on the next run and not posted twice", async () => {
        const { fake } = reviewFake(105);
        let shown = "Something else entirely";
        fake.get(`${PROJECT_API}/merge_requests/105/draft_notes`, () => [
            ...(fake.calls("POST", `${PROJECT_API}/merge_requests/105/draft_notes`).length
                ? [{ id: 905, note: shown, discussion_id: THREAD }]
                : []),
        ]);
        fake.on("POST", `${PROJECT_API}/merge_requests/105/draft_notes`, { id: 905, discussion_id: THREAD });
        const file = join(dir, "j105.md");
        writeFileSync(file, filled(RECEIVE_FILE, 105));
        const args = [...POST_BASE, "105", "--receive", "--file", file, "--do", "T01", "--apply", ...TARGET];

        const first = await run(fake, ...args);

        expect(first.stdout).toContain("⛔ read back:");
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
        shown = "@carol Fixed in the next commit.";

        const second = await run(fake, ...args);

        expect(second.stdout).toMatch(/not read back yet: read back again, not posted again/);
        expect(second.stdout).toContain("✅ 1 step(s) posted as drafts and read back on !105.");
        expect(fake.writes()).toHaveLength(1);
    });
});

describe("runStep", () => {
    const api = { host: FAKE_HOST, token: FAKE_TOKEN, project: FAKE_PROJECT };
    const context = { drafts: [], files: [] };
    const top = { path: "", line: 0, side: "new" as const, text: null, top: true };
    const step = (
        fake: FakeGitLab,
        post: Parameters<typeof runStep>[2],
        known: Parameters<typeof runStep>[3] = context
    ) => scoped(fake, () => runStep(api, "110", post, known)).then(({ value }) => value);

    test("delete removes the draft, and a refused delete is a failure with the status", async () => {
        const fake = baseRoutes(new FakeGitLab());
        const drafts = draftServer(fake, 110, [{ id: 900, note: "old" }]);
        const deletion = { id: "D02", kind: "delete" as const, draftId: 900, where: "top-level" };

        const removed = await step(fake, deletion);

        expect(removed).toEqual({ ok: true, action: "updated", draftId: 900 });
        expect(drafts).toEqual([]);

        const broken = baseRoutes(new FakeGitLab());
        broken.on("DELETE", `${PROJECT_API}/merge_requests/110/draft_notes/900`, status(403, { message: "no" }));

        const result = await step(broken, deletion);

        expect(result).toMatchObject({ ok: false, action: "failed" });
        expect(result.error).toContain("403");
    });

    test("a comment that reuses an identical pending draft posts nothing, and one the diff cannot hold fails", async () => {
        const fake = baseRoutes(new FakeGitLab());

        const reused = await step(
            fake,
            { id: "N01", kind: "comment", anchor: top, body: "Same text", where: "top-level" },
            {
                drafts: [{ id: 77, discussionId: null, path: null, line: null, side: null, note: "Same text" }],
                files: [],
            }
        );
        const lost = await step(fake, {
            id: "N02",
            kind: "comment",
            anchor: { path: "src/zzz.ts", line: 3, side: "new", text: null, top: false },
            body: "Nowhere",
            where: "src/zzz.ts:3",
        });

        expect(reused).toEqual({ ok: true, action: "updated", draftId: 77, discussionId: null });
        expect(lost).toEqual({ ok: false, action: "failed", error: "src/zzz.ts is not in the MR diff" });
        expect(fake.requests).toEqual([]);
    });

    test("a move whose new draft cannot be created leaves the old draft where it is", async () => {
        const fake = baseRoutes(new FakeGitLab());
        fake.on("POST", `${PROJECT_API}/merge_requests/110/draft_notes`, status(422, { message: "bad" }));

        const result = await step(fake, {
            id: "D01",
            kind: "move",
            draftId: 900,
            anchor: top,
            body: "Moved.",
            where: "top-level",
        });

        expect(result).toMatchObject({ ok: false, action: "failed" });
        expect(fake.writes().map((w) => w.method)).toEqual(["POST"]);
    });

    test("a move that cannot delete the old draft after a fresh create removes the new one again", async () => {
        const fake = baseRoutes(new FakeGitLab());
        const drafts = draftServer(fake, 110, [{ id: 900, note: "old" }]);
        fake.on("DELETE", `${PROJECT_API}/merge_requests/110/draft_notes/900`, status(403, { message: "no" }));

        const result = await step(fake, {
            id: "D01",
            kind: "move",
            draftId: 900,
            anchor: top,
            body: "Moved.",
            where: "top-level",
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("the new draft 901 was removed again, so nothing changed");
        expect(drafts.map((d) => d.id)).toEqual([900]);
    });
});
