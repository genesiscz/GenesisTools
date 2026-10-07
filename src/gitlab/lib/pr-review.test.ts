import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsBaseName, factsPathOf } from "@app/gitlab/commands/pr-review";
import type { ProjectApi } from "@app/gitlab/lib/client";
import { mergeConfig, NEUTRAL_CONFIG } from "@app/gitlab/lib/config";
import {
    type ApiDiff,
    branchRef,
    collectPrReviewFacts,
    fetchRefs,
    findAddedImports,
    findWorktree,
    impactOf,
    NO_TESTS_NOTE,
    type PrReviewFacts,
    type PrReviewGate,
    parseApiDiffs,
    parseUnifiedDiff,
    type RawMergeRequest,
    removedModules,
    selectGates,
    testCandidates,
} from "@app/gitlab/lib/pr-review";
import {
    draftBlocks,
    draftExcerpt,
    expandRefs,
    fenceLanguage,
    formatPrReviewLLM,
    proposalSkeleton,
    renderDraftsOnlyMarkdown,
    renderPrReviewMarkdown,
    sessionNames,
} from "@app/gitlab/lib/pr-review-output";
import type { DraftSummary } from "@app/gitlab/lib/review-drafts";
import { collectThreadContext, type Discussion } from "@app/gitlab/lib/review-render";
import { parseProposal } from "@app/hub/lib/proposal";
import { type DetectProbes, detectGenesisTools, resetGenesisToolsCache } from "@genesiscz/utils/cli/genesis-tools";
import { json2md } from "@genesiscz/utils/json2md";

const GIT_DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ export function main() {",
    " const a = 1;",
    "-const b = 2;",
    "---config-flag",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
    "@@ -40,2 +41,2 @@",
    "-old tail",
    "+new tail",
    "\\ No newline at end of file",
    "diff --git a/src/lib/old-name.ts b/src/lib/new-name.ts",
    "similarity index 90%",
    "rename from src/lib/old-name.ts",
    "rename to src/lib/new-name.ts",
    "@@ -1,1 +1,1 @@",
    "-export const x = 1;",
    "+export const x = 2;",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "new file mode 100644",
    "Binary files /dev/null and b/assets/logo.png differ",
    "diff --git a/src/gone/index.ts b/src/gone/index.ts",
    "deleted file mode 100644",
    "--- a/src/gone/index.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export const gone = true;",
    "-export default gone;",
    "",
].join("\n");

describe("parseUnifiedDiff", () => {
    const files = parseUnifiedDiff(GIT_DIFF);

    test("numbers every line on both sides and keeps a removed '---' line as content", () => {
        const [app] = files;
        const [first, second] = app.hunks;

        expect(app).toMatchObject({ path: "src/app.ts", status: "modified", additions: 3, deletions: 3 });
        expect(first.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
            [" ", 10, 10],
            ["-", 11, null],
            ["-", 12, null],
            ["+", null, 11],
            ["+", null, 12],
            [" ", 13, 13],
        ]);
        expect(first.lines[2].text).toBe("--config-flag");
        expect(first.header).toBe("export function main() {");
        expect(second).toMatchObject({ oldStart: 40, newStart: 41 });
    });

    test("a no-newline-at-EOF marker is not a line", () => {
        expect(files[0].hunks[1].lines.map((l) => l.text)).toEqual(["old tail", "new tail"]);
    });

    test("renames, binary files and deletions", () => {
        expect(files[1]).toMatchObject({
            path: "src/lib/new-name.ts",
            oldPath: "src/lib/old-name.ts",
            status: "renamed",
            additions: 1,
            deletions: 1,
        });
        expect(files[2]).toMatchObject({ path: "assets/logo.png", status: "added", binary: true, hunks: [] });
        expect(files[3]).toMatchObject({ path: "src/gone/index.ts", status: "deleted", deletions: 2 });
    });

    test("API diff entries take status and paths from their flags", () => {
        const entries: ApiDiff[] = [
            { old_path: "a.ts", new_path: "b.ts", renamed_file: true, diff: "" },
            { old_path: "c.ts", new_path: "c.ts", new_file: true, diff: "@@ -0,0 +1,1 @@\n+hi\n" },
            { old_path: "big.json", new_path: "big.json", too_large: true, diff: "" },
            { old_path: "img.png", new_path: "img.png", diff: "" },
        ];

        expect(parseApiDiffs(entries).map((f) => [f.path, f.oldPath, f.status, f.binary, f.truncated])).toEqual([
            ["b.ts", "a.ts", "renamed", false, false],
            ["c.ts", "c.ts", "added", false, false],
            ["big.json", "big.json", "modified", false, true],
            ["img.png", "img.png", "modified", true, false],
        ]);
        expect(parseApiDiffs(entries)[1].hunks[0].lines[0]).toMatchObject({ kind: "+", newLine: 1, text: "hi" });
    });
});

describe("impact scan", () => {
    const mine = parseUnifiedDiff(GIT_DIFF);
    const other: RawMergeRequest = {
        iid: 51,
        title: "Use the gone module",
        web_url: "https://gitlab.example.com/group/app/-/merge_requests/51",
        source_branch: "feature/uses-gone",
        target_branch: "main",
        sha: "abc",
        author: { username: "bob" },
    };
    const otherDiff = (lines: string[], path = "src/feature/use.ts") =>
        parseUnifiedDiff([`diff --git a/${path} b/${path}`, "@@ -1,0 +1,3 @@", ...lines].join("\n"));

    test("modules a deletion or rename removes, including an index folder", () => {
        expect(removedModules(mine)).toEqual(["src/gone", "src/gone/index", "src/lib/old-name"]);
    });

    test("relative, root-relative and aliased imports of a removed module are found; other lines are not", () => {
        const files = otherDiff([
            '+import { gone } from "../gone";',
            "+import { x } from '@/lib/old-name';",
            '+const s = "src/gone/index";',
            '+import { y } from "src/lib/old-name";',
        ]);

        expect(findAddedImports(files, removedModules(mine)).map((hit) => [hit.newLine, hit.specifier])).toEqual([
            [1, "src/gone"],
            [2, "src/lib/old-name"],
            [4, "src/lib/old-name"],
        ]);
    });

    test("a test runner's module call of a removed module is found", () => {
        const files = otherDiff([
            '+jest.mock("src/gone/index", () => ({}));',
            "+const real = vi.importActual('../lib/old-name');",
            '+const label = "jest mocks src/gone";',
        ]);

        expect(findAddedImports(files, removedModules(mine)).map((hit) => [hit.newLine, hit.specifier])).toEqual([
            [1, "src/gone/index"],
            [2, "src/lib/old-name"],
        ]);
    });

    test("an MR that shares a file is affected; one that neither imports nor shares is not", () => {
        const changedPaths = new Set(mine.map((file) => file.path));
        const shared = impactOf({
            other,
            otherFiles: otherDiff(["+x"], "src/app.ts"),
            specifiers: [],
            changedPaths,
        });

        expect(shared).toMatchObject({ iid: 51, author: "bob", sharedFiles: ["src/app.ts"], imports: [] });
        expect(impactOf({ other, otherFiles: otherDiff(["+x"]), specifiers: [], changedPaths })).toBeNull();
    });
});

describe("gates", () => {
    const files = parseUnifiedDiff(GIT_DIFF);

    test("the impact source and the worktree hint come from the config, checked", () => {
        expect(mergeConfig({}, NEUTRAL_CONFIG).review).toMatchObject({ impactSource: "api", worktreeHint: null });
        expect(mergeConfig({ review: { impactSource: "git" } }, NEUTRAL_CONFIG).review.impactSource).toBe("git");
        expect(() => mergeConfig({ review: { impactSource: "ftp" } }, NEUTRAL_CONFIG)).toThrow(
            "review.impactSource must be one of api, git"
        );
    });

    test("no gates configured means no gates, and the config default is empty", () => {
        expect(mergeConfig({}, NEUTRAL_CONFIG).review.gates).toEqual([]);
        expect(selectGates([], files)).toEqual([]);
    });

    test("a glob-filtered gate appears only when a changed file matches, with {files} filled in", () => {
        const gates = mergeConfig({
            review: {
                gates: [
                    { label: "types", command: "bunx tsgo --noEmit" },
                    { label: "unit", command: "bun test {files}", when: "src/**/*.ts" },
                    { label: "mobile", command: "bun run test:mobile", when: "mobile/**" },
                ],
            },
        }).review.gates;

        expect(selectGates(gates, files)).toEqual([
            {
                label: "types",
                command: "bunx tsgo --noEmit",
                files: ["src/app.ts", "src/lib/new-name.ts", "assets/logo.png"],
                tests: [],
                note: null,
            },
            {
                label: "unit",
                command: "bun test src/app.ts src/lib/new-name.ts",
                files: ["src/app.ts", "src/lib/new-name.ts"],
                tests: [],
                note: null,
            },
        ]);
    });

    test("testCandidates keeps changed tests and finds the test next to a changed source file", () => {
        const withTest = parseUnifiedDiff(
            `${GIT_DIFF}\ndiff --git a/src/b.test.ts b/src/b.test.ts\n--- a/src/b.test.ts\n+++ b/src/b.test.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n`
        );
        const onDisk = new Set(["src/app.test.ts", "src/lib/new-name.spec.tsx"]);

        expect(testCandidates(withTest, (path) => onDisk.has(path))).toEqual([
            "src/app.test.ts",
            "src/b.test.ts",
            "src/lib/new-name.spec.tsx",
        ]);
    });

    test("{tests} fills in the neighbour tests minus `exclude`, and a gate with none gets the note instead", () => {
        const gates = mergeConfig({
            review: {
                gates: [
                    { label: "unit", command: "bun test {tests}", exclude: "src/lib/**" },
                    { label: "lib", command: "bun test {tests}", when: "src/lib/**", exclude: "src/lib/**/*.spec.tsx" },
                ],
            },
        }).review.gates;
        const onDisk = new Set(["src/app.test.ts", "src/lib/new-name.spec.tsx"]);
        const [unit, lib] = selectGates(gates, files, (path) => onDisk.has(path));

        expect(unit).toMatchObject({ command: "bun test src/app.test.ts", tests: ["src/app.test.ts"], note: null });
        expect(unit?.files).not.toContain("src/lib/new-name.ts");
        expect(lib).toMatchObject({ tests: [], note: NO_TESTS_NOTE });
    });

    test("review.runner is list by default and refuses an unknown value", () => {
        expect(mergeConfig({}, NEUTRAL_CONFIG).review.runner).toBe("list");
        expect(mergeConfig({ review: { runner: "parallel" } }).review.runner).toBe("parallel");
        expect(() => mergeConfig({ review: { runner: "fast" } })).toThrow(
            "review.runner must be one of list, parallel"
        );
    });

    test("a malformed gate fails loudly", () => {
        expect(() => mergeConfig({ review: { gates: [{ label: "x" }] } })).toThrow(
            "needs a non-empty label and command"
        );
        expect(() => mergeConfig({ review: { gates: {} } })).toThrow("must be an array");
    });
});

describe("findWorktree", () => {
    test("matches the whole branch name, so feat/x never finds the feat/x-2 worktree", () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "gt-pr-worktree-")));
        const repo = join(root, "repo");
        const git = (...args: string[]) =>
            spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: process.env });
        spawnSync("git", ["init", "-q", repo], { env: process.env });
        git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base");
        // `a-...` is listed before `b-...`: the prefix test used to stop at the first block.
        git("worktree", "add", "-q", "-b", "feat/x-2", join(root, "a-other"));
        git("worktree", "add", "-q", "-b", "feat/x", join(root, "b-mine"));

        expect(findWorktree(repo, "feat/x")).toBe(join(root, "b-mine"));
        expect(findWorktree(repo, "feat/x-2")).toBe(join(root, "a-other"));
        expect(findWorktree(repo, "feat")).toBeNull();
    });
});

describe("saved facts file name", () => {
    test("two hosts, or two paths with the same slug, never share a file", () => {
        const names = [
            factsBaseName({ host: "https://gitlab.one.example", project: "group/app", iid: 7 }),
            factsBaseName({ host: "https://gitlab.two.example", project: "group/app", iid: 7 }),
            factsBaseName({ host: "https://gitlab.one.example", project: "group/a-b", iid: 7 }),
            factsBaseName({ host: "https://gitlab.one.example", project: "group-a/b", iid: 7 }),
        ];

        expect(new Set(names).size).toBe(4);
        expect(names[0]).toMatch(/^gitlab-pr-group-app-[0-9a-f]{12}-7$/);
    });
});

describe("collectPrReviewFacts against a fixture GitLab", () => {
    const methods: string[] = [];
    let server: ReturnType<typeof Bun.serve>;
    let facts: PrReviewFacts;

    const mr = (iid: number, source: string, extra: Partial<RawMergeRequest> = {}): RawMergeRequest => ({
        iid,
        title: `MR ${iid}`,
        web_url: `https://gitlab.example.com/group/app/-/merge_requests/${iid}`,
        source_branch: source,
        target_branch: "main",
        sha: `head${iid}`,
        author: { username: "alice" },
        ...extra,
    });
    const routes: Record<string, unknown> = {
        "/api/v4/projects/group%2Fapp/merge_requests/42": mr(42, "feature/tidy", {
            diff_refs: { base_sha: "base0000000", start_sha: "start000000", head_sha: "head4200000" },
        }),
        "/api/v4/projects/group%2Fapp/merge_requests/42/diffs": [
            {
                old_path: "src/lib/util.ts",
                new_path: "src/lib/util.ts",
                diff: "@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = b | a;\n",
            },
            { old_path: "src/old.ts", new_path: "src/old.ts", deleted_file: true, diff: "@@ -1 +0,0 @@\n-x\n" },
        ],
        "/api/v4/projects/group%2Fapp/merge_requests/42/discussions": [
            {
                id: "disc1",
                notes: [
                    {
                        id: 1,
                        body: "Why | this?",
                        author: { username: "bob" },
                        resolved: false,
                        position: { new_path: "src/lib/util.ts", new_line: 2 },
                    },
                ],
            },
            { id: "disc2", notes: [{ id: 2, body: "Looks fine", author: { username: "carol" }, resolved: true }] },
        ],
        "/api/v4/projects/group%2Fapp/merge_requests/42/draft_notes": [
            {
                id: 900,
                note: "Consider a constant.",
                discussion_id: null,
                position: { new_path: "src/lib/util.ts", new_line: 3 },
            },
        ],
        "/api/v4/projects/group%2Fapp/merge_requests": [
            mr(42, "feature/tidy"),
            mr(51, "feature/other"),
            mr(52, "main"),
        ],
        "/api/v4/projects/group%2Fapp/merge_requests/51/diffs": [
            {
                old_path: "src/feature.ts",
                new_path: "src/feature.ts",
                diff: '@@ -1,0 +1,1 @@\n+import { x } from "./old";\n',
            },
        ],
    };

    beforeAll(async () => {
        server = Bun.serve({
            port: 0,
            fetch(request) {
                methods.push(request.method);
                const url = new URL(request.url);
                const body = routes[url.pathname];

                if (body === undefined || (url.searchParams.get("page") ?? "1") !== "1") {
                    return body === undefined ? new Response("not found", { status: 404 }) : Response.json([]);
                }

                return Response.json(body);
            },
        });
        const api: ProjectApi = { host: `http://127.0.0.1:${server.port}`, token: "t", project: "group/app" };
        facts = await collectPrReviewFacts({
            api,
            iid: 42,
            repoPath: null,
            gates: [{ label: "types", command: "bunx tsgo --noEmit", when: null, exclude: null }],
        });
    });

    afterAll(() => {
        server.stop(true);
    });

    test("reads the MR, diff, threads, drafts and impact with GETs only", () => {
        expect(new Set(methods)).toEqual(new Set(["GET"]));
        expect(facts).toMatchObject({
            provider: "gitlab",
            project: "group/app",
            iid: 42,
            baseSha: "base0000000",
            headSha: "head4200000",
            diffSource: "api",
            removedModules: ["src/old"],
            impactScanned: 1,
            warnings: [],
        });
        expect(facts.files.map((f) => [f.path, f.status])).toEqual([
            ["src/lib/util.ts", "modified"],
            ["src/old.ts", "deleted"],
        ]);
        expect(facts.impact?.map((entry) => [entry.iid, entry.imports[0]?.specifier])).toEqual([[51, "src/old"]]);
        expect(facts.drafts).toEqual([
            {
                id: 900,
                discussionId: null,
                path: "src/lib/util.ts",
                line: 3,
                side: "new",
                note: "Consider a constant.",
            },
        ]);
    });

    test("the impact scan reads at most impactLimit other diffs and says the result is partial", async () => {
        const api: ProjectApi = { host: `http://127.0.0.1:${server.port}`, token: "t", project: "group/app" };
        const bounded = await collectPrReviewFacts({ api, iid: 42, repoPath: null, impactLimit: 0 });

        expect(bounded.impactScanned).toBe(0);
        expect(bounded.impact).toEqual([]);
        expect(bounded.warnings).toEqual([
            "impact: partial, read the 0 most recently updated of 1 other open MRs (--impact-limit raises it)",
        ]);
    });

    test("the markdown report keeps the numbered structure", () => {
        expect(renderPrReviewMarkdown(facts)).toMatchInlineSnapshot(`
          "# Review: !42 MR 42

          - Author: @alice · \`feature/tidy\` → \`main\` · head \`head420000\` · diff from api
          - MR: https://gitlab.example.com/group/app/-/merge_requests/42
          - Checkout: none given (\`--repo <checkout>\`); file references are repository paths.
          - Files: 2 changed (+2 −2) · Existing threads: 2 (1 unresolved) · Your pending drafts: 1

          ## Checklist

          Mark every file before you write the report. A file counts as read when you read its hunks, or when a script proved the change mechanical (name the script in the report).

          - [ ] 01 · modified · +2 −1 · \`src/lib/util.ts:2\` · \`src/lib/util.ts\`
          - [ ] 02 · deleted · +0 −1 · \`src/old.ts\`

          ## Existing threads

          | author | anchor              | resolved | first note   |
          | ------ | ------------------- | -------- | ------------ |
          | @bob   | \`src/lib/util.ts:2\` | no       | Why \\| this? |
          | @carol | top-level           | yes      | Looks fine   |

          ## Your pending drafts

          1 unpublished draft(s). They are visible only to their author.

          > 🛑 A draft that opens a new thread has no discussion yet. Nobody can reply to it, you included, until the review is published with \`tools gitlab pr 42 comments publish --apply\`. After publishing, \`tools gitlab pr 42 comments --mine --json\` gives the new discussion ids; match them by path and line.

          ### D01 · draft 900 · \`src/lib/util.ts:3\`

          - Target: new thread on a line
          - Placement: added line

          \`\`\`markdown
          Consider a constant.
          \`\`\`

          Code at the anchor (old · new · kind):

          \`\`\`ts
            1 1   const a = 1;
            2   - const b = 2;
              2 + const b = 3;
          ▶   3 + const c = b | a;
          \`\`\`

          ## Open MRs this one affects

          Scanned 1 open MRs. Deleted or renamed modules: \`src/old\`.

          | MR                                                                    | author | adds an import of a removed module | also changes |
          | --------------------------------------------------------------------- | ------ | ---------------------------------- | ------------ |
          | [!51](https://gitlab.example.com/group/app/-/merge_requests/51) MR 51 | @alice | \`src/feature.ts\`:1 → \`src/old\`     | -            |

          ## Gates

          Run them in the MR checkout. All must exit 0 before a verdict says the MR is clean.

          \`\`\`bash
          cd -- '<checkout>' || exit 1
          # types
          bunx tsgo --noEmit
          \`\`\`

          ## Files

          Numbers are new-side lines (draft with side \`additions\`). Removed lines carry no number; their old-side line is in the JSON (\`oldLine\`, side \`deletions\`).

          ### 01 \`src/lib/util.ts\` · modified · +2 −1

          \`src/lib/util.ts:2\`

          \`\`\`ts
          1   const a = 1;
            - const b = 2;
          2 + const b = 3;
          3 + const c = b | a;
          \`\`\`

          ### 02 \`src/old.ts\` · deleted · +0 −1

          Deleted: 1 lines removed. Nothing to anchor on the new side.
          "
        `);
    });

    test("no gates configured means no gates section", () => {
        expect(renderPrReviewMarkdown({ ...facts, gates: [] })).not.toContain("## Gates");
    });

    describe("the parallel gate runner", () => {
        const parallelFacts = () => ({
            ...facts,
            repoPath: "/work/app",
            gateRunner: "parallel" as const,
            gates: [
                { label: "Type check", command: 'tsgo --noEmit "$X"', files: [], tests: [], note: null },
                { label: "unit", command: "bun test {tests}", files: [], tests: [], note: NO_TESTS_NOTE },
            ],
        });
        // The runner asks detectGenesisTools(), which caches per process: priming the cache with fake
        // probes decides what it finds, whatever is installed on the machine running the test.
        const primeDetection = (which: string | null): void => {
            const probes: DetectProbes = { which: () => which, roots: () => [], exists: () => false };
            resetGenesisToolsCache();
            detectGenesisTools(probes);
        };

        afterAll(() => {
            resetGenesisToolsCache();
        });

        test("with an install, every gate starts as a task session through that binary and each exit code is read", () => {
            primeDetection("/opt/gt/tools");
            const md = renderPrReviewMarkdown(parallelFacts());

            expect(md).toContain(
                '"/opt/gt/tools" task run --session "$P-type-check" --no-tty -- bash -c "tsgo --noEmit \\"\\$X\\"" >/dev/null 2>&1 & pids+=($!)'
            );
            expect(md).toContain('for s in "$P-type-check"; do');
            expect(md).not.toContain("$P-unit");
            expect(md).toContain(`unit: ${NO_TESTS_NOTE}`);
        });

        test("without an install, the gates are listed as plain commands", () => {
            primeDetection(null);
            const md = renderPrReviewMarkdown(parallelFacts());

            expect(md).toContain('cd -- /work/app || exit 1\n# Type check\ntsgo --noEmit "$X"');
            expect(md).not.toContain("task run");
        });

        test("a checkout path with a space or a shell character is quoted in both scripts", () => {
            const odd = { ...parallelFacts(), repoPath: "/work/My Project", worktree: "/work/My Project" };

            primeDetection(null);
            expect(renderPrReviewMarkdown(odd)).toContain("cd -- '/work/My Project' || exit 1\n");
            primeDetection("/opt/gt/tools");
            expect(renderPrReviewMarkdown(odd)).toContain("cd -- '/work/My Project' || exit 1\nP=");
        });

        test("session names stay unique when a label collides with a suffixed one", () => {
            const gate = (label: string): PrReviewGate => ({
                label,
                command: "true",
                files: [],
                tests: [],
                note: null,
            });

            expect(sessionNames([gate("unit"), gate("unit"), gate("unit-2"), gate("Unit!")])).toEqual([
                "unit",
                "unit-2",
                "unit-2-2",
                "unit-3",
            ]);
        });
    });

    test("with a checkout, anchors are file links into the MR worktree", () => {
        const md = renderPrReviewMarkdown({
            ...facts,
            repoPath: "/work/app",
            worktree: "/work/app-tidy",
            worktreeHead: facts.headSha,
        });

        expect(md).toContain("[util.ts:2](file:///work/app-tidy/src/lib/util.ts#L2)");
        expect(md).toContain("Worktree: `/work/app-tidy` (HEAD is the MR head)");
    });

    test("without a worktree on the branch the report says so, with the configured advice when there is one", () => {
        const none = { ...facts, repoPath: "/work/app", worktree: null };

        expect(renderPrReviewMarkdown(none)).toContain(
            "which is NOT the MR code. Create one with `git worktree add <dir> feature/tidy`, then re-run."
        );
        expect(
            renderPrReviewMarkdown({ ...none, worktreeHint: "Run `tool worktree init --pr {iid}` ({branch})." })
        ).toContain("which is NOT the MR code. Run `tool worktree init --pr 42` (feature/tidy).");
    });

    test("the --llm view names refs and --expand prints one in full", () => {
        const llm = formatPrReviewLLM(facts, "tools gitlab pr 42 review --give");

        expect(llm).toContain("  f1  modified  +2 −1  src/lib/util.ts");
        expect(llm).toContain("  t1  UNRESOLVED  src/lib/util.ts:2  @bob  1n  Why | this?");
        expect(llm).toContain("  m1  !51  1 imports, 0 shared");
        expect(expandRefs(facts, ["t1", "x9"])).toContain("Discussion id: disc1");
        expect(expandRefs(facts, ["x9"])).toContain("no such ref");
    });

    test("the proposal skeleton plus one draft passes parseProposal", () => {
        const skeleton = proposalSkeleton(facts, "claude");
        const proposal = parseProposal({
            ...skeleton,
            drafts: [
                {
                    path: "src/lib/util.ts",
                    side: "additions",
                    line: 3,
                    body: "Name the magic value.",
                    meta: { verdict: "minor readability" },
                },
            ],
        });

        expect(proposal).toMatchObject({
            provider: "gitlab",
            host: `127.0.0.1:${server.port}`,
            project: "group/app",
            number: 42,
            baseSha: "base0000000",
            headSha: "head4200000",
            threads: [
                { threadId: "disc1", path: "src/lib/util.ts", line: 2, author: "bob", resolved: false },
                { threadId: "disc2", author: "carol", resolved: true },
            ],
        });
        expect(proposal.drafts).toHaveLength(1);
    });
});

describe("pending drafts in full", () => {
    const files = parseUnifiedDiff(GIT_DIFF);
    const draft = (path: string | null, line: number | null, side: DraftSummary["side"] = "new"): DraftSummary => ({
        id: 1,
        discussionId: null,
        path,
        line,
        side,
        note: "x",
    });
    const facts = (drafts: DraftSummary[]): PrReviewFacts => ({
        provider: "gitlab",
        host: "https://gitlab.example.com",
        project: "group/app",
        iid: 7,
        title: "Tidy",
        author: "alice",
        webUrl: "https://gitlab.example.com/group/app/-/merge_requests/7",
        sourceBranch: "feature/tidy",
        targetBranch: "main",
        baseSha: "a".repeat(40),
        startSha: "a".repeat(40),
        headSha: "b".repeat(40),
        repoPath: null,
        worktree: null,
        worktreeHead: null,
        diffSource: "git",
        files,
        discussions: [],
        drafts,
        removedModules: [],
        impact: null,
        impactScanned: 0,
        gates: [],
        gateRunner: "list",
        testPaths: [],
        warnings: [],
    });

    test("places a draft on an added, a context and a removed line, marking the anchor", () => {
        const added = draftExcerpt(files, draft("src/app.ts", 12));
        const context = draftExcerpt(files, draft("src/app.ts", 13));
        const removed = draftExcerpt(files, draft("src/app.ts", 11, "old"));

        expect(added.placement).toBe("added line");
        expect(added.lines.filter((l) => l.startsWith("▶"))).toEqual(["▶    12 + const c = 4;"]);
        expect(context.placement).toBe("context line");
        expect(removed.placement).toBe("removed line");
        expect(removed.lines.filter((l) => l.startsWith("▶"))).toEqual(["▶ 11    - const b = 2;"]);
    });

    test("reports top-level, outside-the-diff and unknown-file drafts without an excerpt", () => {
        expect(draftExcerpt(files, draft(null, null, null)).placement).toBe("top-level");
        expect(draftExcerpt(files, draft("src/app.ts", 30)).placement).toBe("outside the diff");
        expect(draftExcerpt(files, draft("nope.ts", 1)).placement).toBe("file not in the diff");
    });

    test("renders the full body inside a fence longer than any backtick run in it", () => {
        const md = json2md(draftBlocks(facts([{ ...draft("src/app.ts", 12), note: "look:\n```ts\nx\n```" }])));

        expect(md).toContain("````markdown\nlook:\n```ts\nx\n```\n````");
        expect(md).toContain("- Placement: added line");
        expect(md).toContain("- Target: new thread on a line");
        expect(md).toContain("🛑 A draft that opens a new thread has no discussion yet");
    });

    test("a reply draft names its thread, and the drafts-only report has no impact section", () => {
        const reply = { ...draft(null, null, null), id: 2, discussionId: "d".repeat(40), note: "agreed" };
        const md = renderDraftsOnlyMarkdown(facts([reply]));

        expect(md).toContain("# Pending drafts: !7 Tidy");
        expect(md).toContain("### D01 · draft 2 · reply");
        expect(md).toContain(`- Target: reply in existing thread \`${"d".repeat(40)}\``);
        expect(md).not.toContain("Open MRs this one affects");
    });

    test("--threads puts every unresolved thread in full right after the checklist", async () => {
        const discussions: Discussion[] = [
            {
                id: "d1",
                notes: [
                    {
                        resolvable: true,
                        resolved: false,
                        author: { username: "bob" },
                        body: "Why this?",
                        position: { head_sha: "c".repeat(40), new_path: "src/app.ts", new_line: 11 },
                    },
                    { resolvable: true, resolved: false, author: { username: "alice" }, body: "Because." },
                ],
            },
            { id: "d2", notes: [{ resolvable: true, resolved: true, body: "done", position: { new_path: "a.ts" } }] },
        ];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;

                if (path.endsWith("/discussions")) {
                    return Response.json(discussions);
                }

                return path.endsWith("/merge_requests/7")
                    ? Response.json({ sha: "d".repeat(40) })
                    : new Response("x\ny\nz\n");
            },
        });

        try {
            const api: ProjectApi = { host: `http://127.0.0.1:${server.port}`, token: "t", project: "group/app" };
            const context = await collectThreadContext({
                api,
                iid: "7",
                cwd: mkdtempSync(join(tmpdir(), "gt-threads-")),
                fetchRemote: true,
                onWarn: () => {},
            });
            const opts = { mrIid: "7", project: "group/app", cwd: "/nowhere", contextLines: 1, ...context };
            const md = renderPrReviewMarkdown(facts([]), { threads: { discussions: context.discussions, opts } });
            const order = ["## Checklist", "## Unresolved threads in full", "## Thread 1", "## Existing threads"];

            expect(order.map((heading) => md.indexOf(heading))).toEqual(
                [...order.map((heading) => md.indexOf(heading))].sort((a, b) => a - b)
            );
            expect(md).not.toContain("## Thread 2");
            expect(md).toContain("**@alice**:\n> Because.");
            // The reviewer's file and the tip's are the same here, so only the tip is shown.
            expect(md).toContain("## Thread 1 — `src/app.ts`:11 · unchanged");
            expect(md).toContain("### MR tip `dddddddddd`");
            expect(renderDraftsOnlyMarkdown(facts([]), { threads: { discussions: [], opts } })).toContain(
                "## Unresolved threads in full\n\nNone."
            );
        } finally {
            server.stop(true);
        }
    });

    test("maps extensions to fence languages and falls back to text", () => {
        expect(fenceLanguage("a/B.tsx")).toBe("tsx");
        expect(fenceLanguage("ci/Build.groovy")).toBe("groovy");
        expect(fenceLanguage("patches/x+1.0.patch")).toBe("diff");
        expect(fenceLanguage("bun.lock")).toBe("text");
    });
});

describe("the git impact source", () => {
    test("fetches the open MR heads and finds an import of a removed module in a local diff", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "gt-impact-git-")));
        const origin = join(root, "origin");
        const repo = join(root, "clone");
        const run = (cwd: string, ...args: string[]) =>
            spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
                cwd,
                env: process.env,
            });
        const write = (path: string, text: string) => Bun.write(join(origin, path), text);

        spawnSync("git", ["init", "-q", "-b", "main", origin], { env: process.env });
        await write("src/old.ts", "export const x = 1;\n");
        run(origin, "add", ".");
        run(origin, "commit", "-q", "-m", "base");
        run(origin, "checkout", "-q", "-b", "feature/other");
        await write("src/feature.ts", 'import { x } from "./old";\nexport const y = x;\n');
        run(origin, "add", ".");
        run(origin, "commit", "-q", "-m", "other");
        // GitLab publishes every MR head, a fork's too, as refs/merge-requests/<iid>/head on the target
        // project. The branch of the same name here holds unrelated code, as a fork's branch name can.
        run(origin, "update-ref", "refs/merge-requests/51/head", "HEAD");
        run(origin, "checkout", "-q", "main");
        run(origin, "branch", "-q", "-f", "feature/other", "main");
        spawnSync("git", ["clone", "-q", origin, repo], { env: process.env });

        const mr = (iid: number, source: string): RawMergeRequest => ({
            iid,
            title: `MR ${iid}`,
            web_url: `https://gitlab.example.com/group/app/-/merge_requests/${iid}`,
            source_branch: source,
            target_branch: "main",
            sha: `head${iid}`,
            author: { username: "alice" },
        });
        const routes: Record<string, unknown> = {
            "/api/v4/projects/group%2Fapp/merge_requests/42": mr(42, "feature/tidy"),
            "/api/v4/projects/group%2Fapp/merge_requests/42/diffs": [
                { old_path: "src/old.ts", new_path: "src/old.ts", deleted_file: true, diff: "@@ -1 +0,0 @@\n-x\n" },
            ],
            "/api/v4/projects/group%2Fapp/merge_requests/42/discussions": [],
            "/api/v4/projects/group%2Fapp/merge_requests/42/draft_notes": [],
            "/api/v4/projects/group%2Fapp/merge_requests": [mr(42, "feature/tidy"), mr(51, "feature/other")],
        };
        const requested: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                requested.push(url.pathname);
                const body = routes[url.pathname];

                if (body === undefined || (url.searchParams.get("page") ?? "1") !== "1") {
                    return body === undefined ? new Response("not found", { status: 404 }) : Response.json([]);
                }

                return Response.json(body);
            },
        });

        try {
            const api: ProjectApi = { host: `http://127.0.0.1:${server.port}`, token: "t", project: "group/app" };
            const facts = await collectPrReviewFacts({ api, iid: 42, repoPath: repo, impactSource: "git" });

            expect(facts.impact?.map((entry) => [entry.iid, entry.imports[0]?.specifier])).toEqual([[51, "src/old"]]);
            expect(facts.impactScanned).toBe(1);
            expect(requested).not.toContain("/api/v4/projects/group%2Fapp/merge_requests/51/diffs");
            expect(run(repo, "rev-parse", "--verify", "origin/merge-requests/51").status).toBe(0);

            // A fetch past its deadline fails its refs and is not retried one ref at a time.
            const stalled = fetchRefs(repo, [branchRef("main"), branchRef("feature/other")], 1);
            expect(stalled).toEqual({ failed: ["main", "feature/other"], timedOut: true });

            const noCheckout = await collectPrReviewFacts({ api, iid: 42, repoPath: null, impactSource: "git" });
            expect(noCheckout.impact).toBeNull();
            expect(noCheckout.warnings).toContain("impact: --impact-source git needs a checkout (--repo); not scanned");
        } finally {
            server.stop(true);
        }
    });
});

describe("pr review file names", () => {
    test("the facts JSON sits beside the report", () => {
        expect(factsPathOf("/tmp/gitlab-give-review-7.md")).toBe("/tmp/gitlab-give-review-7.json");
        expect(factsPathOf("/tmp/report")).toBe("/tmp/report.json");
    });
});

describe("the api impact source", () => {
    test("warns when GitLab collapsed a file of another MR, since an import there is not seen", async () => {
        const mr = (iid: number, source: string): RawMergeRequest => ({
            iid,
            title: `MR ${iid}`,
            web_url: `https://gitlab.example.com/group/app/-/merge_requests/${iid}`,
            source_branch: source,
            target_branch: "main",
            sha: `head${iid}`,
            author: { username: "alice" },
        });
        const routes: Record<string, unknown> = {
            "/api/v4/projects/group%2Fapp/merge_requests/42": mr(42, "feature/tidy"),
            "/api/v4/projects/group%2Fapp/merge_requests/42/diffs": [
                { old_path: "src/old.ts", new_path: "src/old.ts", deleted_file: true, diff: "@@ -1 +0,0 @@\n-x\n" },
            ],
            "/api/v4/projects/group%2Fapp/merge_requests/42/discussions": [],
            "/api/v4/projects/group%2Fapp/merge_requests/42/draft_notes": [],
            "/api/v4/projects/group%2Fapp/merge_requests": [mr(42, "feature/tidy"), mr(53, "feature/big")],
            "/api/v4/projects/group%2Fapp/merge_requests/53/diffs": [
                { old_path: "src/huge.ts", new_path: "src/huge.ts", too_large: true, diff: "" },
                { old_path: "src/small.ts", new_path: "src/small.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" },
            ],
        };
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                const body = routes[url.pathname];

                if (body === undefined || (url.searchParams.get("page") ?? "1") !== "1") {
                    return body === undefined ? new Response("not found", { status: 404 }) : Response.json([]);
                }

                return Response.json(body);
            },
        });

        try {
            const api: ProjectApi = { host: `http://127.0.0.1:${server.port}`, token: "t", project: "group/app" };
            const facts = await collectPrReviewFacts({ api, iid: 42, repoPath: null });

            expect(facts.impactScanned).toBe(1);
            expect(facts.warnings).toContain(
                "impact: !53 has 1 file GitLab collapsed (src/huge.ts); an import there is not seen (--impact-source git reads it)"
            );
        } finally {
            server.stop(true);
        }
    });
});
