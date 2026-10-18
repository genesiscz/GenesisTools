import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStaleBranches } from "@app/gitlab/commands/stale-branches";
import { appendLedger, readLedger } from "@app/gitlab/lib/comment-batch";
import { mergeConfig, NEUTRAL_CONFIG } from "@app/gitlab/lib/config";
import {
    adoReads,
    adoWorkItems,
    BOB,
    baseRoutes,
    createStaleRepo,
    FAKE_HOST,
    FAKE_PROJECT,
    FAKE_TOKEN,
    FakeGitLab,
    fakeConfig,
    installFakeAdo,
    installFakeConfig,
    mrRoutes,
    PROJECT_API,
    rawAdo,
    rawMr,
    rawNote,
    reviewedMrFixture,
    type StaleRepo,
    scoped,
    staleMrFixture,
    staleReportFixture,
    startFakeRuntime,
    status,
    stopFakeRuntime,
} from "@app/gitlab/lib/fake-gitlab";
import { appendLabelLedger, readLabelLedger } from "@app/gitlab/lib/label-batch";
import type { AdoFacts, StaleMr, StaleReport } from "@app/gitlab/lib/stale-branches";
import type { StaleManifest } from "@app/gitlab/lib/stale-manifest";
import type { AdoWorkItem } from "@app/gitlab/lib/work-items";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";

interface Ran {
    stdout: string;
    stderr: string;
}

let dir = "";
let repo: StaleRepo;

beforeAll(async () => {
    repo = createStaleRepo();
    await installFakeAdo();
    await installFakeConfig();
    startFakeRuntime();
});

afterAll(() => {
    stopFakeRuntime();
});

beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gt-gitlab-stale-cmd-")));
    env.testing.set("GITLAB_TOKEN", FAKE_TOKEN);
    fakeConfig.current = mergeConfig({}, NEUTRAL_CONFIG);
});

afterEach(() => {
    env.testing.unset("GITLAB_TOKEN");
    adoWorkItems.clear();
    adoReads.length = 0;
    process.exitCode = 0;
});

/** Runs `gitlab pr stale <args>` against the fake GitLab and returns what it printed to stdout and stderr. */
async function run(fake: FakeGitLab, ...args: string[]): Promise<Ran> {
    const { stdout, stderr } = await scoped(fake, async () => {
        const program = new Command();
        program.exitOverride();
        registerStaleBranches(program);
        await program.parseAsync(["stale", ...args], { from: "user" });
    });

    return { stdout, stderr };
}

function writeReport(report: StaleReport, name = "sweep.json"): string {
    const path = join(dir, name);
    writeFileSync(path, `${SafeJSON.stringify(report, null, 2)}\n`);

    return path;
}

function readReport(path: string): StaleReport {
    return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as StaleReport;
}

function newFake(): FakeGitLab {
    return baseRoutes(new FakeGitLab());
}

describe("stale merge, mark-review and render", () => {
    const filled = {
        recommendation: "CLOSE",
        confidence: 90,
        reason: "Dead since January.",
        adoCommentsSummary: null,
        draftComment: "Closing soon.",
        labels: [{ type: "add", label: "Stale" }],
        evidence: ["git log -1"],
    };

    test("merge copies the review of a slice file into the sweep by iid and names the MRs still unfilled", async () => {
        const path = writeReport(staleReportFixture([staleMrFixture(1), staleMrFixture(2)]));
        const slice = join(dir, "slice.json");
        writeFileSync(slice, SafeJSON.stringify({ "1": filled }));

        const ran = await run(newFake(), "merge", path, "--review", slice);

        expect(ran.stderr).toBe(`1 reviews merged into ${path}; still unfilled: !2.\n`);
        const saved = readReport(path);
        expect(saved.mrs[0]?.review).toMatchObject({
            recommendation: "CLOSE",
            confidence: 90,
            labels: [{ type: "add", label: "Stale" }],
            evidence: ["git log -1"],
        });
        expect(saved.mrs[1]?.review.recommendation).toBeNull();
    });

    test("merge --out writes a new file, leaves the sweep alone, and lets a later slice win", async () => {
        const path = writeReport(staleReportFixture([staleMrFixture(1)]));
        const first = join(dir, "first.json");
        const second = join(dir, "second.json");
        const merged = join(dir, "merged.json");
        writeFileSync(first, SafeJSON.stringify({ "1": filled }));
        writeFileSync(second, SafeJSON.stringify({ "1": { ...filled, recommendation: "KEEP", confidence: 40 } }));

        const ran = await run(newFake(), "merge", path, "--review", first, "--review", second, "--out", merged);

        expect(ran.stderr).toBe(`1 reviews merged into ${merged}.\n`);
        expect(readReport(merged).mrs[0]?.review).toMatchObject({ recommendation: "KEEP", confidence: 40 });
        expect(readReport(path).mrs[0]?.review.recommendation).toBeNull();
    });

    test("mark-review flags a young MR, reports the ones already flagged, and refuses an unknown iid", async () => {
        const young = staleMrFixture(2, {}, { ageDays: 5, needsReview: false });
        const path = writeReport(staleReportFixture([staleMrFixture(1), young]));

        const ran = await run(newFake(), "mark-review", path, "--iid", "1", "--iid", "2");

        expect(ran.stderr).toContain("1 MR(s) flagged for review (1 already were).");
        expect(readReport(path).mrs.map((m) => m.needsReview)).toEqual([true, true]);
        await expect(run(newFake(), "mark-review", path, "--iid", "9")).rejects.toThrow("Not in this report: !9");
        await expect(run(newFake(), "mark-review", path, "--iid", "1x")).rejects.toThrow(
            '--iid takes exactly one MR iid, got "1x"'
        );
    });

    test("render prints the note to stdout, with the title and work-item tags from the flags", async () => {
        const path = writeReport(staleReportFixture([reviewedMrFixture(1)]));

        const ran = await run(newFake(), "render", path, "--title", "Sweep of March", "--ado", "4242", "--ado", "77");

        expect(ran.stdout).toContain("title: Sweep of March");
        expect(ran.stdout).toContain("ado: [4242, 77]");
        expect(ran.stdout).toContain("**ASK AUTHOR** (80 % confidence)");
        expect(ran.stdout).toContain("Is !1 still needed?");
    });

    test("render refuses reviewed MRs with empty review fields unless asked to render them anyway", async () => {
        const path = writeReport(staleReportFixture([staleMrFixture(1), reviewedMrFixture(2)]));

        await expect(run(newFake(), "render", path)).rejects.toThrow(
            "1 reviewed MRs have empty review fields: !1. Fill them or pass --allow-unfilled."
        );

        const ran = await run(newFake(), "render", path, "--allow-unfilled");

        expect(ran.stdout).toContain("UNFILLED");
    });

    test("render --out writes the note, refuses to overwrite it, and overwrites with --force", async () => {
        const path = writeReport(staleReportFixture([reviewedMrFixture(1)]));
        const note = join(dir, "note.md");

        const ran = await run(newFake(), "render", path, "--out", note);

        expect(ran.stderr).toBe(`Wrote ${note} (0 unfilled).\n`);
        expect(readFileSync(note, "utf8")).toContain("# Open merge requests in acme/widgets");
        await expect(run(newFake(), "render", path, "--out", note)).rejects.toThrow(`${note} exists.`);

        writeFileSync(note, "old");
        await run(newFake(), "render", path, "--out", note, "--force");

        expect(readFileSync(note, "utf8")).not.toBe("old");
    });
});

describe("stale preflight", () => {
    test("collects every open MR into a sweep JSON that records the host and project it read", async () => {
        const young = new Date(Date.now() - 5 * 86_400_000).toISOString();
        const list = [rawMr(1, { created_at: "2026-01-01T00:00:00Z" }), rawMr(2, { author: BOB, created_at: young })];
        const fake = newFake();
        fake.get(`${PROJECT_API}/merge_requests`, () => list);
        mrRoutes(fake, 1);
        mrRoutes(fake, 2);
        fake.get("/users/11/events", []);
        fake.get("/users/12/events", []);
        const sweep = join(dir, "sweep.json");

        const ran = await run(
            fake,
            "preflight",
            "--out",
            sweep,
            "--cwd",
            repo.clone,
            "--host",
            FAKE_HOST,
            "--project",
            FAKE_PROJECT,
            "--review-min-age",
            "30"
        );

        expect(ran.stderr).toContain("2 open MRs in acme/widgets");
        expect(ran.stderr).toContain(`2 MRs written to ${sweep}; 1 need a review pass; 0 failures recorded.`);
        const saved = readReport(sweep);
        expect(saved).toMatchObject({ host: FAKE_HOST, project: FAKE_PROJECT, repoRoot: repo.clone });
        expect(saved.reviewMinAgeDays).toBe(30);
        expect(saved.mrs.map((m) => [m.iid, m.needsReview])).toEqual([
            [1, true],
            [2, false],
        ]);
        expect(saved.mrs[0]?.git.behind).toBe(1);
    });

    test("a day count that is not a whole number stops before any request", async () => {
        const fake = newFake();

        await expect(run(fake, "preflight", "--out", join(dir, "x.json"), "--review-min-age", "soon")).rejects.toThrow(
            '--review-min-age must be a whole number of days (0 or more), got "soon"'
        );
        await expect(run(fake, "preflight", "--out", join(dir, "x.json"), "--inactive-after", "-3")).rejects.toThrow(
            "--inactive-after must be a whole number of days"
        );
        expect(fake.requests).toEqual([]);
    });
});

describe("stale recheck and shipped-detail", () => {
    const sweepWithRepo = (): string =>
        writeReport(
            staleReportFixture(
                [
                    reviewedMrFixture(1, { recommendation: "CLOSE" }, { shipped: shippedFixture("present") }),
                    reviewedMrFixture(2, { recommendation: "KEEP" }, { labels: ["NOT merged into main"] }),
                    reviewedMrFixture(3, { recommendation: "ASK AUTHOR" }),
                ],
                { repoRoot: repo.clone }
            )
        );

    function shippedFixture(verdict: "present" | "absent") {
        return {
            mergeBase: "abc",
            filesChanged: 1,
            insertions: 2,
            deletions: 0,
            refs: [{ ref: "origin/main", matched: 2, sampled: 2, verdict }],
            files: [],
            verdict,
            note: null,
        };
    }

    function liveRoutes(): FakeGitLab {
        const fake = newFake();
        mrRoutes(fake, 1);
        mrRoutes(fake, 2, { mr: { labels: ["NOT merged into main"], sha: "deadbeef0000" } });

        return fake;
    }

    test("recheck re-runs the content check and says what moved on each MR since the sweep", async () => {
        const path = sweepWithRepo();

        const ran = await run(liveRoutes(), "recheck", path);

        const rows = ran.stdout.split("\n").filter((line) => line.startsWith("| !"));
        expect(rows[0]).toBe("| !1 | CLOSE (80 %) | present -> absent | no | CLOSE with content absent everywhere |");
        expect(rows[1]).toBe(
            "| !2 | KEEP (80 %) | n/a -> present | new commits on the branch (00000002 -> deadbeef) | label contradicted |"
        );
        expect(rows[2]).toStartWith("| !3 | ASK AUTHOR (80 %) | n/a -> absent | check failed: ");
        expect(ran.stderr).toContain("3 rechecked against origin/main; 2 flagged. Facts refreshed in");
        const saved = readReport(path);
        expect(saved.mrs[0]?.shipped?.verdict).toBe("absent");
        expect(saved.mrs[1]?.labelConflicts).toHaveLength(1);
        expect(saved.mrs[1]?.review.recommendation).toBe("KEEP");
    });

    test("recheck narrows to one recommendation or one MR and refuses a filter nothing matches", async () => {
        const path = sweepWithRepo();

        const ran = await run(liveRoutes(), "recheck", path, "--recommendation", "KEEP");

        expect(ran.stderr).toContain("1 rechecked against origin/main");
        await expect(run(liveRoutes(), "recheck", path, "--recommendation", "MAYBE")).rejects.toThrow(
            "--recommendation must be one of CLOSE, ASK AUTHOR, REBASE-NEEDED, KEEP"
        );
        await expect(run(liveRoutes(), "recheck", path, "--iid", "99")).rejects.toThrow(
            "!99 has no filled review in this report."
        );
        await expect(run(liveRoutes(), "recheck", path, "--iid", "1", "--recommendation", "KEEP")).rejects.toThrow(
            "!1 has no filled review in this report."
        );
    });

    test("recheck stops when the checkout cannot fetch origin", async () => {
        // A repository of its own with no origin, so git can never walk up into a checkout that holds the temp root.
        expect(Bun.spawnSync(["git", "init", "-q", dir], { env: process.env }).exitCode).toBe(0);
        const path = writeReport(staleReportFixture([reviewedMrFixture(1)], { repoRoot: dir }));

        await expect(run(liveRoutes(), "recheck", path)).rejects.toThrow("git fetch origin --prune:");
    });

    test("shipped-detail checks every added line of one MR and writes the exhaustive result into the sweep", async () => {
        const path = sweepWithRepo();

        const ran = await run(newFake(), "shipped-detail", path, "--iid", "1", "--show", "1");

        expect(ran.stdout).toContain(
            "!1 MR 1\n1 files changed, +2 -0; 1 files with significant added lines, 2 significant lines checked."
        );
        expect(ran.stdout).toContain("| origin/main | 0/2 (0 %) | absent |");
        expect(ran.stdout).toContain("Files with lines missing on origin/main: 1 of 1\n- src/b.ts: 2/2 missing");
        expect(ran.stdout).toContain(
            "Missing lines (2, first 1):\n  src/b.ts: export const fromOne = buildFromOne(1);"
        );
        const saved = readReport(path);
        expect(saved.mrs[0]?.shipped).toMatchObject({ exhaustive: true, verdict: "absent", filesChecked: 1 });
    });

    test("shipped-detail names an MR the sweep does not hold", async () => {
        const path = sweepWithRepo();

        await expect(run(newFake(), "shipped-detail", path, "--iid", "99")).rejects.toThrow(
            "!99 is not in this report"
        );
        await expect(run(newFake(), "shipped-detail", path, "--iid", "x")).rejects.toThrow(
            "--iid takes exactly one MR iid"
        );
    });

    test("a sweep without the environment refs gets them from the project's default branch", async () => {
        const report = staleReportFixture([reviewedMrFixture(2)], { repoRoot: repo.clone });
        const bare = { ...report, shippedRefs: [], defaultBranch: undefined } as unknown as StaleReport;
        const path = writeReport(bare);
        const fake = newFake();

        const ran = await run(fake, "shipped-detail", path, "--iid", "2");

        expect(ran.stdout).toContain("| origin/main | 1/1 (100 %) | present |");
        expect(fake.calls("GET", PROJECT_API)).toHaveLength(1);
        expect(readReport(path).shippedRoles).toEqual({ uat: null, production: "origin/main", test: null });
    });
});

describe("stale side-comment", () => {
    const flags = ["--key", "welcome", "--template", "Hi {author}, {iid} {title}"];

    function sweep(mrs = [reviewedMrFixture(1), reviewedMrFixture(2, {}, { author: BOB })]): string {
        return writeReport(staleReportFixture(mrs));
    }

    test("a dry run names, per MR, whether the text would create a note or append to ours, and sends nothing", async () => {
        const path = sweep([
            reviewedMrFixture(1),
            reviewedMrFixture(
                2,
                { postedNoteUrl: `${FAKE_HOST}/${FAKE_PROJECT}/-/merge_requests/2#note_901` },
                { author: BOB }
            ),
        ]);
        const fake = newFake();
        mrRoutes(fake, 1);
        mrRoutes(fake, 2);
        fake.get(`${PROJECT_API}/merge_requests/2/notes/901`, {
            id: 901,
            body: "Existing",
            author: { username: "me" },
        });
        const before = readFileSync(path, "utf8");

        const ran = await run(fake, "side-comment", path, ...flags, "--iid", "1", "--iid", "2", "--dry-run");

        expect(ran.stdout).toContain("| !1 | alice | dry run, would create |");
        expect(ran.stdout).toContain("| !2 | bob | dry run, would append to note 901 |");
        expect(ran.stderr).toContain("2 selected, 0 failed (dry run, nothing sent).");
        expect(fake.writes()).toEqual([]);
        expect(readFileSync(path, "utf8")).toBe(before);
    });

    test("it creates a note on an MR we never wrote to, appends to our note elsewhere, and a rerun sends nothing", async () => {
        const path = sweep([
            reviewedMrFixture(1),
            reviewedMrFixture(
                2,
                { postedNoteUrl: `${FAKE_HOST}/${FAKE_PROJECT}/-/merge_requests/2#note_901` },
                { author: BOB }
            ),
        ]);
        const fake = newFake();
        mrRoutes(fake, 1);
        mrRoutes(fake, 2);
        fake.get(`${PROJECT_API}/merge_requests/2/notes/901`, {
            id: 901,
            body: "Existing\n",
            author: { username: "me" },
        });
        fake.on("POST", `${PROJECT_API}/merge_requests/1/notes`, { id: 701 });
        fake.on("PUT", `${PROJECT_API}/merge_requests/2/notes/901`, {});

        const ran = await run(fake, "side-comment", path, ...flags, "--iid", "1", "--iid", "2");

        expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
            ["POST", `${PROJECT_API}/merge_requests/1/notes`, { body: "Hi @alice, !1 MR 1" }],
            ["PUT", `${PROJECT_API}/merge_requests/2/notes/901`, { body: "Existing\n\nHi @bob, !2 MR 2" }],
        ]);
        expect(ran.stdout).toContain(
            `| !1 | alice | created: ${FAKE_HOST}/${FAKE_PROJECT}/-/merge_requests/1#note_701 |`
        );
        expect(ran.stdout).toContain(
            `| !2 | bob | appended: ${FAKE_HOST}/${FAKE_PROJECT}/-/merge_requests/2#note_901 |`
        );
        const saved = readReport(path);
        expect(saved.mrs[0]?.sideComments?.[0]).toMatchObject({ key: "welcome", body: "Hi @alice, !1 MR 1" });
        expect(saved.mrs[0]?.sideComments?.[0]?.postedNoteUrl).toEndWith("#note_701");
        expect(
            readLedger().some((e) => e.pr === "1" && e.comment_id === 701 && e.message === "Hi @alice, !1 MR 1")
        ).toBe(true);
        expect(readLedger().some((e) => e.pr === "2" && e.comment_id === 901)).toBe(false);

        const again = await run(fake, "side-comment", path, ...flags, "--iid", "1", "--iid", "2");

        expect(again.stderr).toContain("No MR matches (or every match already carries this key).");
        expect(fake.writes()).toHaveLength(2);
    });

    test("--draft turns a new note into a private draft note, and a pending review draft takes the text itself", async () => {
        const path = sweep([reviewedMrFixture(1), reviewedMrFixture(2, { draftNoteId: 55 }, { author: BOB })]);
        const fake = newFake();
        mrRoutes(fake, 1);
        mrRoutes(fake, 2);
        fake.on("POST", `${PROJECT_API}/merge_requests/1/draft_notes`, { id: 66 });
        fake.get(`${PROJECT_API}/merge_requests/2/draft_notes`, [{ id: 55, note: "Pending review text\n" }]);
        fake.on("PUT", `${PROJECT_API}/merge_requests/2/draft_notes/55`, {});

        const ran = await run(fake, "side-comment", path, ...flags, "--draft", "--iid", "1", "--iid", "2");

        expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
            ["POST", `${PROJECT_API}/merge_requests/1/draft_notes`, { note: "Hi @alice, !1 MR 1" }],
            [
                "PUT",
                `${PROJECT_API}/merge_requests/2/draft_notes/55`,
                { note: "Pending review text\n\nHi @bob, !2 MR 2" },
            ],
        ]);
        expect(ran.stdout).toContain("| !1 | alice | draft note 66 (private until published) |");
        expect(ran.stdout).toContain("| !2 | bob | appended to pending draft 55 |");
        const saved = readReport(path);
        expect(saved.mrs[0]?.sideComments?.[0]).toMatchObject({ key: "welcome", draftNoteId: 66 });
        expect(saved.mrs[1]?.sideComments?.[0]).toMatchObject({ key: "welcome", draftNoteId: 55 });
    });

    test("an MR that is no longer open is skipped, and a refused write is a FAIL row with exit code 1", async () => {
        const path = sweep();
        const fake = newFake();
        mrRoutes(fake, 1, { mr: { state: "merged" } });
        mrRoutes(fake, 2);
        fake.on("POST", `${PROJECT_API}/merge_requests/2/notes`, status(403, { message: "forbidden" }));

        const ran = await run(fake, "side-comment", path, ...flags, "--iid", "1", "--iid", "2");

        expect(ran.stdout).toContain("| !1 | alice | skipped, MR is merged |");
        expect(ran.stdout).toContain("| !2 | bob | FAIL 403 ");
        expect(ran.stderr).toContain("2 selected, 1 failed.");
        expect(process.exitCode).toBe(1);
        expect(readReport(path).mrs[1]?.sideComments).toBeUndefined();
    });

    test("selection leaves out closed MRs, skipped authors and MRs that carry the key, and --iid must be one number", async () => {
        const path = sweep([
            reviewedMrFixture(1, { closedAt: "2026-03-02T00:00:00Z" }),
            reviewedMrFixture(2, {}, { author: BOB }),
            reviewedMrFixture(3, {}, { sideComments: [{ key: "welcome", body: "x" }] }),
        ]);
        const fake = newFake();

        const ran = await run(
            fake,
            "side-comment",
            path,
            ...flags,
            "--iid",
            "1",
            "--iid",
            "2",
            "--iid",
            "3",
            "--skip-author",
            "bob"
        );

        expect(ran.stderr).toContain("No MR matches (or every match already carries this key).");
        await expect(run(fake, "side-comment", path, ...flags, "--iid", "1,2")).rejects.toThrow(
            '--iid takes exactly one MR iid, got "1,2"'
        );
        expect(fake.requests).toEqual([]);
    });

    test("--missing-work-item selects the MRs whose title and description name no work item, and needs a pattern", async () => {
        const path = sweep([
            reviewedMrFixture(1, {}, { title: "AB#12 Fix the popup" }),
            reviewedMrFixture(2, {}, { title: "Fix the other popup" }),
        ]);
        const fake = newFake();
        mrRoutes(fake, 2, { mr: { state: "closed" } });

        await expect(run(fake, "side-comment", path, ...flags, "--missing-work-item")).rejects.toThrow(
            "--missing-work-item needs workItems.idPattern in"
        );

        fakeConfig.current = mergeConfig({ workItems: { idPattern: "AB#(\\d+)" } }, NEUTRAL_CONFIG);
        const ran = await run(fake, "side-comment", path, ...flags, "--no-ado");

        expect(ran.stdout).toContain("| !2 | alice | skipped, MR is closed |");
        expect(ran.stdout).not.toContain("| !1 |");
    });
});

const MR_URL = `${FAKE_HOST}/${FAKE_PROJECT}/-/merge_requests`;

function closedBugAdo(id = 600, state = "Closed"): AdoFacts {
    const item: AdoWorkItem = {
        id,
        title: "Popup bug",
        type: "Bug",
        state,
        url: `https://ado.example.com/${id}`,
        assignee: null,
        tags: [],
        created: "2026-01-01T00:00:00Z",
        changed: "2026-02-01T00:00:00Z",
        changedBy: "Dana Example",
        description: "",
        parentId: null,
        comments: [],
        lastCommentDate: null,
        closedDate: "2026-02-01T00:00:00Z",
        closedBy: "Dana Example",
        reason: null,
        environment: null,
        mergeRequestUrl: null,
    };

    return { id, source: "title", item, effective: item, error: null, parentError: null };
}

describe("stale closed-bug", () => {
    const mrs = () => [
        reviewedMrFixture(1, {}, { ado: closedBugAdo(600) }),
        reviewedMrFixture(2, {}, { ado: closedBugAdo(601) }),
        reviewedMrFixture(3, {}, { ado: closedBugAdo(602) }),
        reviewedMrFixture(
            4,
            {},
            {
                ado: closedBugAdo(603),
                git: { ...staleMrFixture(4).git, sourceMissing: true, behind: null, ahead: null },
            }
        ),
        reviewedMrFixture(
            5,
            {},
            { sourceBranch: "feature/2", ado: closedBugAdo(604), sideComments: [{ key: "closedBug", body: "sent" }] }
        ),
    ];

    function adoState() {
        adoWorkItems.set(
            600,
            rawAdo(600, {
                type: "Bug",
                state: "Closed",
                title: "Popup bug",
                fields: {
                    "Microsoft.VSTS.Common.ClosedDate": "2026-02-01T00:00:00Z",
                    "Microsoft.VSTS.Common.ClosedBy": { displayName: "Dana Example" },
                },
            })
        );
        adoWorkItems.set(601, rawAdo(601, { type: "Bug", state: "Active" }));
        adoWorkItems.set(604, rawAdo(604, { type: "Bug", state: "Closed" }));
        adoWorkItems.set(603, rawAdo(603, { type: "Bug", state: "Closed" }));
    }

    function fakeWithRoutes(): FakeGitLab {
        const fake = newFake();
        mrRoutes(fake, 1);
        mrRoutes(fake, 5);
        fake.on("POST", `${PROJECT_API}/merge_requests/1/notes`, { id: 710 });

        return fake;
    }

    test("a dry run runs the exhaustive check, prints the text it would send and writes the facts into the sweep", async () => {
        adoState();
        const path = writeReport(staleReportFixture([mrs()[0] as StaleMr], { repoRoot: repo.clone }));
        const fake = fakeWithRoutes();

        const ran = await run(fake, "closed-bug", path, "--dry-run");

        const saved = readReport(path);
        const facts = saved.mrs[0]?.closedBug;
        expect(facts).toMatchObject({ adoId: 600, fix: "nowhere", exhaustive: true });
        expect(saved.mrs[0]?.shipped).toMatchObject({ exhaustive: true, verdict: "absent" });
        expect(ran.stdout).toContain("| MR | Author | Check (exhaustive) | Result |");
        expect(ran.stdout).toContain(
            "| !1 | alice | nowhere; main 0/2; Closed 2026-02-01 by Dana Example | dry run, would create |"
        );
        expect(ran.stdout).toContain(`### !1 MR 1 (create)\n\n${facts?.comment}`);
        expect(ran.stderr).toContain(
            "1 candidate(s), 0 sent, 0 failed (dry run: facts written to the JSON, nothing sent)."
        );
        expect(fake.writes()).toEqual([]);
    });

    test("it sends one note per Closed bug, and reports MRs it skipped, cleared, could not read or already texted", async () => {
        adoState();
        const path = writeReport(staleReportFixture(mrs(), { repoRoot: repo.clone }));
        const fake = fakeWithRoutes();

        const ran = await run(fake, "closed-bug", path);

        const saved = readReport(path);
        expect(fake.writes().map((w) => [w.method, w.path])).toEqual([
            ["POST", `${PROJECT_API}/merge_requests/1/notes`],
        ]);
        expect(fake.writes()[0]?.body).toEqual({ body: saved.mrs[0]?.closedBug?.comment });
        expect(saved.mrs[0]?.sideComments?.[0]).toMatchObject({
            key: "closedBug",
            postedNoteUrl: `${MR_URL}/1#note_710`,
        });
        expect(ran.stdout).toContain("| !1 | alice | nowhere; main 0/2; Closed 2026-02-01 by Dana Example | created: ");
        expect(ran.stdout).toContain("| !2 | alice | ADO Bug 601 is Active now | skipped, closedBug cleared |");
        expect(ran.stdout).toContain(
            "| !3 | alice | ADO 602 unreadable: TF401232: work item 602 does not exist | skipped |"
        );
        expect(ran.stdout).toContain("| !4 | alice | branch missing on origin | skipped |");
        expect(ran.stdout).toMatch(/\| !5 \| alice \| .* \| already carries the closedBug text \|/);
        expect(saved.mrs[1]?.closedBug).toBeNull();
        expect(ran.stderr).toContain(
            "5 candidate(s), 1 sent, 1 failed. Read every touched note back before reporting."
        );
        expect(process.exitCode).toBe(1);
    });

    test("--select keeps only new or only posted MRs, and a bad value or an empty selection says so", async () => {
        adoState();
        const posted = reviewedMrFixture(1, { postedNoteUrl: `${MR_URL}/1#note_9` }, { ado: closedBugAdo(600) });
        const path = writeReport(staleReportFixture([posted], { repoRoot: repo.clone }));
        const fake = fakeWithRoutes();

        const none = await run(fake, "closed-bug", path, "--select", "new");

        expect(none.stderr).toContain("No open MR with a Closed work item of the selected type(s).");
        await expect(run(fake, "closed-bug", path, "--select", "old")).rejects.toThrow(
            '--select takes new, posted or all, got "old"'
        );
        expect(fake.writes()).toEqual([]);

        const dry = await run(fake, "closed-bug", path, "--select", "posted", "--dry-run");

        expect(dry.stderr).toContain("1 candidate(s)");
    });

    test("--iid names an MR without a work item and --draft sends the text as a draft note", async () => {
        adoState();
        const path = writeReport(
            staleReportFixture([reviewedMrFixture(2), reviewedMrFixture(1, {}, { ado: closedBugAdo(600) })], {
                repoRoot: repo.clone,
            })
        );
        const fake = fakeWithRoutes();
        mrRoutes(fake, 2);
        fake.on("POST", `${PROJECT_API}/merge_requests/1/draft_notes`, { id: 77 });

        const ran = await run(fake, "closed-bug", path, "--iid", "2", "--iid", "1", "--draft", "--show");

        expect(ran.stdout).toContain("| !2 | alice | no work-item id | skipped |");
        expect(ran.stdout).toContain("draft note 77 (private until published)");
        expect(ran.stdout).toContain("### !1 MR 1 (draft)");
        expect(readReport(path).mrs[1]?.sideComments?.[0]).toMatchObject({ key: "closedBug", draftNoteId: 77 });
    });
});

describe("stale post", () => {
    const path1 = () => writeReport(staleReportFixture([reviewedMrFixture(1)]));

    test("posts the drafted comment of one MR once nothing moved, and records the note URL and the ledger receipt", async () => {
        const path = path1();
        const fake = newFake();
        mrRoutes(fake, 1);
        fake.on("POST", `${PROJECT_API}/merge_requests/1/notes`, { id: 701 });

        const ran = await run(fake, "post", path, "--iid", "1");

        expect(ran.stderr).toContain(`!1 MR 1\n${MR_URL}/1\n---\nIs !1 still needed?\n---`);
        expect(ran.stderr).toContain("Nothing changed on the MR or its work item since the sweep.");
        expect(ran.stderr).toContain(`Posted: ${MR_URL}/1#note_701`);
        expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
            ["POST", `${PROJECT_API}/merge_requests/1/notes`, { body: "Is !1 still needed?" }],
        ]);
        const review = readReport(path).mrs[0]?.review;
        expect(review?.postedNoteUrl).toBe(`${MR_URL}/1#note_701`);
        expect(review?.postedAt).toBeDefined();
        expect(
            readLedger().some((e) => e.pr === "1" && e.comment_id === 701 && e.message === "Is !1 still needed?")
        ).toBe(true);
    });

    test("an MR that moved since the sweep is refused until --force, and a dry run only shows what moved", async () => {
        const path = path1();
        const fake = newFake();
        mrRoutes(fake, 1, { mr: { sha: "deadbeef0000" } });
        fake.on("POST", `${PROJECT_API}/merge_requests/1/notes`, { id: 702 });

        await expect(run(fake, "post", path, "--iid", "1")).rejects.toThrow(
            "!1 moved since the sweep; re-read the draft against the changes, then pass --force to post it anyway."
        );
        expect(fake.writes()).toEqual([]);

        const dry = await run(fake, "post", path, "--iid", "1", "--dry-run");

        expect(dry.stderr).toContain(
            "Changed since the sweep (2026-03-01):\n  - new commits on the branch (00000001 -> deadbeef)"
        );
        expect(dry.stderr).toContain("Dry run, nothing posted.");
        expect(fake.writes()).toEqual([]);

        await run(fake, "post", path, "--iid", "1", "--force");

        expect(fake.writes()).toHaveLength(1);
        expect(readReport(path).mrs[0]?.review.postedNoteUrl).toBe(`${MR_URL}/1#note_702`);
    });

    test("--draft creates a private draft note with the pending side texts folded in", async () => {
        const mr = reviewedMrFixture(1, {}, { sideComments: [{ key: "k", body: "Side text" }] });
        const path = writeReport(staleReportFixture([mr]));
        const fake = newFake();
        mrRoutes(fake, 1);
        fake.on("POST", `${PROJECT_API}/merge_requests/1/draft_notes`, { id: 55 });

        const ran = await run(fake, "post", path, "--iid", "1", "--draft");

        expect(ran.stderr).toContain("(1 side text(s) folded in: k)");
        expect(ran.stderr).toContain("Draft note 55 created on !1; visible only to you until published.");
        expect(fake.writes()[0]?.body).toEqual({ note: "Is !1 still needed?\n\nSide text" });
        const saved = readReport(path).mrs[0];
        expect(saved?.review).toMatchObject({ draftNoteId: 55, sentBody: "Is !1 still needed?\n\nSide text" });
        expect(saved?.sideComments?.[0]?.draftNoteId).toBe(55);
    });

    test("it names what is missing: an iid, a drafted comment, an unposted MR, a draft that already exists", async () => {
        const path = writeReport(
            staleReportFixture([
                reviewedMrFixture(1, { draftNoteId: 55 }),
                staleMrFixture(2),
                reviewedMrFixture(3, { postedNoteUrl: `${MR_URL}/3#note_5` }),
            ])
        );
        const fake = newFake();

        await expect(run(fake, "post", path)).rejects.toThrow(
            "--iid is required (or --draft with --author for a batch of draft notes)."
        );
        await expect(run(fake, "post", path, "--iid", "9")).rejects.toThrow("!9 is not in this report");
        await expect(run(fake, "post", path, "--iid", "2")).rejects.toThrow("!2 has no drafted comment to post");
        await expect(run(fake, "post", path, "--iid", "3")).rejects.toThrow(
            `!3 was already posted: ${MR_URL}/3#note_5`
        );
        await expect(run(fake, "post", path, "--iid", "1")).rejects.toThrow(
            "!1 already has draft note 55; publish it with"
        );
        expect(fake.writes()).toEqual([]);
    });

    test("a refused post or draft is an error that names the status and keeps the sweep unchanged", async () => {
        const path = path1();
        const fake = newFake();
        mrRoutes(fake, 1);
        fake.on("POST", `${PROJECT_API}/merge_requests/1/notes`, status(403, { message: "no access" }));
        fake.on("POST", `${PROJECT_API}/merge_requests/1/draft_notes`, status(422, { message: "bad" }));
        const before = readFileSync(path, "utf8");

        await expect(run(fake, "post", path, "--iid", "1")).rejects.toThrow("POST failed for !1: 403 ");
        await expect(run(fake, "post", path, "--iid", "1", "--draft")).rejects.toThrow(
            "Draft note failed for !1: 422 "
        );
        expect(readFileSync(path, "utf8")).toBe(before);
    });

    test("--draft --author makes one draft per undrafted MR of those authors, and a dry run only lists them", async () => {
        const path = writeReport(
            staleReportFixture([
                reviewedMrFixture(1),
                reviewedMrFixture(2, {}, { author: BOB }),
                reviewedMrFixture(3, { draftNoteId: 9 }),
            ])
        );
        const fake = newFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/1/draft_notes`, { id: 66 });

        const dry = await run(fake, "post", path, "--draft", "--author", "alice", "--dry-run");

        expect(dry.stdout).toContain("| !1 | alice | ASK AUTHOR | dry run |");
        expect(dry.stderr).toContain("Dry run: 1 draft note(s) would be created, nothing sent.");
        expect(fake.writes()).toEqual([]);

        const ran = await run(fake, "post", path, "--draft", "--author", "alice");

        expect(ran.stdout).toContain("| !1 | alice | ASK AUTHOR | draft 66 |");
        expect(ran.stderr).toContain("1 draft note(s) created, 0 failed.");
        expect(readReport(path).mrs[0]?.review.draftNoteId).toBe(66);

        const none = await run(fake, "post", path, "--draft", "--author", "carol");

        expect(none.stderr).toContain("No MR of those authors has an undrafted, unposted comment.");
        await expect(run(fake, "post", path, "--author", "alice")).rejects.toThrow("--author works only with --draft");
    });

    test("a refused draft in a batch is a FAIL row with exit code 1", async () => {
        const path = path1();
        const fake = newFake();
        fake.on("POST", `${PROJECT_API}/merge_requests/1/draft_notes`, status(403, { message: "no" }));

        const ran = await run(fake, "post", path, "--draft", "--author", "alice");

        expect(ran.stdout).toContain("| !1 | alice | ASK AUTHOR | FAIL 403 ");
        expect(ran.stderr).toContain("0 draft note(s) created, 1 failed.");
        expect(process.exitCode).toBe(1);
        expect(readReport(path).mrs[0]?.review.draftNoteId).toBeUndefined();
    });
});

describe("stale publish", () => {
    const withDrafts = () =>
        writeReport(
            staleReportFixture([
                reviewedMrFixture(
                    1,
                    { draftNoteId: 55 },
                    {
                        sideComments: [
                            { key: "k", body: "Side", draftNoteId: 55 },
                            { key: "j", body: "Other", draftNoteId: 56 },
                        ],
                    }
                ),
            ])
        );

    test("publishes the review draft and each side draft of one MR and records where each note landed", async () => {
        const path = withDrafts();
        const fake = newFake();
        mrRoutes(fake, 1, {
            notes: [
                rawNote(801, { author: "me", body: "Is !1 still needed?\n\nSide", at: "2026-03-02T00:00:00Z" }),
                rawNote(802, { author: "me", body: "Other", at: "2026-03-02T00:01:00Z" }),
            ],
        });
        fake.on("PUT", `${PROJECT_API}/merge_requests/1/draft_notes/55/publish`, {});
        fake.on("PUT", `${PROJECT_API}/merge_requests/1/draft_notes/56/publish`, {});

        const ran = await run(fake, "publish", path, "--iid", "1");

        expect(fake.writes().map((w) => w.path)).toEqual([
            `${PROJECT_API}/merge_requests/1/draft_notes/55/publish`,
            `${PROJECT_API}/merge_requests/1/draft_notes/56/publish`,
        ]);
        expect(ran.stderr).toBe(`Published: ${MR_URL}/1#note_801, ${MR_URL}/1#note_802\n`);
        const saved = readReport(path).mrs[0];
        expect(saved?.review.postedNoteUrl).toBe(`${MR_URL}/1#note_801`);
        expect(saved?.sideComments?.map((c) => [c.key, c.postedNoteUrl, c.draftNoteId])).toEqual([
            ["k", `${MR_URL}/1#note_801`, undefined],
            ["j", `${MR_URL}/1#note_802`, undefined],
        ]);
        expect(readLedger().some((e) => e.pr === "1" && e.comment_id === 802 && e.message === "Other")).toBe(true);
    });

    test("it refuses an MR with nothing pending, an unknown MR, and a draft GitLab will not publish", async () => {
        const fake = newFake();
        mrRoutes(fake, 1);
        const clean = writeReport(staleReportFixture([reviewedMrFixture(1)]), "clean.json");

        await expect(run(fake, "publish", clean, "--iid", "1")).rejects.toThrow(
            "!1 has no pending draft note of this flow."
        );
        await expect(run(fake, "publish", clean, "--iid", "9")).rejects.toThrow("!9 is not in this report");

        const path = withDrafts();
        fake.on("PUT", `${PROJECT_API}/merge_requests/1/draft_notes/55/publish`, status(404, { message: "gone" }));

        await expect(run(fake, "publish", path, "--iid", "1")).rejects.toThrow("Publish failed for !1 draft 55: 404 ");
        expect(readReport(path).mrs[0]?.review.postedNoteUrl).toBeUndefined();
    });

    test("a side draft that GitLab refuses stops the publish after the review draft went out", async () => {
        const path = withDrafts();
        const fake = newFake();
        mrRoutes(fake, 1, { notes: [rawNote(801, { author: "me", body: "Is !1 still needed?\n\nSide" })] });
        fake.on("PUT", `${PROJECT_API}/merge_requests/1/draft_notes/55/publish`, {});
        fake.on("PUT", `${PROJECT_API}/merge_requests/1/draft_notes/56/publish`, status(404, { message: "gone" }));

        await expect(run(fake, "publish", path, "--iid", "1")).rejects.toThrow(
            "Publish failed for !1 side draft 56: 404 "
        );
    });
});

describe("stale manifest", () => {
    const contacted = () =>
        writeReport(
            staleReportFixture([
                reviewedMrFixture(1, { postedAt: "2026-03-02T10:00:00Z", postedNoteUrl: `${MR_URL}/1#note_5` }),
                reviewedMrFixture(2, {
                    postedAt: "2026-03-02T10:00:00Z",
                    postedNoteUrl: `${MR_URL}/2#note_6`,
                    labels: [{ type: "add", label: "Stale" }],
                    labelsBefore: [],
                    labelsAfter: ["Stale"],
                    labelsAppliedAt: "2026-03-02T11:00:00Z",
                }),
                reviewedMrFixture(3, { postedAt: "2026-03-02T10:00:00Z", postedNoteUrl: `${MR_URL}/3#note_7` }),
                reviewedMrFixture(4),
            ])
        );

    function liveRoutes(overrides: { first?: Record<string, unknown> } = {}): FakeGitLab {
        const fake = newFake();
        mrRoutes(fake, 1, {
            mr: overrides.first,
            notes: [rawNote(8, { author: "carol", body: "Still needed, I will rebase", at: "2026-03-05T00:00:00Z" })],
        });
        mrRoutes(fake, 2, { mr: { labels: ["Stale"] } });
        mrRoutes(fake, 3, { mr: { state: "merged" } });

        return fake;
    }

    test("refetches every MR we wrote to and gives each a status by what the author did since", async () => {
        const path = contacted();
        const manifest = join(dir, "sweep-manifest.json");

        const ran = await run(liveRoutes(), "manifest", path);

        expect(ran.stderr).toContain("Refetching 3 contacted MR(s) and their work items…");
        expect(ran.stderr).toContain(`3 entries written to ${manifest}`);
        expect(ran.stdout).toContain(`| [!1](${MR_URL}/1) | alice | review | 2026-03-02 | `);
        expect(ran.stdout).toContain("| never-applied | 1 note(s), newest 2026-03-05 by carol | answered-no-label |");
        expect(ran.stdout).toContain("| present | none | silent |");
        expect(ran.stdout).toContain("| never-applied | none | merged |");
        expect(ran.stdout).toContain(
            "| answered-no-label | 1 | still open, the author reacted, we never labelled it |"
        );
        const saved = SafeJSON.parse(readFileSync(manifest, "utf8"), { strict: true }) as StaleManifest;
        expect(saved.source).toBe(path);
        expect(saved.previousRunAt).toBeNull();
        expect(saved.entries.map((e) => [e.iid, e.status])).toEqual([
            [1, "answered-no-label"],
            [2, "silent"],
            [3, "merged"],
        ]);
    });

    test("a second run says which statuses moved and which MRs are new, and --dry-run leaves the file alone", async () => {
        const path = contacted();
        const manifest = join(dir, "sweep-manifest.json");
        await run(liveRoutes(), "manifest", path);
        const first = readFileSync(manifest, "utf8");

        const quiet = await run(liveRoutes(), "manifest", path, "--dry-run");

        expect(quiet.stderr).toMatch(/No status changed since the manifest of \d{4}-\d\d-\d\d \d\d:\d\d\./);
        expect(quiet.stderr).toContain(`Dry run: ${manifest} not written.`);
        expect(readFileSync(manifest, "utf8")).toBe(first);

        const moved = await run(liveRoutes({ first: { state: "closed" } }), "manifest", path);

        expect(moved.stderr).toContain("!1 answered-no-label → closed");

        const report = readReport(path);
        report.mrs.push(
            reviewedMrFixture(5, { postedAt: "2026-03-03T00:00:00Z", postedNoteUrl: `${MR_URL}/5#note_9` })
        );
        writeFileSync(path, SafeJSON.stringify(report));
        const fake = liveRoutes();
        mrRoutes(fake, 5);

        const added = await run(fake, "manifest", path);

        expect(added.stderr).toContain("New to the manifest: !5");
    });

    test("--status filters the table, --ignore-author drops a reply from the reaction, --iid picks one MR", async () => {
        const path = contacted();

        const merged = await run(liveRoutes(), "manifest", path, "--status", "merged", "--dry-run");

        expect(merged.stdout).toContain("| merged |");
        expect(merged.stdout.split("\n").filter((line) => line.startsWith("| [!"))).toHaveLength(1);

        const ignored = await run(
            liveRoutes(),
            "manifest",
            path,
            "--ignore-author",
            "carol",
            "--iid",
            "1",
            "--dry-run"
        );

        expect(ignored.stdout).toContain("| silent |");
        await expect(run(liveRoutes(), "manifest", path, "--status", "bogus")).rejects.toThrow(
            "--status takes one of merged"
        );
        await expect(run(liveRoutes(), "manifest", path, "--iid", "4")).rejects.toThrow(
            "!4 was never written to by this sweep"
        );
    });
});

describe("stale followup and close", () => {
    const notified = { postedAt: "2026-03-01T00:00:00Z", postedNoteUrl: `${MR_URL}/1#note_5` };

    test("followup lists the notified MRs with what moved since and names the close candidates", async () => {
        const path = writeReport(
            staleReportFixture([
                reviewedMrFixture(1, notified),
                reviewedMrFixture(2, { ...notified, postedNoteUrl: `${MR_URL}/2#note_6` }),
                reviewedMrFixture(3, { draftNoteId: 77, draftComment: "Is !3 still needed?" }),
                reviewedMrFixture(4),
            ])
        );
        const fake = newFake();
        mrRoutes(fake, 1);
        mrRoutes(fake, 2, {
            notes: [rawNote(9, { author: "carol", body: "We still need it", at: "2026-03-04T00:00:00Z" })],
        });
        mrRoutes(fake, 3, {
            notes: [rawNote(10, { author: "me", body: "Is !3 still needed?", at: "2026-03-03T00:00:00Z" })],
        });

        const ran = await run(fake, "followup", path);

        const rows = ran.stdout.split("\n").filter((line) => line.startsWith("| [!"));
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatch(
            new RegExp(`^\\| \\[!1\\]\\(${MR_URL}/1\\) \\| ASK AUTHOR \\| 2026-03-01 \\| \\d+ \\| none \\| yes \\|$`)
        );
        expect(rows[1]).toContain("1 note(s), newest 2026-03-04 by carol: We still need it | no |");
        expect(rows[2]).toContain("| [!3](");
        expect(ran.stderr).toContain("1 draft note(s) were published in GitLab since; postedAt recorded.");
        expect(ran.stderr).toContain("3 notified; 2 close candidate(s) after 7 silent day(s): !1, !3.");
        expect(readReport(path).mrs[2]?.review.postedNoteUrl).toBe(`${MR_URL}/3#note_10`);
    });

    test("followup says so when nothing was notified, and refuses a day count that is not a number", async () => {
        const path = writeReport(staleReportFixture([reviewedMrFixture(1)]));

        const ran = await run(newFake(), "followup", path);

        expect(ran.stderr).toContain("No notified MRs in this report.");
        await expect(run(newFake(), "followup", path, "--after-days", "x")).rejects.toThrow(
            "--after-days must be a whole number of days"
        );
    });

    function closeRoutes(
        extra: { notes?: Array<Record<string, unknown>>; mr?: Record<string, unknown> } = {}
    ): FakeGitLab {
        const fake = newFake();
        mrRoutes(fake, 1, extra);
        fake.on("PUT", `${PROJECT_API}/merge_requests/1`, { state: "closed" });

        return fake;
    }

    const notifiedReport = (review: Record<string, unknown> = {}, extra = {}) =>
        writeReport(
            staleReportFixture([reviewedMrFixture(1, { ...notified, ...review }, extra), reviewedMrFixture(2)])
        );

    test("close shows the activity check, closes the one MR and records closedAt", async () => {
        const path = notifiedReport();
        const fake = closeRoutes();

        const ran = await run(fake, "close", path, "--iid", "1");

        expect(ran.stderr).toMatch(
            /!1 MR 1\n.*\nNotified 2026-03-01 \(\d+ d ago\), live state opened\nActivity since: none/
        );
        expect(ran.stderr).toContain(`Closed !1 (${MR_URL}/1).`);
        expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
            ["PUT", `${PROJECT_API}/merge_requests/1`, { state_event: "close" }],
        ]);
        expect(readReport(path).mrs[0]?.review.closedAt).toBeDefined();
    });

    test("close refuses an MR with activity, a fresh notification, a closed MR or one we never notified, until --force", async () => {
        const fresh = notifiedReport({ postedAt: new Date().toISOString() });
        const fake = closeRoutes();

        await expect(run(fake, "close", fresh, "--iid", "1")).rejects.toThrow(
            "!1 is not a close candidate (only 0 of 7 silent days). Pass --force after reading the activity."
        );
        await run(fake, "close", fresh, "--iid", "1", "--force");
        expect(fake.writes()).toHaveLength(1);

        const replied = notifiedReport();
        const withReply = closeRoutes({
            notes: [rawNote(9, { author: "carol", body: "Please keep it", at: "2026-03-04T00:00:00Z" })],
        });

        await expect(run(withReply, "close", replied, "--iid", "1")).rejects.toThrow(
            "!1 is not a close candidate (activity since the notification)."
        );
        await expect(run(closeRoutes({ mr: { state: "closed" } }), "close", replied, "--iid", "1")).rejects.toThrow(
            "!1 is already closed; nothing to close."
        );
        await expect(run(closeRoutes(), "close", replied, "--iid", "2")).rejects.toThrow(
            "!2 was not notified by this flow, or is already closed by it"
        );
    });

    test("close --dry-run closes nothing, and a refused close is an error that names the status", async () => {
        const path = notifiedReport();
        const fake = closeRoutes();

        const dry = await run(fake, "close", path, "--iid", "1", "--dry-run");

        expect(dry.stderr).toContain("Dry run, nothing closed.");
        expect(fake.writes()).toEqual([]);

        fake.on("PUT", `${PROJECT_API}/merge_requests/1`, status(403, { message: "no" }));

        await expect(run(fake, "close", path, "--iid", "1")).rejects.toThrow("Close failed for !1: 403 ");
        expect(readReport(path).mrs[0]?.review.closedAt).toBeUndefined();
    });

    test("close will not trust a work item it cannot read, unless --force says it was checked by hand", async () => {
        const path = notifiedReport({}, { ado: closedBugAdo(600, "Active") });
        const fake = closeRoutes();

        await expect(run(fake, "close", path, "--iid", "1")).rejects.toThrow("Cannot read ADO work item 600 now");
        expect(fake.writes()).toEqual([]);

        await run(fake, "close", path, "--iid", "1", "--force");

        expect(fake.writes()).toHaveLength(1);
    });

    describe("--delete-branch", () => {
        const branch = `${PROJECT_API}/repository/branches/${encodeURIComponent("feature/1")}`;

        function deleteRoutes(
            options: { users?: (call: number) => unknown[]; protectedAt?: (call: number) => boolean } = {}
        ) {
            const fake = closeRoutes();
            let listCalls = 0;
            let branchCalls = 0;
            fake.get(`${PROJECT_API}/merge_requests`, (request) => {
                if (!request.query.get("source_branch") && !request.query.get("target_branch")) {
                    return [];
                }

                listCalls++;

                return options.users?.(listCalls) ?? [];
            });
            fake.get(branch, () => ({ name: "feature/1", protected: options.protectedAt?.(++branchCalls) ?? false }));
            fake.on("DELETE", branch, status(204));

            return fake;
        }

        test("closes the MR and deletes its branch when no other open MR and no protection stands in the way", async () => {
            const path = notifiedReport();
            const fake = deleteRoutes();

            const ran = await run(fake, "close", path, "--iid", "1", "--delete-branch");

            expect(ran.stderr).toContain("Branch feature/1 is unprotected and used by no other open MR.");
            expect(ran.stderr).toContain("Deleted origin/feature/1.");
            expect(fake.writes().map((w) => [w.method, w.path])).toEqual([
                ["PUT", `${PROJECT_API}/merge_requests/1`],
                ["DELETE", branch],
            ]);
            expect(readReport(path).mrs[0]?.review.sourceBranchDeletedAt).toBeDefined();
        });

        test("it refuses before closing when another MR of the sweep or a live MR uses the branch, or it is protected", async () => {
            const shared = writeReport(
                staleReportFixture([
                    reviewedMrFixture(1, notified),
                    reviewedMrFixture(2, {}, { targetBranch: "feature/1" }),
                ])
            );
            const fake = deleteRoutes();

            await expect(run(fake, "close", shared, "--iid", "1", "--delete-branch")).rejects.toThrow(
                "Branch feature/1 is still used by open !2; close those first or drop --delete-branch."
            );

            const alone = notifiedReport();

            await expect(
                run(deleteRoutes({ users: () => [{ iid: 9 }] }), "close", alone, "--iid", "1", "--delete-branch")
            ).rejects.toThrow("Branch feature/1 is still used by open !9;");
            await expect(
                run(deleteRoutes({ protectedAt: () => true }), "close", alone, "--iid", "1", "--delete-branch")
            ).rejects.toThrow("Branch feature/1 is protected; not deleting.");
            expect(fake.writes()).toEqual([]);
        });

        test("a branch that is gone from origin is reported, and a --dry-run deletes nothing", async () => {
            const path = notifiedReport();
            const gone = deleteRoutes();
            gone.get(branch, status(404));

            const ran = await run(gone, "close", path, "--iid", "1", "--delete-branch");

            expect(ran.stderr).toContain("Branch feature/1 no longer exists on origin.");
            expect(gone.writes().map((w) => w.method)).toEqual(["PUT"]);

            const dry = deleteRoutes();
            const again = notifiedReport({}, {});

            await run(dry, "close", again, "--iid", "1", "--delete-branch", "--dry-run");

            expect(dry.writes()).toEqual([]);
        });

        test("a branch a new MR started using, or that became protected, after the close is kept and the error says so", async () => {
            const path = notifiedReport();
            const used = deleteRoutes({ users: (call) => (call > 2 ? [{ iid: 9 }] : []) });

            await expect(run(used, "close", path, "--iid", "1", "--delete-branch")).rejects.toThrow(
                "Closed, but not deleting feature/1: open !9 started using it."
            );

            const protectedNow = deleteRoutes({ protectedAt: (call) => call > 1 });

            await expect(run(protectedNow, "close", notifiedReport(), "--iid", "1", "--delete-branch")).rejects.toThrow(
                "Closed, but not deleting feature/1: it is protected now."
            );
            expect(protectedNow.writes().map((w) => w.method)).toEqual(["PUT"]);
        });

        test("a delete GitLab refuses is an error that names the status, after the close went through", async () => {
            const fake = deleteRoutes();
            fake.on("DELETE", branch, status(403, { message: "forbidden" }));
            const path = notifiedReport();

            await expect(run(fake, "close", path, "--iid", "1", "--delete-branch")).rejects.toThrow(
                "Closed, but deleting feature/1 failed: 403 "
            );
            expect(readReport(path).mrs[0]?.review.closedAt).toBeDefined();
            expect(readReport(path).mrs[0]?.review.sourceBranchDeletedAt).toBeUndefined();
        });
    });
});

describe("stale apply-labels", () => {
    const add = (label: string) => ({ type: "add" as const, label });
    const labelsFor = (iid: number, ...actions: Array<ReturnType<typeof add>>) =>
        reviewedMrFixture(iid, { labels: actions });

    function labelRoutes(): FakeGitLab {
        const fake = newFake();
        fake.get(`${PROJECT_API}/labels`, [{ name: "Stale" }, { name: "blocked" }]);

        return fake;
    }

    test("adds the planned labels, logs before and after, and leaves an MR that already has them unchanged", async () => {
        const path = writeReport(staleReportFixture([labelsFor(1, add("Stale")), labelsFor(2, add("Stale"))]));
        const fake = labelRoutes();
        mrRoutes(fake, 1, { mr: { labels: ["blocked"] } });
        mrRoutes(fake, 2, { mr: { labels: ["Stale"] } });
        fake.on("PUT", `${PROJECT_API}/merge_requests/1`, { labels: ["blocked", "Stale"] });

        const ran = await run(fake, "apply-labels", path);

        expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
            ["PUT", `${PROJECT_API}/merge_requests/1`, { add_labels: "Stale" }],
        ]);
        expect(ran.stdout).toContain("| !1 | blocked | Stale, blocked | ok |");
        expect(ran.stdout).toContain("| !2 | Stale | Stale | unchanged |");
        expect(ran.stderr).toContain("Changed: 1  Unchanged: 1  Failed: 0");
        const saved = readReport(path);
        expect(saved.mrs[0]?.review).toMatchObject({ labelsBefore: ["blocked"], labelsAfter: ["Stale", "blocked"] });
        expect(saved.mrs[0]?.review.labelsAppliedAt).toBeDefined();
        expect(saved.mrs[1]?.review).toMatchObject({ labelsBefore: ["Stale"], labelsAfter: ["Stale"] });
        expect(
            readLabelLedger().some((e) => e.project === FAKE_PROJECT && e.iid === 1 && e.after?.includes("Stale"))
        ).toBe(true);
    });

    test("a dry run prints the plan and sends nothing, and only an MR needing no change is saved as applied", async () => {
        const path = writeReport(staleReportFixture([labelsFor(1, add("Stale")), labelsFor(2, add("Stale"))]));
        const fake = labelRoutes();
        mrRoutes(fake, 1, { mr: { labels: ["blocked"] } });
        mrRoutes(fake, 2, { mr: { labels: ["Stale"] } });

        const ran = await run(fake, "apply-labels", path, "--dry-run");

        expect(fake.writes()).toEqual([]);
        expect(ran.stdout).toContain("| !1 | blocked | Stale, blocked | planned |");
        expect(ran.stderr).toContain("Would change: 1  Unchanged: 1  Failed: 0  (dry run, nothing sent)");
        const saved = readReport(path);
        expect(saved.mrs[0]?.review.labelsAppliedAt).toBeUndefined();
        expect(saved.mrs[1]?.review.labelsAppliedAt).toBeDefined();
    });

    test("a refused change and a result that differs from the plan are failures with exit code 1", async () => {
        const path = writeReport(staleReportFixture([labelsFor(3, add("Stale")), labelsFor(4, add("Stale"))]));
        const fake = labelRoutes();
        mrRoutes(fake, 3);
        mrRoutes(fake, 4);
        fake.on("PUT", `${PROJECT_API}/merge_requests/3`, status(403, { message: "no" }));
        fake.on("PUT", `${PROJECT_API}/merge_requests/4`, { labels: ["blocked"] });

        const ran = await run(fake, "apply-labels", path);

        expect(ran.stdout).toContain("| !3 | (none) | Stale | FAIL 403 ");
        expect(ran.stdout).toContain("| !4 | (none) | blocked | FAIL 200 expected Stale |");
        expect(ran.stderr).toContain("Changed: 0  Unchanged: 0  Failed: 2");
        expect(process.exitCode).toBe(1);
        expect(readReport(path).mrs[0]?.review.labelsAppliedAt).toBeUndefined();
    });

    test("it refuses a label the project does not have, and says when nothing is pending", async () => {
        const path = writeReport(staleReportFixture([labelsFor(1, add("Nope")), reviewedMrFixture(2)]));
        const fake = labelRoutes();
        mrRoutes(fake, 1);

        await expect(run(fake, "apply-labels", path)).rejects.toThrow(
            `Unknown project label(s): Nope. Fix review.labels in ${path}.`
        );
        expect(fake.writes()).toEqual([]);

        const nothing = writeReport(staleReportFixture([reviewedMrFixture(2)]), "nothing.json");

        expect((await run(fake, "apply-labels", nothing)).stderr).toContain("No pending label changes.");
        await expect(run(fake, "apply-labels", nothing, "--iid", "2")).rejects.toThrow(
            "!2 has no pending label changes in this report"
        );
    });
});

describe("stale reconcile and sync-note", () => {
    const identity = { host: FAKE_HOST, projectId: 4242, project: FAKE_PROJECT };

    test("reconcile restores what the sweep lost from live notes, drafts, both ledgers and the live labels and state", async () => {
        const stale = { type: "add" as const, label: "Stale" };
        const path = writeReport(
            staleReportFixture([
                reviewedMrFixture(11),
                reviewedMrFixture(12),
                reviewedMrFixture(13),
                reviewedMrFixture(14, { labels: [stale], postedNoteUrl: `${MR_URL}/14#note_4` }),
                reviewedMrFixture(15, { labels: [stale], postedNoteUrl: `${MR_URL}/15#note_5` }),
            ])
        );
        appendLedger({
            ...identity,
            pr: "12",
            comment_id: 902,
            message: "Is !12 still needed?",
            ts: "2026-03-02T11:00:00Z",
        });
        appendLabelLedger({
            ts: "2026-03-02T12:00:00Z",
            project: FAKE_PROJECT,
            iid: 15,
            add: ["Stale"],
            remove: [],
            before: ["blocked"],
            after: ["Stale", "blocked"],
            ok: true,
            dryRun: false,
        });
        const fake = newFake();
        mrRoutes(fake, 11, {
            notes: [rawNote(901, { author: "me", body: "Is !11 still needed?\n", at: "2026-03-02T10:00:00Z" })],
        });
        mrRoutes(fake, 12);
        mrRoutes(fake, 13);
        mrRoutes(fake, 14, { mr: { labels: ["Stale"], state: "closed", updated_at: "2026-03-04T00:00:00Z" } });
        mrRoutes(fake, 15);
        fake.get(`${PROJECT_API}/merge_requests/13/draft_notes`, [{ id: 77, note: "Is !13 still needed?" }]);
        fake.get(new RegExp(`^${PROJECT_API}/merge_requests/1[245]/draft_notes$`), []);

        const ran = await run(fake, "reconcile", path);

        expect(ran.stdout).toContain(
            [
                "| MR | Restored |",
                "|---|---|",
                "| !11 | posted (live) |",
                "| !12 | posted (ledger) |",
                "| !13 | draft 77 |",
                "| !14 | labels (live, unchanged), closed (2026-03-04) |",
                "| !15 | labels (ledger) |",
            ].join("\n")
        );
        expect(ran.stderr).toContain(`5 MR(s) had operational state restored; written to ${path}.`);
        const [one, two, three, four, five] = readReport(path).mrs.map((m) => m.review);
        expect(one?.postedNoteUrl).toBe(`${MR_URL}/11#note_901`);
        expect(two?.postedNoteUrl).toBe(`${MR_URL}/12#note_902`);
        expect(three?.draftNoteId).toBe(77);
        expect(four).toMatchObject({ labelsBefore: ["Stale"], labelsAfter: ["Stale"] });
        expect(four?.closedAt).toBe("2026-03-04T00:00:00.000Z");
        expect(five).toMatchObject({ labelsBefore: ["blocked"], labelsAfter: ["Stale", "blocked"] });
        expect(fake.writes()).toEqual([]);
    });

    test("sync-note brings a published note up to the current draft and keeps what was appended after the post", async () => {
        const url = `${MR_URL}/1#note_901`;
        const path = writeReport(
            staleReportFixture([
                reviewedMrFixture(1, { postedNoteUrl: url, draftComment: "Is !1 still needed? (updated)" }),
            ])
        );
        appendLedger({
            ...identity,
            pr: "1",
            comment_id: 901,
            message: "Is !1 still needed?",
            ts: "2026-03-02T10:00:00Z",
        });
        const fake = newFake();
        fake.get(`${PROJECT_API}/merge_requests/1/notes/901`, {
            id: 901,
            body: "Is !1 still needed?\n\nSide text",
            author: { username: "me" },
        });
        fake.on("PUT", `${PROJECT_API}/merge_requests/1/notes/901`, {});

        const dry = await run(fake, "sync-note", path, "--dry-run");

        expect(dry.stdout).toContain(
            "| !1 | would update note 901: - Is !1 still needed? ⏎ + Is !1 still needed? (updated) |"
        );
        expect(dry.stderr).toContain("1 notes and drafts checked, 1 would change (dry run).");
        expect(fake.writes()).toEqual([]);

        const ran = await run(fake, "sync-note", path);

        expect(fake.writes().map((w) => [w.method, w.body])).toEqual([
            ["PUT", { body: "Is !1 still needed? (updated)\n\nSide text" }],
        ]);
        expect(ran.stdout).toContain("| !1 | updated note 901: ");
        expect(ran.stderr).toContain("1 notes and drafts checked, 1 updated.");
        expect(
            readLedger().some(
                (e) => e.pr === "1" && e.comment_id === 901 && e.message === "Is !1 still needed? (updated)"
            )
        ).toBe(true);
    });

    test("sync-note updates a pending draft from what was sent, and says why it skips a note it cannot match", async () => {
        const path = writeReport(
            staleReportFixture([
                reviewedMrFixture(2, { draftNoteId: 55, sentBody: "Old draft", draftComment: "New draft" }),
                reviewedMrFixture(3, { postedNoteUrl: `${MR_URL}/3#note_903`, draftComment: "Fresh text" }),
                reviewedMrFixture(4, { postedNoteUrl: `${MR_URL}/4#note_904`, draftComment: "Fresh text" }),
                reviewedMrFixture(5, { draftNoteId: 56, sentBody: "x", draftComment: "y" }),
            ])
        );
        const fake = newFake();
        fake.get(`${PROJECT_API}/merge_requests/2/draft_notes`, [{ id: 55, note: "Old draft" }]);
        fake.get(`${PROJECT_API}/merge_requests/5/draft_notes`, []);
        fake.get(`${PROJECT_API}/merge_requests/3/notes/903`, {
            id: 903,
            body: "Someone else wrote this",
            author: { username: "x" },
        });
        fake.get(`${PROJECT_API}/merge_requests/4/notes/904`, status(404));
        fake.on("PUT", `${PROJECT_API}/merge_requests/2/draft_notes/55`, {});

        const ran = await run(fake, "sync-note", path);

        expect(fake.writes().map((w) => [w.path, w.body])).toEqual([
            [`${PROJECT_API}/merge_requests/2/draft_notes/55`, { note: "New draft" }],
        ]);
        expect(ran.stdout).toContain("| !2 | updated draft 55: - Old draft ⏎ + New draft |");
        expect(ran.stdout).toContain("| !3 | live note does not start with any text this flow sent; skipped |");
        expect(ran.stdout).toContain("| !4 | note 904 not found |");
        expect(ran.stdout).toContain("| !5 | draft 56 not found |");
        expect(readReport(path).mrs[0]?.review.sentBody).toBe("New draft");
    });

    test("sync-note reports a refused update and writes nothing back to the sweep", async () => {
        const path = writeReport(
            staleReportFixture([
                reviewedMrFixture(2, { draftNoteId: 55, sentBody: "Old draft", draftComment: "New draft" }),
            ])
        );
        const fake = newFake();
        fake.get(`${PROJECT_API}/merge_requests/2/draft_notes`, [{ id: 55, note: "Old draft" }]);
        fake.on("PUT", `${PROJECT_API}/merge_requests/2/draft_notes/55`, status(403, { message: "no" }));
        const before = readFileSync(path, "utf8");

        const ran = await run(fake, "sync-note", path, "--iid", "2");

        expect(ran.stdout).toContain("| !2 | FAIL 403 ");
        expect(ran.stderr).toContain("1 notes and drafts checked, 0 updated.");
        expect(readFileSync(path, "utf8")).toBe(before);
    });
});
