import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { transclude } from "./engine";
import { checkAllowed, splitCommandLine } from "./kinds/cmd";
import { defaultTransclusionRegistry } from "./kinds/index";
import { pointerSegments } from "./kinds/json";
import { parseCommentRef } from "./kinds/pr-thread";
import { heuristicSymbol } from "./kinds/symbol";
import { summarizeHtml } from "./kinds/url";
import type { TransclusionRunner } from "./types";

const registry = defaultTransclusionRegistry();
let repo = "";
let firstSha = "";

function sh(args: string[]): string {
    const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: repo,
        env: process.env,
    });

    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }

    return result.stdout.toString().trim();
}

const TS_SOURCE = `import x from "y";

/** Adds. */
export function add(a: number, b: number): number {
    return a + b;
}

export class Box {
    size = 1;

    grow(by: number): void {
        this.size += by;
    }
}

// ANCHOR: setup
const ready = true;
// ANCHOR_END: setup
`;

beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "transclude-kinds-"));
    writeFileSync(join(repo, "a.ts"), TS_SOURCE);
    writeFileSync(join(repo, "data.json"), '{ // comment\n "scripts": { "test": "bun test" }, "list": [1, 2, 3], }\n');
    writeFileSync(join(repo, "app.log"), `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
    sh(["init", "-q", "-b", "main"]);
    sh(["add", "."]);
    sh(["commit", "-q", "-m", "first"]);
    firstSha = sh(["rev-parse", "HEAD"]);
    sh(["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo, "a.ts"), TS_SOURCE.replace("return a + b;", "return a + b + 0;"));
    sh(["commit", "-q", "-am", "second"]);
    writeFileSync(join(repo, "a.ts"), TS_SOURCE.replace("return a + b;", "return a + b + 1;"));
});

async function one(text: string, extra: { run?: TransclusionRunner; fetch?: typeof fetch; assetDir?: string } = {}) {
    const result = await transclude(text, { registry, cwd: repo, ...extra });
    return { text: result.text, token: result.tokens[0] };
}

describe("file kinds", () => {
    test("lines from the working tree record HEAD and the dirty flag", async () => {
        const { text, token } = await one('{{lines path="a.ts" range="4-6"}}');
        expect(token.ok).toBe(true);
        expect(text).toContain("return a + b + 1;");
        expect(text).toContain("uncommitted changes");
        expect(token.meta).toMatchObject({ source: "worktree", repoPath: "a.ts", dirty: true, lines: "4-6" });
    });

    test("commit= pins the lines to that commit", async () => {
        const { text, token } = await one(`{{lines path="a.ts" range="4-6" commit="${firstSha.slice(0, 8)}"}}`);
        expect(text).toContain("return a + b;");
        expect(token.meta).toMatchObject({ source: "commit", sha: firstSha });
    });

    test("the mdBook include forms resolve, anchor included", async () => {
        expect((await one("{{#include a.ts:4:4}}")).text).toContain("export function add");
        const anchored = await one("{{#include a.ts:setup}}");
        expect(anchored.text).toContain("const ready = true;");
        expect(anchored.text).not.toContain("ANCHOR");
    });

    test("failures name the file and the reason", async () => {
        expect((await one('{{lines path="missing.ts" range="1"}}')).token.error).toBe(
            `file not found: ${join(repo, "missing.ts")}`
        );
        expect((await one('{{lines path="a.ts" range="900-910"}}')).token.error).toContain("starts past the end of");
        expect((await one('{{lines path="a.ts" range="1" commit="nope123"}}')).token.error).toContain(
            'unknown commit "nope123"'
        );
    });

    test("file cuts after max lines with a note", async () => {
        const { text, token } = await one('{{file path="app.log" max=3}}');
        expect(text).toContain("line 3\n```\n_↳ captured ");
        expect(text).toContain("· app.log@HEAD ");
        expect(text).toContain('· showing 3 of 30 lines · re-check: `{{file path="app.log" max=3}}`_');
        expect(token.meta).toMatchObject({ lines: 30, shown: 3 });
    });

    test("tail reads the last n lines", async () => {
        const { text } = await one('{{tail path="app.log" n=2}}');
        expect(text).toContain("line 29\nline 30");
        expect(text).not.toContain("line 28");
    });

    test("json follows a JSON pointer or a $ path in a commented file", async () => {
        expect((await one('{{json path="data.json" pointer="/scripts/test"}}')).text).toContain('"bun test"');
        expect((await one('{{json path="data.json" pointer="$.list[1]"}}')).text).toContain("\n2\n");
        expect((await one('{{json path="data.json" pointer="/scripts/lint"}}')).token.error).toBe(
            'pointer "/scripts/lint": "lint" missing in /scripts (keys: test)'
        );
        expect(pointerSegments('$["a b"].c[0]')).toEqual(["a b", "c", "0"]);
        expect(pointerSegments("/a~1b/~0c")).toEqual(["a/b", "~c"]);
        expect(pointerSegments("/")).toEqual([""]);
        expect(pointerSegments("")).toEqual([]);
    });

    test("symbol reads TS declarations and members, and hints on a typo", async () => {
        expect((await one('{{symbol path="a.ts" name="add"}}')).text).toContain("/** Adds. */\nexport function add");
        const member = await one('{{symbol path="a.ts" name="Box.grow"}}');
        expect(member.text).toContain("grow(by: number): void {\n        this.size += by;\n    }");
        expect(member.token.meta).toMatchObject({ method: "typescript", lines: "11-13" });
        expect((await one('{{symbol path="a.ts" name="ad"}}')).token.error).toContain("(did you mean add?)");
    });

    test("the symbol heuristic handles braces and Python indentation", () => {
        const swift = ["struct A {", "    func run() {", "        if x { y() }", "    }", "}"];
        expect(heuristicSymbol(swift, "run")).toEqual({ name: "run", start: 2, end: 4 });
        const python = [
            "class A:",
            "    def run(self):",
            "        a = 1",
            "",
            "        return a",
            "    def other(self):",
        ];
        expect(heuristicSymbol(python, "run")).toEqual({ name: "run", start: 2, end: 5 });
    });

    test("diff defaults to the merge-base with the default branch", async () => {
        const { text, token } = await one('{{diff path="a.ts"}}');
        expect(text).toContain("-    return a + b;\n+    return a + b + 1;");
        expect(text).toContain("against the main merge-base");
        expect(token.meta).toMatchObject({ base: firstSha, staged: false, path: "a.ts" });
        expect((await one('{{diff path="a.ts" staged=true}}')).text).toContain(
            "_No changes in `a.ts` (staged changes)._"
        );
    });

    test("diff base= names a commit, never a git option", async () => {
        const target = join(repo, "written-by-diff.txt");
        const option = await one(`{{diff base="--output=${target}"}}`);
        expect(option.token.error).toContain("is not a commit");
        expect(existsSync(target)).toBe(false);
        expect((await one(`{{diff path="a.ts" base="${firstSha}"}}`)).token.meta).toMatchObject({ base: firstSha });
    });

    test("image copies into the asset store once and embeds it", async () => {
        writeFileSync(join(repo, "shot.png"), "not really a png");
        const assetDir = join(repo, ".assets");
        const { text, token } = await one('{{image path="shot.png" alt="Shot"}}', { assetDir });
        const stored = String(token.meta?.stored);
        expect(text).toBe(`![Shot](${encodeURI(stored)})`);
        expect(existsSync(stored)).toBe(true);
        expect((await one('{{image path="shot.png"}}')).token.error).toBe(
            "image needs an asset store, and this caller configured none"
        );
        expect((await one('{{image path="a.ts"}}', { assetDir })).token.error).toContain("a.ts is not an image");
    });
});

describe("cmd", () => {
    test("runs an allowlisted command and shows the exit code", async () => {
        const { text, token } = await one('{{cmd run="git log --oneline -1 --format=%s"}}');
        expect(text).toContain("`$ git log --oneline -1 --format=%s` · exit 0");
        expect(text).toContain("second");
        expect(token.meta).toMatchObject({ exit: 0 });
    });

    test("refuses shells and writers", () => {
        expect(() => splitCommandLine("git log | head")).toThrow('"|" is not allowed outside quotes');
        expect(splitCommandLine(`git log --grep "a | b" 'c d'`)).toEqual(["git", "log", "--grep", "a | b", "c d"]);
        expect(() => checkAllowed(["git", "push"])).toThrow('"git push" is not on the read-only list');
        expect(() => checkAllowed(["git", "-c", "core.pager=x", "log"])).toThrow(
            '"git -c" is not on the read-only list'
        );
        expect(() => checkAllowed(["git", "diff", "--output=/tmp/x"])).toThrow('git flag "--output=/tmp/x"');
        expect(() => checkAllowed(["rm", "-rf"])).toThrow('cmd: "rm" is not allowed');
        expect(() => checkAllowed(["tools", "ts", "skeleton", "a.ts"])).not.toThrow();
        expect(() => checkAllowed(["tools", "git", "merged", "--json", "--base=origin/master"])).not.toThrow();
        expect(() => checkAllowed(["tools", "git", "merged", "feat/x", "--prune"])).toThrow(
            '"tools git merged" does not take "--prune"'
        );
        expect(() => checkAllowed(["tools", "git", "merged", "--yes"])).toThrow('does not take "--yes"');
    });
});

describe("network kinds", () => {
    test("url summarizes a page with a fake fetch", async () => {
        const html =
            '<html><head><title>Ignored</title><meta property="og:title" content="The &amp; Title"></head>' +
            "<body><nav>menu</nav><p>short</p><p>This paragraph is long enough to be the excerpt of the page.</p></body></html>";
        const fakeFetch = (async () =>
            new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
        const { text, token } = await one('{{url url="https://example.test/page"}}', { fetch: fakeFetch });
        expect(text).toContain("> **[The & Title](https://example.test/page)**");
        expect(text).toContain("> This paragraph is long enough");
        expect(token.meta).toMatchObject({ status: 200 });
        expect(summarizeHtml('<meta name="description" content="Desc">').excerpt).toBe("Desc");
    });

    test("url reports an HTTP failure", async () => {
        const fakeFetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
        expect((await one('{{url url="https://example.test/x"}}', { fetch: fakeFetch })).token.error).toBe(
            "HTTP 404 from https://example.test/x"
        );
    });

    test("pr-thread renders a review thread through gh api", async () => {
        const calls: string[][] = [];
        const replies: Record<string, unknown> = {
            "repos/acme/widgets/pulls/7": {
                title: "Add [thing]",
                state: "open",
                user: { login: "alice" },
                html_url: "https://github.com/acme/widgets/pull/7",
            },
            "repos/acme/widgets/pulls/comments/11": {
                id: 11,
                path: "src/a.ts",
                line: 3,
                diff_hunk: "@@ -1 +1 @@\n-a\n+b",
                user: { login: "bob" },
                body: "Why b?",
            },
            "repos/acme/widgets/pulls/7/comments?per_page=100": [
                {
                    id: 11,
                    path: "src/a.ts",
                    line: 3,
                    diff_hunk: "@@ -1 +1 @@\n-a\n+b",
                    user: { login: "bob" },
                    body: "Why b?",
                },
                { id: 12, in_reply_to_id: 11, user: { login: "alice" }, body: "Because." },
                { id: 13, user: { login: "carol" }, body: "Other thread." },
            ],
        };
        const run: TransclusionRunner = async (argv) => {
            calls.push(argv);
            const reply = replies[argv[argv.length - 1]];
            return reply
                ? { code: 0, stdout: SafeJSON.stringify(reply), stderr: "" }
                : { code: 1, stdout: "", stderr: "HTTP 404" };
        };
        const { text, token } = await one('{{pr-thread url="https://github.com/acme/widgets/pull/7#discussion_r11"}}', {
            run,
        });
        expect(text).toContain(
            "**[PR acme/widgets#7: Add thing](https://github.com/acme/widgets/pull/7)** · open · @alice"
        );
        expect(text).toContain("`src/a.ts:3`");
        expect(text).toContain("> **@bob**");
        expect(text).toContain("> Because.");
        expect(text).not.toContain("Other thread.");
        expect(token.meta).toMatchObject({ kind: "review-comment", comments: 2 });
        expect(calls.every((argv) => argv[0] === "gh" && argv[1] === "api")).toBe(true);
    });

    test("comment references", () => {
        expect(parseCommentRef("discussion_r5")).toEqual({ kind: "review-comment", id: "5" });
        expect(parseCommentRef("issuecomment-6")).toEqual({ kind: "issue-comment", id: "6" });
        expect(parseCommentRef("note_7")).toEqual({ kind: "note", id: "7" });
        expect(parseCommentRef("8")).toEqual({ kind: "any", id: "8" });
        expect(parseCommentRef("x")).toBeNull();
    });
});

describe("folders", () => {
    test("a folder is refused with a reason", async () => {
        mkdirSync(join(repo, "dir"), { recursive: true });
        expect((await one('{{file path="dir"}}')).token.error).toBe(`${join(repo, "dir")} is a folder, not a file`);
    });
});
