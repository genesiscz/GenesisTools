import type { On, TurnStepChunk } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { agentsBand, factsOf, forgetAgentDetails, lastSaidOf, refreshAgentDetails } from "../hooks/agents-band";
import {
    answersFrom,
    answersOf,
    callFor,
    firstAsks,
    forgetAnswers,
    pollAnswers,
    questionCalls,
    refreshAnswers,
    sendStaged,
} from "../hooks/answers";
import { quoteOf } from "../hooks/ask-row";
import { cacheBand, cacheRowsOf, cacheTone, markEnded } from "../hooks/cache-band";
import {
    addCheckout,
    addedCheckouts,
    folderSuggestions,
    forgetCheckouts,
    gitWriteDirs,
    gitWrites,
    headOf,
    hideCheckout,
    noteToolCall,
    pickRoots,
    rankByName,
    removeAdded,
    sessionCheckouts,
    writtenFiles,
} from "../hooks/checkouts";
import {
    chatDecisions,
    decisions,
    editAnswer,
    openDecisions,
    sendDecisionAnswers,
    shownDecisions,
    stagedMessage,
    stagedText,
    typedAnswer,
} from "../hooks/decisions";
import { finderLink, forgetGenesisProbe, type GenesisProbe, genesisProbe, mdLink, probeOf } from "../hooks/genesis";
import {
    checkCounts,
    checksOf,
    fitLabels,
    gitBand,
    hubUrlOf,
    labelOf,
    middleCut,
    namesCheckouts,
    parseNumstat,
    parseStatus,
    prChecksOf,
    refresh as refreshGit,
    toggle as toggleGit,
    wordingFor,
} from "../hooks/git-band";
import { dedupeEntry, ledgerOf, tokensText } from "../hooks/hook-ledger";
import { idleDueAt, publishIdleDue, setIdleDueAt } from "../hooks/idle";
import { inbox } from "../hooks/inbox";
import { linkLine, takeLinkedPullRequestNote, targetFor } from "../hooks/links";
import { forgetLive, liveAgo, liveDue, liveLeft, liveSince } from "../hooks/live";
import { bareDescription } from "../hooks/model-label";
import { modsSettings } from "../hooks/settings";
import { afterTools, forgetSettings, type Host, isRecord } from "../hooks/shared";
import { toolLabel } from "../hooks/spinner";
import {
    checkStall,
    clearStall,
    continueText,
    lastSentence,
    noteStop,
    pressStall,
    stallCatcher,
    stallNow,
    stallSentence,
} from "../hooks/stall";
import { lockedToSession, samePath, sessionTotalKb, statusOf } from "../hooks/tmp-usage";

/** A Mac where every GenesisTools link opens, on an invented link host. */
const ALL_LINKS: GenesisProbe = {
    tools: true,
    linkHost: "links.example.test",
    opens: { md: true, finder: true, hub: true, "claude-find": true },
};
/** A Mac with neither the GenesisTools CLI nor its app. */
const NO_LINKS: GenesisProbe = {
    tools: false,
    linkHost: null,
    opens: { md: false, finder: false, hub: false, "claude-find": false },
};

// Run with `claude plugin test plugins/genesis-tools-mods`. The pure parts of each feature first, then the link
// fixer end to end over a streamed reply.

test("open decisions: asked, minus answered and replaced, with their options", async () => {
    const list = openDecisions([
        {
            role: "assistant",
            text: "❓ DECISION 3: colour step\n**a)** plugin\n**b)** highlight.js\n\n❓ DECISION 4 merge?\na) now\nb) later",
        },
        { role: "user", text: "D3: b)" },
        { role: "assistant", text: "Repeat of [❓ DECISION 4](https://x) stays open.\n❓ DECISION 5 name\na) one" },
        { role: "assistant", text: "❓ DECISION 6 replaces ❓ DECISION 5\na) two" },
    ]);

    expect(list.map((decision) => decision.n)).toEqual([4, 6]);
    expect(list[0]?.options).toEqual([
        { letter: "a", text: "now" },
        { letter: "b", text: "later" },
    ]);
    expect(stagedMessage({ "6": "a)", "4": "my own words" })).toBe("D4: my own words\nD6: a)");
});

test("decisions sidebar: the log's states, chat asks the log lacks, and a chat answer the log has not recorded", async () => {
    const logged = answersFrom(
        JSON.stringify({
            sessionId: "s-alpha",
            decisions: [
                {
                    number: 2,
                    title: "Keep the cache?",
                    prompt: "The cache is warm.",
                    status: "waiting",
                    choices: [
                        { id: "a", label: "a) keep it", recommended: true },
                        { id: "b", label: "drop it", recommended: false },
                    ],
                    recommended: "a",
                    option: null,
                    answer: null,
                    at: "2026-03-01T10:00:00.000Z",
                },
                { number: 1, title: "Old", prompt: "", status: "implemented", choices: [], option: "b", at: "x" },
                {
                    number: 4,
                    title: "Staged",
                    prompt: "",
                    status: "drafted",
                    choices: [],
                    draftOption: "b",
                    draft: "and why",
                },
                { number: 3, title: "Odd", prompt: "", status: "no-such-state", choices: [] },
            ],
            todos: [{ number: 1, title: "Rename the flag", state: "open", at: "2026-03-01T09:00:00.000Z" }],
            entries: [
                { id: "e1", ts: 1000, tag: "message", question: "Done", answerMd: "All green", readAt: 5 },
                {
                    id: "e2",
                    ts: 2000,
                    tag: "directive",
                    question: "Why?",
                    answerMd: "Because",
                    readAt: null,
                    attachments: [{ type: "image", path: "/tmp/shot.png" }],
                },
            ],
            forms: [{ id: "ask_1", at: "2026-03-01T09:30:00.000Z", questions: [{ prompt: "Ship it?" }] }],
        }),
        42
    );

    expect(answersFrom("not json")).toBeUndefined();
    expect(answersFrom(JSON.stringify({ sessionId: "s" }))).toBeUndefined();
    expect(logged?.decisions.map((d) => [d.n, d.status, d.options.map((o) => o.text)])).toEqual([
        [2, "waiting", ["keep it", "drop it"]],
        [1, "implemented", []],
        [4, "drafted", []],
        [3, "waiting", []],
    ]);
    expect(logged?.decisions[1]?.at).toBe(0);
    // The store owns staging: a drafted decision carries its pick and note, and reads as one answer.
    expect(stagedText(logged?.decisions[2] ?? {})).toBe("b) and why");
    expect(stagedText({ draft: "own words" })).toBe("own words");
    expect(stagedText({})).toBe("");
    // Newest entry first; an entry nobody read is new; image attachments keep their paths.
    expect(logged?.entries.map((e) => [e.id, e.isUnread, e.images])).toEqual([
        ["e2", true, ["/tmp/shot.png"]],
        ["e1", false, []],
    ]);
    expect(logged?.forms).toEqual([{ id: "ask_1", at: Date.parse("2026-03-01T09:30:00.000Z"), prompts: ["Ship it?"] }]);

    const chat = chatDecisions([
        { role: "assistant", text: "❓ DECISION 5 name it?\na) one\nb) two" },
        { role: "user", text: "D2: a)" },
    ]);
    const shown = shownDecisions(logged?.decisions ?? [], chat);

    expect(shown.map((d) => [d.n, d.status])).toEqual([
        [1, "implemented"],
        [2, "chat-answered"],
        [3, "waiting"],
        [4, "drafted"],
        [5, "waiting"],
    ]);
    expect(shown[4]?.options.map((o) => o.letter)).toEqual(["a", "b"]);
});

test("jump to: a decision's first ask is its first unlinked ask in the transcript; an entry's row is the call before it", async () => {
    const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
    const lines = [
        line({ type: "user", uuid: "u1", message: { content: [{ type: "text", text: "❓ DECISION 1 in a prompt" }] } }),
        line({
            type: "assistant",
            uuid: "a1",
            message: { content: [{ type: "text", text: "Repeat [❓ DECISION 7](x)" }] },
        }),
        line({
            type: "assistant",
            uuid: "a2",
            message: { content: [{ type: "text", text: "❓ **DECISION 7** pick\n❓ DECISION 8" }] },
        }),
        line({
            type: "assistant",
            uuid: "a3",
            message: { content: [{ type: "text", text: "❓ DECISION 7 asked again" }] },
        }),
        line({
            type: "assistant",
            uuid: "a4",
            timestamp: "2026-03-01T10:00:00.000Z",
            message: {
                content: [{ type: "tool_use", id: "toolu_send", name: "mcp__genesis-tools__inbox_send", input: {} }],
            },
        }),
        line({
            type: "assistant",
            uuid: "a5",
            timestamp: "2026-03-01T10:05:00.000Z",
            message: {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_bash",
                        name: "Bash",
                        input: { command: "tools question message hi" },
                    },
                ],
            },
        }),
        line({
            type: "assistant",
            uuid: "a6",
            timestamp: "2026-03-01T10:06:00.000Z",
            message: { content: [{ type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls" } }] },
        }),
        "{torn line",
    ];

    expect([...firstAsks(lines)]).toEqual([
        [7, "a2"],
        [8, "a2"],
    ]);

    const calls = questionCalls(lines);
    const at = Date.parse("2026-03-01T10:00:00.000Z");

    expect(calls.map((call) => call.id)).toEqual(["toolu_send", "toolu_bash"]);
    expect(callFor(at + 2_000, calls)).toBe("toolu_send");
    expect(callFor(at + 5 * 60_000 + 1_000, calls)).toBe("toolu_bash");
    // Recorded before any call, or long after the last one: no row.
    expect(callFor(at - 60_000, calls)).toBeUndefined();
    expect(callFor(at + 60 * 60_000, calls)).toBeUndefined();
});

test("git band: status line and CI counts", async () => {
    expect(parseStatus("## feat/x...origin/feat/x [ahead 2, behind 1]\n M a.ts\n?? b.ts\n")).toEqual({
        branch: "feat/x",
        ahead: 2,
        behind: 1,
        dirty: 2,
    });
    expect(parseStatus("## HEAD (no branch)\n").branch).toBe("detached");
    expect(parseNumstat("12\t3\ta.ts\n-\t-\tlogo.png\n0\t9\tb.ts\n")).toEqual({ added: 12, removed: 12 });
    expect(parseNumstat("")).toEqual({ added: 0, removed: 0 });
    expect(middleCut("feat/2026-10-13-enhancements-unified", 30)).toBe("feat/2026-10-13…ements-unified");
    expect(middleCut("main", 30)).toBe("main");
    expect(
        checkCounts([
            { conclusion: "SUCCESS" },
            { conclusion: "FAILURE" },
            { state: "PENDING" },
            { conclusion: "", status: "IN_PROGRESS" },
            { state: "SUCCESS" },
        ])
    ).toEqual({ passed: 2, failed: 1, pending: 2 });
    expect(
        checksOf([
            { name: "lint", conclusion: "FAILURE", detailsUrl: "https://ci.example.test/run/1" },
            { context: "ci/deploy", state: "PENDING", targetUrl: "https://deploy.example.test/2" },
        ])
    ).toEqual([
        { name: "lint", verdict: "fail", description: "", link: "https://ci.example.test/run/1" },
        { name: "ci/deploy", verdict: "pending", description: "", link: "https://deploy.example.test/2" },
    ]);
    // `gh pr checks` carries the status's own words, which the rollup leaves out.
    expect(
        prChecksOf(
            JSON.stringify([
                { bucket: "pass", description: "", link: "https://ci.example.test/3", name: "Tests" },
                {
                    bucket: "fail",
                    description: "Deployment was blocked",
                    link: "https://deploy.example.test/4",
                    name: "Deploy",
                },
                { bucket: "cancel", description: "", link: "", name: "Lint" },
            ])
        )
    ).toEqual([
        { name: "Tests", verdict: "pass", description: "", link: "https://ci.example.test/3" },
        {
            name: "Deploy",
            verdict: "fail",
            description: "Deployment was blocked",
            link: "https://deploy.example.test/4",
        },
        { name: "Lint", verdict: "fail", description: "", link: "" },
    ]);
    expect(prChecksOf("no checks reported on the 'x' branch")).toBeUndefined();
    expect(hubUrlOf(ALL_LINKS, { url: "https://github.com/acme/widgets/pull/42", number: 42 })).toBe(
        "https://links.example.test/hub?pr=acme%2Fwidgets%2342"
    );
    expect(hubUrlOf(NO_LINKS, { url: "https://github.com/acme/widgets/pull/42", number: 42 })).toBeUndefined();
    expect(
        hubUrlOf(ALL_LINKS, { url: "https://gitlab.example.com/a/b/-/merge_requests/3", number: 3 })
    ).toBeUndefined();
});

test("git band: the checkouts a command or an edit works in", async () => {
    expect(gitWriteDirs("cd /work/wt-a && git commit -m x", "/home/test")).toEqual(["/work/wt-a"]);
    expect(gitWriteDirs("git -C ~/wt-b rebase origin/main", "/home/test")).toEqual(["/home/test/wt-b"]);
    expect(gitWriteDirs('cd "/work/a b"; git -c core.x=1 stash pop', "/home/test")).toEqual(["/work/a b"]);
    // Read-only git, and git with no folder this hook can know, count nothing.
    expect(gitWriteDirs("git -C /work/wt-a status && git -C /work/wt-a log -3", "/home/test")).toEqual([]);
    expect(gitWriteDirs("git commit -m x", "/home/test")).toEqual([]);
    // A folder in a variable the command set before counts; one it did not set, or set only for one command, does not.
    expect(
        gitWriteDirs('S=/tmp/cc/p/s\nW=$S/worktrees/audit\ngit -C "$W" switch -c fix/x origin/main', "/home/test")
    ).toEqual(["/tmp/cc/p/s/worktrees/audit"]);
    expect(gitWriteDirs('export W=~/wt-c; cd "${W}" && git commit -m x', "/home/test")).toEqual(["/home/test/wt-c"]);
    expect(gitWriteDirs('git -C "$NOPE" commit -m x', "/home/test")).toEqual([]);
    expect(gitWriteDirs('W=/work/x git -C "$W" commit -m x', "/home/test")).toEqual([]);
    expect(gitWriteDirs("W=/work/x; git -C '$W' commit -m x", "/home/test")).toEqual([]);
    // `git worktree add` counts the new worktree, relative paths resolved against the folder the command is in.
    expect(gitWrites("git -C /work/main worktree add --no-track -b feat/y ../wt-y origin/main", "/home/test")).toEqual([
        { dir: "/work/wt-y", branches: ["feat/y"] },
    ]);
    expect(gitWrites("git -C /work/main worktree add --detach /work/base origin/main", "/home/test")).toEqual([
        { dir: "/work/base", branches: [] },
    ]);
    // The branches a command makes or pushes; HEAD, tags and a delete name none.
    expect(
        gitWrites(
            "cd /work/main && git switch -c fix/a && git push -u origin fix/a HEAD:fix/b +refs/heads/fix/c",
            "/home/test"
        )
    ).toEqual([{ dir: "/work/main", branches: ["fix/a", "fix/b", "fix/c"] }]);
    expect(gitWrites("git -C /work/main push origin --delete fix/a", "/home/test")).toEqual([
        { dir: "/work/main", branches: [] },
    ]);
    expect(gitWrites("git -C /work/main push origin HEAD v1.0:refs/tags/v1.0", "/home/test")).toEqual([
        { dir: "/work/main", branches: [] },
    ]);
    expect(writtenFiles({ tool: "Edit", file_path: "/work/wt-a/x.ts" })).toEqual(["/work/wt-a/x.ts"]);
    expect(writtenFiles({ tool: "Read", file_path: "/work/wt-a/x.ts" })).toEqual([]);

    const touches = [
        { root: "/work/wt-b", at: 2 },
        { root: "/work/wt-a", at: 1 },
    ];
    expect(pickRoots(touches, "/work/main", { checkouts: 3, cwd: "touched" })).toEqual(["/work/wt-b", "/work/wt-a"]);
    expect(pickRoots(touches, "/work/main", { checkouts: 1, cwd: "touched" })).toEqual(["/work/wt-b"]);
    expect(pickRoots(touches, "/work/main", { checkouts: 3, cwd: "always" })).toEqual([
        "/work/main",
        "/work/wt-b",
        "/work/wt-a",
    ]);
    expect(pickRoots([], "/work/main", { checkouts: 3, cwd: "touched" })).toEqual(["/work/main"]);
    expect(fitLabels("shop-tools", "main", 40)).toEqual({ name: "shop-tools", branch: "main" });
    // A linked worktree is named with its main checkout; a main checkout or a separate clone by its folder.
    const worktree = { root: "/tmp/cc/shop/s1/worktrees/enhancements", repo: "/work/shop" };
    expect(labelOf(worktree, "repo-folder")).toBe("shop/enhancements");
    expect(labelOf(worktree, "repo")).toBe("shop");
    expect(labelOf(worktree, "folder")).toBe("enhancements");
    expect(labelOf({ root: "/work/shop", repo: "/work/shop" }, "repo-folder")).toBe("shop");
    expect(labelOf({ root: "/work/shop-poc" }, "repo-folder")).toBe("shop-poc");
    // 30 columns: the name keeps 40% (12), the branch the other 18, each its start and end.
    expect(fitLabels("acme-marketplace-2.0-foundation", "feat/2026-10-13-enhancements-unified", 30)).toEqual({
        name: "acme-m…ation",
        branch: "feat/2026…-unified",
    });
    expect(fitLabels(undefined, "feat/2026-10-13-enhancements-unified", 20).branch).toBe("feat/2026-…s-unified");
    const busy = {
        root: "/work/main",
        why: "folder" as const,
        at: 0,
        branch: "feat/2026-10-13-enhancements-unified",
        ahead: 27,
        behind: 2,
        dirty: 13,
        added: 862,
        removed: 125,
        prs: [],
    };
    // 110 columns hold the words; 55 hold the signs (↑27 ↓2 ●13 +862 −125) beside a cut branch.
    expect(wordingFor(busy, 110, false, true)).toBe("full");
    expect(wordingFor(busy, 55, false, true)).toBe("signs");
    expect(wordingFor(busy, 110, false, false)).toBe("signs");
    expect(namesCheckouts([{ root: "/work/main" }], "/work/main")).toBe(false);
    expect(namesCheckouts([{ root: "/work/wt-a" }], "/work/main")).toBe(true);
});

/**
 * A session started in /work/main that works in the worktrees /work/wt-a and /work/wt-b; its GenesisTools journal
 * also names a plan in the main checkout's ignored `.claude/plans/` and a scratch file outside every repository.
 * zoxide knows /home/test/code/playground (a checkout) and /home/test/notes (none); the git band is on.
 */
function checkoutHost(): Host {
    const store = new Map<string, unknown>();
    const repos = new Set(["/work/main/.git", "/work/wt-a/.git", "/work/wt-b/.git", "/home/test/code/playground/.git"]);
    const dirs = new Set(["/work/wt-a", "/home/test/code/playground", "/home/test/code/play-old", "/home/test/notes"]);
    const mtimes: Record<string, number> = {
        "/work/main/.claude/plans/p.md": 900,
        "/work/main/.claude/plans/p2.md": 950,
        "/work/wt-a/src/x.ts": 200,
        "/work/wt-b/y.ts": 300,
        "/tmp/scratch.py": 999,
    };
    const journal = JSON.stringify({ files: Object.keys(mtimes).filter((path) => !path.endsWith("p2.md")) });
    const done = (stdout: string, exitCode: number) => ({
        exitCode,
        stdout,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
    });

    return {
        async run(argv, init) {
            if (argv.join(" ") === "zoxide query --list") {
                // zoxide keeps the casing a `cd` typed: the same folder twice, and one folder that is gone.
                return done(
                    "/home/test/notes\n/home/test/code/playground\n/home/test/code/PlayGround\n/home/test/code/play-gone\n/home/test/code/play-old\n",
                    0
                );
            }

            if (argv[3] !== "check-ignore") {
                return done("", 1);
            }

            const ignored = String(init?.stdin ?? "")
                .split("\n")
                .filter((path) => path.includes("/.claude/plans/"));

            return ignored.length ? done(`${ignored.join("\n")}\n`, 0) : done("", 1);
        },
        async read(path) {
            if (path === "/home/test/.genesis-tools/claude-code/sessions/sess-1.json") {
                return journal;
            }

            if (path === "/home/test/.genesis-tools/agents/hooks.json") {
                return JSON.stringify({ mods: { git: { enabled: true } } });
            }

            throw new Error(`ENOENT ${path}`);
        },
        async write() {},
        async append() {},
        async list(path) {
            return [...dirs]
                .filter((dir) => dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes("/"))
                .map((dir) => ({
                    name: dir.slice(path.length + 1),
                    kind: "dir" as const,
                    size: 0,
                    mtimeMs: 0,
                    isLink: false,
                }));
        },
        async exists(path) {
            return repos.has(path);
        },
        async stat(path) {
            if (dirs.has(path)) {
                return { kind: "dir", size: 0, mtimeMs: 0, isLink: false };
            }

            const mtimeMs = mtimes[path];

            if (mtimeMs === undefined) {
                throw new Error(`ENOENT ${path}`);
            }

            return { kind: "file", size: 1, mtimeMs, isLink: false };
        },
        async env(name) {
            return name === "HOME" ? "/home/test" : undefined;
        },
        async cwd() {
            return "/work/main";
        },
        async sessionId() {
            return "sess-1";
        },
        async messages() {
            return [];
        },
        async agents() {
            return [];
        },
        every() {},
        async storeGet(key) {
            return store.get(key);
        },
        async storeSet(key, value) {
            store.set(key, value);
        },
        status() {},
        async fill() {},
        async submit() {},
        async openPane() {},
        async togglePane() {},
        async closePane() {},
        async copy() {
            return { isCopied: true };
        },
        async openUrl() {},
        async scroll() {
            return {};
        },
        toast() {},
        redraw() {},
    };
}

test("git band: a session in the main checkout that works in two worktrees shows the two worktrees", async () => {
    forgetCheckouts();
    const host = checkoutHost();
    const roots = async () => (await sessionCheckouts(host)).map((touch) => touch.root);

    // The journal's ignored plan and the scratch file outside every repository count nothing.
    expect(await roots()).toEqual(["/work/wt-b", "/work/wt-a"]);
    expect(await noteToolCall(host, { tool: "Write", file_path: "/work/main/.claude/plans/p2.md" })).toBe(false);
    expect(await noteToolCall(host, { tool: "Bash", command: "cd /work/wt-a && git commit -m x" })).toBe(true);
    expect(await roots()).toEqual(["/work/wt-a", "/work/wt-b"]);

    // A reload starts this module over; the store keeps the order, and the journal is not read again.
    forgetCheckouts();
    expect(await roots()).toEqual(["/work/wt-a", "/work/wt-b"]);

    // hide drops a worked-in checkout until the session works there again.
    await hideCheckout(host, "/work/wt-b");
    expect(await roots()).toEqual(["/work/wt-a"]);
});

test("git band: a worktree's main checkout and the branches the session worked on there", async () => {
    forgetCheckouts();
    const base = checkoutHost();
    // /work/wt-b is a linked worktree of /work/main: its `.git` is a file pointing into the main checkout's `.git`.
    const files: Record<string, string> = {
        "/work/wt-b/.git": "gitdir: /work/main/.git/worktrees/wt-b\n",
        "/work/main/.git/worktrees/wt-b/HEAD": "ref: refs/heads/fix/x\n",
    };
    const host: Host = {
        ...base,
        async stat(path) {
            return path in files ? { kind: "file", size: 1, mtimeMs: 0, isLink: false } : base.stat(path);
        },
        async read(path) {
            return files[path] ?? base.read(path);
        },
    };

    expect(await headOf(host, "/work/wt-b")).toEqual({ repo: "/work/main", branch: "fix/x" });
    expect(await headOf(host, "/work/wt-a")).toEqual({ repo: "/work/wt-a", branch: undefined });
    // wt-b is the newest checkout already (the journal), so the band's rows do not move.
    expect(await noteToolCall(host, { tool: "Bash", command: 'W=/work/wt-b\ngit -C "$W" commit -m x' })).toBe(false);
    expect((await sessionCheckouts(host))[0]).toMatchObject({
        root: "/work/wt-b",
        repo: "/work/main",
        branches: ["fix/x"],
    });

    // A push of another branch adds it; a later switch puts the checked-out branch first, and none is lost.
    await noteToolCall(host, { tool: "Bash", command: "cd /work/wt-b && git push origin HEAD:fix/y" });
    files["/work/main/.git/worktrees/wt-b/HEAD"] = "ref: refs/heads/fix/z\n";
    await noteToolCall(host, { tool: "Edit", file_path: "/work/wt-b/y.ts" });
    expect((await sessionCheckouts(host))[0]?.branches).toEqual(["fix/z", "fix/x", "fix/y"]);

    // A reload keeps them.
    forgetCheckouts();
    expect((await sessionCheckouts(host))[0]?.branches).toEqual(["fix/z", "fix/x", "fix/y"]);
});

test("git band: folders added by hand, and the folders proposed for them", async () => {
    forgetCheckouts();
    forgetSettings();
    const host = checkoutHost();

    expect(rankByName(["/a/old-play", "/a/notes", "/b/Playground", "/c/play/x"], "play")).toEqual([
        "/b/Playground",
        "/a/old-play",
        "/c/play/x",
    ]);
    // One row per folder, in its casing on disk, and none for a folder that is gone.
    expect(await folderSuggestions(host, "play")).toEqual([
        { path: "/home/test/code/playground", from: "zoxide", isGit: true },
        { path: "/home/test/code/play-old", from: "zoxide", isGit: false },
    ]);
    expect(await folderSuggestions(host, "~/code/pl")).toEqual([
        { path: "/home/test/code/play-old", from: "folder", isGit: false },
        { path: "/home/test/code/playground", from: "folder", isGit: true },
    ]);

    expect(await addCheckout(host, "~/notes")).toEqual({ error: "/home/test/notes is in no git checkout" });
    expect(await addCheckout(host, "~/nowhere")).toEqual({ error: "/home/test/nowhere is not a folder" });
    expect(await addCheckout(host, "~/code/playground")).toEqual({ root: "/home/test/code/playground" });
    expect(await addedCheckouts(host)).toEqual(["/home/test/code/playground"]);
    // Before the session works anywhere its own folder stays, then the added ones.
    expect(pickRoots([], "/work/main", { checkouts: 1, cwd: "touched" }, await addedCheckouts(host))).toEqual([
        "/work/main",
        "/home/test/code/playground",
    ]);
    // Added folders come first and do not count against `checkouts`.
    expect(
        pickRoots(
            [{ root: "/work/wt-a", at: 1 }],
            "/work/main",
            { checkouts: 1, cwd: "touched" },
            await addedCheckouts(host)
        )
    ).toEqual(["/home/test/code/playground", "/work/wt-a"]);

    const typed = "/mod-git add playg";
    const rows = await gitBand.autocomplete?.(host, { text: typed, cursor: typed.length, token: "playg", start: 13 });
    expect(rows).toEqual([
        { text: "/home/test/code/playground", label: "~/code/playground", description: "git checkout · zoxide" },
    ]);
    expect(await gitBand.autocomplete?.(host, { text: "playg", cursor: 5, token: "playg", start: 0 })).toEqual([]);

    expect(await removeAdded(host, "playground")).toBe("/home/test/code/playground");
    expect(await addedCheckouts(host)).toEqual([]);
});

test("agents sidebar: an agent's last words from its transcript's end, past a byte-cut first line", async () => {
    const row = (text: string) =>
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }, { type: "tool_use" }] } });
    const tail = [
        'cut": "half a row"}',
        row("Reading the tests."),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
        row("Found it: the timeout is 5 s."),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use" }] } }),
    ].join("\n");

    expect(lastSaidOf(tail)).toBe("Found it: the timeout is 5 s.");
    expect(lastSaidOf("")).toBe("");
    expect(bareDescription("(H) Sleeper one")).toBe("Sleeper one");
    expect(bareDescription("haiku-5-5 · Sleeper one")).toBe("Sleeper one");
    expect(bareDescription("Fix the (B) case")).toBe("Fix the (B) case");
});

test("hook ledger: a repeated entry and a repeated area block become receipts", async () => {
    const held = new Map<string, number>();
    const area = (path: string) => `Contents of ${path} (area rules):\n\n${"rule text ".repeat(40)}`;
    const first = `The Bash call touched files.\n\n${area("/r/a.md")}\n\n${area("/r/b.md")}`;

    expect(dedupeEntry(first, held, 1).dropped).toEqual([]);

    const second = dedupeEntry(`The Read call touched files.\n\n${area("/r/b.md")}\n\n${area("/r/c.md")}`, held, 2);
    expect(second.dropped).toEqual(["/r/b.md"]);
    expect(second.text).toContain("Contents of /r/c.md (area rules)");
    expect(second.text).toContain("area rules /r/b.md repeated");
    expect(second.droppedChars).toBeGreaterThan(300);

    const whole = dedupeEntry(first, held, 3);
    expect(whole.text.startsWith("[genesis-tools-mods:")).toBe(true);
    expect(dedupeEntry("short", new Map([["5:0", 1]]), 4).text).toBe("short");
    expect(tokensText(38_200 * 4)).toBe("~38.2k");

    const stored = { main: { fires: 2, chars: 90 }, agents: { fires: 0, chars: 0 }, dropped: { fires: 0, chars: 0 } };
    expect(ledgerOf({ ...stored, byEvent: { PostToolUse: { fires: 2, chars: 90 }, Bad: 3 } })).toEqual({
        ...stored,
        byEvent: { PostToolUse: { fires: 2, chars: 90 } },
    });
    expect(ledgerOf({ main: 1 })).toBeUndefined();
});

test("cache band: own row first, others only inside the warning window", async () => {
    const minute = 60_000;
    const now = 100 * minute;
    const marks = [
        { sessionId: "other-late", label: "b", lastAt: now - 55 * minute, ttlMs: 60 * minute },
        { sessionId: "own", label: "a", lastAt: now - 10 * minute, ttlMs: 60 * minute },
        { sessionId: "other-soon", label: "c", lastAt: now - 58 * minute, ttlMs: 60 * minute },
        { sessionId: "other-fresh", label: "d", lastAt: now - 5 * minute, ttlMs: 60 * minute },
        { sessionId: "other-ended", label: "e", lastAt: now - 58 * minute, ttlMs: 60 * minute, ended: true },
        { sessionId: "other-cold", label: "f", lastAt: now - 70 * minute, ttlMs: 60 * minute },
    ];

    expect(cacheRowsOf(marks, "own", 10 * minute, now).map((row) => row.sessionId)).toEqual([
        "own",
        "other-soon",
        "other-late",
    ]);

    // A compaction after the last turn: the own row says so, and another session gives no warning.
    const compacted = [
        { sessionId: "own", label: "a", lastAt: now - 50 * minute, ttlMs: 60 * minute, compactedAt: now - 2 * minute },
        { sessionId: "other", label: "b", lastAt: now - 55 * minute, ttlMs: 60 * minute, compactedAt: now - minute },
    ];
    expect(cacheRowsOf(compacted, "own", 10 * minute, now)).toEqual([
        {
            sessionId: "own",
            label: "a",
            expiresAt: now + 10 * minute,
            own: true,
            compacted: true,
            compactedAt: now - 2 * minute,
        },
    ]);

    // Dim above the caution window, yellow inside it, red inside the warning.
    expect(cacheTone(25 * minute, 10 * minute, 20 * minute)).toBeUndefined();
    expect(cacheTone(15 * minute, 10 * minute, 20 * minute)).toBe("yellow");
    expect(cacheTone(4 * minute, 10 * minute, 20 * minute)).toBe("red");
    // A caution under the warning means no yellow stage.
    expect(cacheTone(15 * minute, 10 * minute, 5 * minute)).toBeUndefined();
});

test("genesis probe: a run cut off by a newer render is not remembered", async () => {
    forgetGenesisProbe();
    let calls = 0;
    const json = JSON.stringify({
        router: { linkHost: "links.example.test" },
        links: { hub: { opens: true } },
    });
    const host: Host = {
        ...checkoutHost(),
        async run() {
            calls += 1;

            if (calls === 1) {
                throw new Error("HooksError: genesis-tools-mods: $.process.run(tools) aborted");
            }

            return { exitCode: 0, stdout: json, stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
        },
    };

    expect((await genesisProbe(host)).opens.hub).toBe(false);
    // The abort said nothing about this Mac: the next call runs the probe again and finds the hub.
    expect((await genesisProbe(host)).opens.hub).toBe(true);
    expect(calls).toBe(2);
    forgetGenesisProbe();
});

test("live times: the text, and when it next changes", async () => {
    const now = 1_000_000;

    forgetLive();
    expect(liveAgo(now - 14_250, { now })).toBe("14s ago");
    // "14s" reads "15s" in 750 ms.
    expect(liveDue()).toBe(now + 750);
    expect(liveSince(now - 125_000, now)).toBe("2m 05s");
    expect(liveLeft(now + 4 * 60_000 + 500, { now })).toBe("4m 00s");
    expect(liveDue()).toBe(now + 500);

    // Minutes only change once a minute, so a dim chip does not redraw every second.
    forgetLive();
    expect(liveLeft(now + 4 * 60_000 + 500, { now, unit: "minute" })).toBe("5m");
    expect(liveDue()).toBe(now + 500);
    forgetLive();
    expect(liveAgo(now - 3 * 60_000 - 1_000, { now, unit: "minute" })).toBe("3m ago");
    expect(liveDue()).toBe(now + 59_000);
});

test("ask quote and spinner label", async () => {
    expect(quoteOf([{ tool: "Bash", input: { command: "ls  -la" }, output: { stdout: "a\nb" } }])).toBe(
        "> Bash: ls -la\n> a\n> b\n\n"
    );
    expect(toolLabel("Bash", { command: "bun run test", description: "Run the suite" })).toBe("Bash Run the suite");
    expect(toolLabel("Read", {})).toBe("Read");
});

test("late usage cannot restore the countdown of a cancelled or superseded idle timer", async () => {
    setIdleDueAt(undefined);
    const old = {};
    let timer: object | undefined = old;
    for (const replacement of [undefined, {}]) {
        timer = old;
        let release!: (tokens: number) => void;
        const reading = publishIdleDue({
            current: () => timer === old,
            tokens: new Promise<number>((resolve) => {
                release = resolve;
            }),
            minTokens: 1,
            at: 100,
        });
        timer = replacement;
        setIdleDueAt(200);
        release(10);
        await reading;
        expect(idleDueAt()).toBe(200);
    }

    timer = old;
    await publishIdleDue({ current: () => timer === old, tokens: Promise.resolve(10), minTokens: 1, at: 300 });
    expect(idleDueAt()).toBe(300);
    await publishIdleDue({ current: () => timer === old, tokens: Promise.resolve(0), minTokens: 1, at: 400 });
    expect(idleDueAt()).toBeUndefined();
    setIdleDueAt(undefined);
});

test("post-tool bookkeeping returns immediately, preserves order, logs rejection and continues", async () => {
    const seen: string[] = [];
    let release!: () => void;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const base = checkoutHost();
    const host: Host = {
        ...base,
        async append(_path, line) {
            seen.push(line.includes("after-tool-failed") ? "logged" : "other");
        },
    };
    expect(
        afterTools({
            host,
            event: { tool: "Bash", tool_use_id: "toolu_post", command: "true" },
            features: [
                {
                    async afterTool() {
                        seen.push("first");
                        await new Promise<void>((resolve) => {
                            release = resolve;
                        });
                        throw new Error("disk failed");
                    },
                },
                {
                    async afterTool() {
                        seen.push("second");
                        finish();
                    },
                },
            ],
        })
    ).toBeUndefined();
    expect(seen).toEqual(["first"]);
    release();
    await finished;
    expect(seen).toEqual(["first", "logged", "second"]);
});

test("links: a bare PR number is linked in the folder's repository, and the model is told so", async () => {
    const base = checkoutHost();
    const host: Host = {
        ...base,
        async run(argv, init) {
            if (argv[0] === "gh" && argv[3] === "900") {
                return {
                    exitCode: 0,
                    stdout: JSON.stringify({
                        title: "Draft: fix the slot",
                        url: "https://github.com/acme/api/pull/900",
                    }),
                    stderr: "",
                    isStdoutTruncated: false,
                    isStderrTruncated: false,
                };
            }

            return base.run(argv, init);
        },
    };
    const ctx = {
        host,
        home: "/home/test",
        cwd: "/work/api",
        root: "/work/api",
        repo: "acme/api",
        sessionId: "s1",
        askedBefore: new Set<number>(),
        probe: ALL_LINKS,
        log: [],
    };

    expect(takeLinkedPullRequestNote()).toBeUndefined();
    expect(await linkLine(ctx, "see #900 and acme#901\n")).toBe(
        "see [#900 (fix the slot)](https://github.com/acme/api/pull/900) and acme#901\n"
    );
    const note = takeLinkedPullRequestNote() ?? "";
    expect(note).toContain("- #900 -> https://github.com/acme/api/pull/900 (fix the slot)");
    expect(note).toContain("to acme/api");
    // Taking the note clears it: the next turn says nothing unless it links a PR again.
    expect(takeLinkedPullRequestNote()).toBeUndefined();
});

test("link targets by kind, and only links this Mac opens", async () => {
    expect(targetFor(ALL_LINKS, "/r/My Notes/a.md", "file", 3, 9)).toBe(
        "https://links.example.test/md/open?path=/r/My%20Notes/a.md&range=3-9"
    );
    expect(targetFor(ALL_LINKS, "/r/src", "dir")).toBe("https://links.example.test/finder/reveal?target=/r/src");
    expect(targetFor(ALL_LINKS, "/r/src/a.ts", "file", 12)).toBe("cursor://file/r/src/a.ts:12");
    expect(targetFor(ALL_LINKS, "/r/src/a (1).ts", "file")).toBe("/r/src/a%20%281%29.ts");
    // No router: a note opens in the editor at its line, or by its path; a folder gets no link.
    expect(targetFor(NO_LINKS, "/r/My Notes/a.md", "file", 3, 9)).toBe("cursor://file/r/My%20Notes/a.md:3");
    expect(targetFor(NO_LINKS, "/r/My Notes/a.md", "file")).toBe("/r/My%20Notes/a.md");
    expect(targetFor(NO_LINKS, "/r/src", "dir")).toBeUndefined();
});

test("the probe out of tools genesis-tools probe --json", async () => {
    const opens = { opens: true };
    const json = JSON.stringify({
        router: { linkHost: "links.example.test" },
        links: { md: opens, finder: { opens: false }, hub: opens, "claude-find": opens },
    });

    expect(probeOf(json)).toEqual({
        tools: true,
        linkHost: "links.example.test",
        opens: { md: true, finder: false, hub: true, "claude-find": true },
    });
    // No link host: nothing opens, whatever the rows say.
    expect(probeOf(JSON.stringify({ router: {}, links: { md: opens } }))?.opens.md).toBe(false);
    expect(probeOf("Usage: genesis-tools [options]")).toBeUndefined();
});

/**
 * The machine beneath the plugin: a repository at /repo with three paths and one commit, and GenesisTools with
 * every link kind working (`links: "all"`) or not installed at all (`"none"`).
 */
function machine({
    on,
    links = "all",
    remote = "git@github.com:acme/widgets.git\n",
    title = "feat: widgets",
}: {
    on: On;
    links?: "all" | "none";
    remote?: string;
    title?: string;
}): void {
    forgetGenesisProbe();
    mock.env(on, { HOME: "/home/test" });
    const files: Record<string, "file" | "dir"> = {
        "/repo/src/a.ts": "file",
        "/repo/docs": "dir",
        "/repo/notes/plan.md": "file",
    };

    // Every mod past the full diff starts off; the link fixer is turned on through the hooks file.
    on("fs.read", async (_$, e) => {
        if (e.path === "/home/test/.genesis-tools/agents/hooks.json") {
            return { value: JSON.stringify({ mods: { links: { enabled: true }, decisions: { enabled: true } } }) };
        }

        throw new Error("no file");
    });
    on("fs.stat", async (_$, e) => {
        const kind = files[e.path];

        if (!kind) {
            throw new Error(`ENOENT ${e.path}`);
        }

        return { value: { kind, size: 1, mtimeMs: 1, isLink: false } };
    });
    on("session.cwd", async () => ({ value: "/repo" }));
    on("session.id", async () => ({ value: "sess-1" }));
    on("session.messages", async () => ({
        // The second message is this reply itself, past the request's `messageCount` of 1: it asks nothing earlier.
        value: [
            { role: "assistant", text: "❓ DECISION 3 pick one\na) x", toolUses: [] },
            { role: "assistant", text: "not ❓ DECISION 9.", toolUses: [] },
        ],
    }));
    on("process.run", async (_$, e) => {
        const argv = e.argv.join(" ");
        const answer = (stdout: string, exitCode = 0) => ({
            value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
        });

        if (argv === "tools genesis-tools probe --json") {
            if (links === "none") {
                throw new Error("spawn tools ENOENT");
            }

            const opens = { opens: true };
            return answer(
                JSON.stringify({
                    router: { linkHost: "links.example.test" },
                    links: { md: opens, finder: opens, hub: opens, "claude-find": opens },
                })
            );
        }

        if (argv.endsWith("rev-parse --show-toplevel")) {
            return answer("/repo\n");
        }

        if (argv.endsWith("remote get-url origin")) {
            return answer(remote);
        }

        if (argv.endsWith("pr view 42 --json title,url")) {
            return answer(JSON.stringify({ title, url: "https://github.com/acme/widgets/pull/42" }));
        }

        if (argv.endsWith("cat-file -t abc1234f")) {
            return answer("commit\n");
        }

        if (argv.includes("/mods-log/")) {
            return answer("");
        }

        return answer("", 1);
    });
    on("turn.step", async function* () {
        yield { kind: "text", index: 0, text: "See src/a.ts:12 and `docs/` and **abc1" };
        yield {
            kind: "text",
            index: 0,
            text: "234f**.\nRepeat ❓ DECISION 3 now, not ❓ DECISION 9.\n```\nsrc/a.ts\n```\n",
        };
        yield {
            kind: "text",
            index: 0,
            text: "Already [a](src/a.ts), https://b.c/src/a.ts#9, missing/x.ts, notes/plan.md, PR #42, #43",
        };
        yield { kind: "stop", stopReason: "end_turn", usage: null };

        return { turnId: "t1", index: 0, answer: "", toolUses: [], stopReason: "end_turn", usage: null };
    });
}

test("the link fixer links what resolves, as the reply streams, and leaves the rest", async ($, on) => {
    machine({ on });

    const stream = $.turn.step({ turnId: "t1", index: 0, model: "claude-haiku-5-5", messageCount: 1 });
    const chunks: TurnStepChunk[] = [];

    for await (const chunk of stream) {
        chunks.push(chunk);
    }

    const text = chunks.map((chunk) => (chunk.kind === "text" ? chunk.text : "")).join("");

    expect(text).toBe(
        [
            "See [src/a.ts:12](cursor://file/repo/src/a.ts:12) and [docs/](https://links.example.test/finder/reveal?target=/repo/docs) and [**abc1234f**](https://links.example.test/hub?repo=acme%2Fwidgets&commit=abc1234f).",
            "Repeat [❓ DECISION 3](https://links.example.test/claude/find/sess-1/decision/3) now, not ❓ DECISION 9.",
            "```",
            "src/a.ts",
            "```",
            "Already [a](src/a.ts), https://b.c/src/a.ts#9, missing/x.ts, [notes/plan.md](https://links.example.test/md/open?path=/repo/notes/plan.md), PR [#42 (feat: widgets)](https://github.com/acme/widgets/pull/42), #43",
        ].join("\n")
    );
    expect(chunks.at(-1)?.kind).toBe("stop");
});

test("without GenesisTools the link fixer writes no genesis.tools link", async ($, on) => {
    machine({ on, links: "none" });

    const stream = $.turn.step({ turnId: "t1", index: 0, model: "claude-haiku-5-5", messageCount: 1 });
    let text = "";

    for await (const chunk of stream) {
        text += chunk.kind === "text" ? chunk.text : "";
    }

    expect(text).not.toContain("links.example.test");
    expect(text).toContain("[src/a.ts:12](cursor://file/repo/src/a.ts:12) and `docs/` and **abc1234f**.");
    expect(text).toContain("Repeat ❓ DECISION 3 now");
    expect(text).toContain("[notes/plan.md](/repo/notes/plan.md)");
});

test("PR titles stay inside their label and dotted GitHub repository names produce hub links", async ($, on) => {
    machine({ on, remote: "https://github.com/acme/next.js.git\n", title: "x](https://attacker.example) [y\\z" });
    let text = "";
    for await (const chunk of $.turn.step({ turnId: "t1", index: 0, model: "claude-haiku-5-5", messageCount: 1 })) {
        text += chunk.kind === "text" ? chunk.text : "";
    }
    expect(text).toContain("[#42 (x\\](https://attacker.example) \\[y\\\\z)](https://github.com/acme/widgets/pull/42)");
    expect(text).toContain("hub?repo=acme%2Fnext.js&commit=abc1234f");
});

test("SSH origins retain dots in the repository name", async ($, on) => {
    machine({ on, remote: "git@github.com:acme/next.js.git\n" });
    let text = "";
    for await (const chunk of $.turn.step({ turnId: "t1", index: 0, model: "claude-haiku-5-5", messageCount: 1 })) {
        text += chunk.kind === "text" ? chunk.text : "";
    }
    expect(text).toContain("hub?repo=acme%2Fnext.js&commit=abc1234f");
});

test("stall catcher: the closing sentence that stops on intent, and the endings that are no stall", async () => {
    expect(lastSentence("Done.\n\n- **Let me** check the logs.\n")).toBe("Let me check the logs.");
    expect(stallSentence("The suite passes. Next I'll run the tests.")).toBe("Next I'll run the tests.");
    expect(stallSentence("Committed it.\n\nI'll fix the two findings next.")).toBe("I'll fix the two findings next.");
    // Gated on an event, a decision not to act, work in flight elsewhere, or a finished turn.
    expect(stallSentence("I'll report the verdict when it fires.")).toBeUndefined();
    expect(stallSentence("I won't rewrite the history while others push.")).toBeUndefined();
    expect(stallSentence("The review agent is still running. I'll fix its findings next.")).toBeUndefined();
    expect(stallSentence("All 24 tests pass, and the commit is in.")).toBeUndefined();
    expect(continueText("Next I'll run the tests.")).toContain('"Next I\'ll run the tests."');
});

test("stall catcher: a stop with nothing pending shows the row, a pending task does not, a press continues", async () => {
    forgetSettings();
    const sent: string[] = [];
    const base = checkoutHost();
    let agents: Awaited<ReturnType<Host["agents"]>> = [];
    const host: Host = {
        ...base,
        async agents() {
            return agents;
        },
        async read(path) {
            return path === "/home/test/.genesis-tools/agents/hooks.json"
                ? JSON.stringify({ mods: { stall: { enabled: true } } })
                : base.read(path);
        },
        async submit(text) {
            sent.push(text);
            return undefined;
        },
    };
    const stop = (extra: Record<string, unknown>) => ({
        hook_event_name: "Stop",
        last_assistant_message: "Rebased. Next I'll run the tests.",
        background_tasks: [],
        session_crons: [],
        ...extra,
    });

    await noteStop(
        host,
        stop({ background_tasks: [{ id: "b1", type: "shell", status: "running", description: "x" }] })
    );
    expect(stallNow()).toBeUndefined();
    await noteStop(host, stop({ session_crons: [{ id: "c1" }] }));
    expect(stallNow()).toBeUndefined();
    await noteStop(host, { ...stop({}), hook_event_name: "SubagentStop" });
    expect(stallNow()).toBeUndefined();
    // No task list means unknown, and a subagent at work can still report back: neither fires.
    const { background_tasks: _dropped, ...noList } = stop({});
    await noteStop(host, noList);
    expect(stallNow()).toBeUndefined();
    agents = [{ id: "a1", description: "x", type: "general-purpose", status: "running" }];
    await noteStop(host, stop({}));
    expect(stallNow()).toBeUndefined();
    agents = [{ id: "a1", description: "x", type: "general-purpose", status: "completed" }];

    await noteStop(host, stop({}));
    expect(stallNow()?.sentence).toBe("Next I'll run the tests.");
    clearStall(host, "tool call");
    expect(stallNow()).toBeUndefined();

    await noteStop(host, stop({}));
    await pressStall(host, "dismiss");
    expect(sent).toEqual([]);
    await noteStop(host, stop({}));
    await pressStall(host, "continue");
    expect(stallNow()).toBeUndefined();
    expect(sent).toEqual([continueText("Next I'll run the tests.")]);
    forgetSettings();
});

test("session files: worktrees locked to the session, their state, and the total without double counts", async () => {
    expect(samePath("/private/tmp/cc/p/s/worktrees/a/")).toBe("/tmp/cc/p/s/worktrees/a");
    const porcelain = [
        "worktree /work/main\nHEAD 1\nbranch refs/heads/master",
        "worktree /work/wt-a\nHEAD 2\nbranch refs/heads/a\nlocked claude session sess-1 pid 12 since 2026-10-23T10:00:00Z",
        "worktree /private/tmp/cc/p/other/worktrees/b\nHEAD 3\nlocked claude session sess-2 pid 13 since 2026-10-23T10:00:00Z",
    ].join("\n\n");
    expect(lockedToSession(porcelain, "sess-1")).toEqual(["/work/wt-a"]);
    expect(statusOf("## feat/x...origin/feat/x [ahead 2]\n M a.ts\n?? b.ts\n")).toEqual({
        branch: "feat/x",
        changes: 2,
    });
    expect(statusOf("## HEAD (no branch)\n")).toEqual({ branch: "detached", changes: 0 });
    const tree = (path: string, kb: number) => ({ path, source: "", branch: "b", changes: 0, isLocked: false, kb });
    expect(
        sessionTotalKb({
            scratch: { path: "/tmp/cc/p/s", kb: 400 },
            tasks: { path: "/tmp/claude-1/p/s", kb: 12 },
            // The one inside the scratch folder is already in its 400.
            worktrees: [tree("/work/.claude/worktrees/agent-1", 3000), tree("/tmp/cc/p/s/worktrees/w", 100)],
        })
    ).toBe(3412);
});

test("mods settings: a value equal to the file's shipped copy follows today's default, as the CLI reads it", async () => {
    const file = (git: boolean, shippedGit: boolean) =>
        JSON.stringify({
            mods: { git: { enabled: git }, tmpUsage: { enabled: true, minutes: 7 } },
            _shippedDefaults: { mods: { git: { enabled: shippedGit }, tmpUsage: { enabled: false, minutes: 5 } } },
        });

    // Written while git shipped on: the `true` is that day's default, not the user's, so today's default (off) holds.
    expect(modsSettings(file(true, true)).git.enabled).toBe(false);
    expect(modsSettings(file(true, false)).git.enabled).toBe(true);
    expect(modsSettings(file(true, true)).tmpUsage).toEqual({ enabled: true, minutes: 7 });
    // A hand-written file has no shipped copy: every value is the user's.
    expect(modsSettings(JSON.stringify({ mods: { git: { enabled: true } } })).git.enabled).toBe(true);
    // The decisions and inbox sidebars: a known choice is kept, anything else keeps the default.
    const sidebars = modsSettings(
        JSON.stringify({
            mods: {
                decisions: { enabled: true, chip: "waiting", expand: "sometimes" },
                inbox: { enabled: true, chip: "unread", expand: "all" },
            },
        })
    );
    expect(sidebars.decisions).toEqual({
        enabled: true,
        chip: "waiting",
        expand: "waiting",
        history: "collapsed",
        enter: "stage-then-send",
    });
    expect(sidebars.inbox).toEqual({ enabled: true, chip: "unread", expand: "all" });
    expect(modsSettings(undefined).inbox).toEqual({ enabled: false, chip: "any", expand: "none" });
});

test("file links preserve reserved query characters, Unicode and markdown parentheses", async () => {
    const target = "/tmp/a&b#c+d?e%f (ž).md";
    const md = mdLink(ALL_LINKS, target, "12-30");
    const finder = finderLink(ALL_LINKS, target);
    expect(new URL(md ?? "").searchParams.get("path")).toBe(target);
    expect(new URL(md ?? "").searchParams.get("range")).toBe("12-30");
    expect(new URL(finder ?? "").searchParams.get("target")).toBe(target);
    expect(md).not.toContain("(");
    expect(mdLink(NO_LINKS, target)).toBeUndefined();
    expect(finderLink(NO_LINKS, target)).toBeUndefined();
});

test("sending staged answers acknowledges only after successful prompt submission", async () => {
    forgetGenesisProbe();
    forgetAnswers();
    const effects: string[] = [];
    const message = "DECISION 1: a) keep";
    let rejects = true;
    let legacyReceipt = true;
    const base = checkoutHost();
    const host: Host = {
        ...base,
        async run(argv) {
            const probe = argv[1] === "genesis-tools";
            const ack = argv.includes("--ack-prompt");
            const release = argv.includes("--release-prompt");

            if (argv.includes("send")) {
                effects.push(ack ? "ack" : release ? "release" : "prepare");
            }

            return {
                stdout: JSON.stringify(
                    probe
                        ? { links: {}, router: {} }
                        : ack
                          ? { numbers: [1] }
                          : {
                                text: message,
                                promptReceipt: {
                                    ids: ["d_1_s"],
                                    text: message,
                                    ...(legacyReceipt ? {} : { token: "prompt-one" }),
                                },
                            }
                ),
                stderr: "",
                exitCode: 0,
                isStdoutTruncated: false,
                isStderrTruncated: false,
            };
        },
        async submit(text) {
            effects.push(`submit ${text}`);

            if (rejects) {
                throw new Error("prompt rejected");
            }
        },
    };
    expect((await sendStaged(host)).error).toContain("update GenesisTools");
    expect(effects).toEqual(["prepare"]);
    legacyReceipt = false;
    effects.length = 0;
    expect((await sendStaged(host)).error).toContain("prompt rejected");
    expect(effects).toEqual(["prepare", `submit ${message}`, "release"]);
    rejects = false;
    effects.length = 0;
    expect(await sendStaged(host)).toEqual({ text: message, numbers: [1] });
    expect(effects).toEqual(["prepare", `submit ${message}`, "ack"]);
    forgetGenesisProbe();
    forgetAnswers();
});

test("cache polling skips expired JSON contents and removes session marks on end", async () => {
    forgetSettings();
    const base = checkoutHost();
    const reads: string[] = [];
    const runs: string[][] = [];
    let writes = 0;
    const host: Host = {
        ...base,
        async read(path) {
            if (path.endsWith("hooks.json")) {
                return JSON.stringify({ mods: { cacheBand: { enabled: true, others: true } } });
            }

            reads.push(path);
            return JSON.stringify({ sessionId: "warm", lastAt: Date.now(), ttlMs: 3600000 });
        },
        async list() {
            return [
                { name: "old.json", kind: "file", size: 1, mtimeMs: Date.now() - 7200000, isLink: false },
                { name: "warm.json", kind: "file", size: 1, mtimeMs: Date.now(), isLink: false },
            ];
        },
        async run(argv) {
            runs.push([...argv]);
            return { stdout: "", stderr: "", exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false };
        },
        async write() {
            writes++;
        },
    };
    await cacheBand.start?.(host);
    expect(reads).toEqual(["/home/test/.genesis-tools/agents/mods-state/cache/warm.json"]);
    expect(runs[0]).toEqual([
        "find",
        "/home/test/.genesis-tools/agents/mods-state/cache",
        "-type",
        "f",
        "-name",
        "*.json",
        "-mmin",
        "+60",
        "-delete",
    ]);
    await markEnded(host);
    expect(runs.at(-1)?.slice(-4)).toEqual(["f", "-name", "sess-1.json", "-delete"]);
    expect(writes).toBe(0);
    forgetSettings();
});

test("disabling automatic stall continuation clears the pending stall before its timer fires", async () => {
    forgetSettings();
    const base = checkoutHost();
    const sent: string[] = [];
    let enabled = true;

    const host: Host = {
        ...base,
        async read(path) {
            return path.endsWith("hooks.json")
                ? JSON.stringify({ mods: { stall: { enabled, action: "auto", minutes: 1 } } })
                : base.read(path);
        },
        async submit(text) {
            sent.push(text);
        },
    };
    const stop = {
        hook_event_name: "Stop",
        last_assistant_message: "Next I'll run the tests.",
        background_tasks: [],
        session_crons: [],
    };
    await stallCatcher.start?.(host);
    await noteStop(host, stop);
    enabled = false;
    forgetSettings();
    await checkStall(host, Date.now() + 3600000);
    expect(stallNow()).toBeUndefined();
    expect(sent).toEqual([]);
    enabled = true;
    forgetSettings();
    await noteStop(host, stop);
    await checkStall(host, Date.now() + 3600000);
    expect(sent).toEqual([continueText(stop.last_assistant_message)]);
    forgetSettings();
});

test("decision actions fill the exact preview and send an answered batch with no drafted rows", async () => {
    forgetSettings();
    forgetGenesisProbe();
    forgetAnswers();
    const base = checkoutHost();
    const filled: string[] = [];
    const submitted: string[] = [];
    const outgoing = "DECISION 1: a) already answered\nDECISION 2: own staged note";
    const host: Host = {
        ...base,
        async fill(args) {
            filled.push(args.text);
        },
        async submit(text) {
            submitted.push(text);
        },
        async run(argv) {
            const value =
                argv[1] === "genesis-tools"
                    ? { links: {}, router: {} }
                    : argv.includes("--ack-prompt")
                      ? { numbers: [1, 2] }
                      : {
                            text: outgoing,
                            promptReceipt: { ids: ["d_1_s", "d_2_s"], text: outgoing, token: "prompt-two" },
                        };
            return {
                stdout: JSON.stringify(value),
                stderr: "",
                exitCode: 0,
                isStdoutTruncated: false,
                isStderrTruncated: false,
            };
        },
    };
    await sendDecisionAnswers(host, { outgoing, how: "fill" });
    expect(filled).toEqual([outgoing]);
    await sendDecisionAnswers(host, { outgoing, how: "send" });
    expect(submitted).toEqual([outgoing]);
    await sendDecisionAnswers(host, { outgoing: "", how: "send" });
    expect(submitted).toEqual([outgoing]);
    forgetAnswers();
    forgetGenesisProbe();
    forgetSettings();
});

test("an automatic stall check cannot continue a newer stall captured while it checked agents", async () => {
    forgetSettings();
    const base = checkoutHost();
    const submitted: string[] = [];
    let replace = false;
    const stop = (sentence: string) => ({
        hook_event_name: "Stop",
        last_assistant_message: sentence,
        background_tasks: [],
        session_crons: [],
    });
    const host: Host = {
        ...base,
        async read(path) {
            return path.endsWith("hooks.json")
                ? JSON.stringify({ mods: { stall: { enabled: true, action: "auto", minutes: 1 } } })
                : base.read(path);
        },
        async agents() {
            if (replace) {
                replace = false;
                clearStall(host, "new turn");
                await noteStop(host, stop("Next I'll check the logs."));
            }

            return [];
        },
        async submit(text) {
            submitted.push(text);
        },
    };
    await noteStop(host, stop("Next I'll run the tests."));
    replace = true;
    await checkStall(host, Date.now() + 3600000);
    expect(submitted).toEqual([]);
    expect(stallNow()?.sentence).toBe("Next I'll check the logs.");
    await checkStall(host, Date.now() + 3600000);
    expect(submitted).toEqual([continueText("Next I'll check the logs.")]);
    forgetSettings();
});

interface AnswerLogFixture {
    files: Map<string, { text: string; mtimeMs: number }>;
    snapshot: Record<string, unknown>;
    reads: number;
    ranges: { file: string; offset: number; count: number }[];
}

/** ASCII histories exist only in memory; any whole-file Host.read fails the test. */
function answerLogHost(): { host: Host; fixture: AnswerLogFixture } {
    const base = checkoutHost();
    const fixture: AnswerLogFixture = {
        files: new Map(),
        snapshot: { decisions: [], forms: [], entries: [] },
        reads: 0,
        ranges: [],
    };
    const done = (stdout: string) => ({
        stdout,
        stderr: "",
        exitCode: 0,
        isStdoutTruncated: false,
        isStderrTruncated: false,
    });
    const host: Host = {
        ...base,
        async stat(file) {
            const row = fixture.files.get(file);

            if (row) {
                return {
                    kind: "file",
                    size: row.text.length,
                    mtimeMs: row.mtimeMs,
                    isLink: false,
                };
            }

            return base.stat(file);
        },
        async read(file) {
            if (file.includes("/.genesis-tools/question/")) {
                throw new Error(`unbounded log read: ${file}`);
            }

            return base.read(file);
        },
        async run(argv, init) {
            if (argv[1] === "genesis-tools") {
                return done(JSON.stringify({ links: {}, router: {} }));
            }

            if (argv[1] === "question") {
                fixture.reads++;
                return done(JSON.stringify(fixture.snapshot));
            }

            if (argv[0] === "tail" && argv[1] === "-c") {
                const file = argv[3];
                const count = Number(argv[2]);
                const content = fixture.files.get(file)?.text ?? "";
                const offset = Math.max(0, content.length - count);
                fixture.ranges.push({ file, offset, count });
                return done(content.slice(offset, offset + count));
            }

            return base.run(argv, init);
        },
    };

    return { host, fixture };
}

test("answer polling bounds oversized histories before reading, then reads only appended bytes", async () => {
    forgetAnswers();
    forgetGenesisProbe();
    const { host, fixture } = answerLogHost();
    const file = "/home/test/.genesis-tools/question/decisions/events.jsonl";
    const other = `${JSON.stringify({ id: "d_1_other", note: "x".repeat(100) })}\n`;
    const history = other.repeat(4096);
    fixture.files.set(file, { text: history, mtimeMs: 1 });
    fixture.snapshot = { decisions: [{ number: 7, title: "Old resumed decision", status: "waiting" }] };

    // The session's old rows need an initial scoped snapshot even when absent from the bounded history window.
    expect((await refreshAnswers(host, "start"))?.decisions[0]?.n).toBe(7);
    expect(fixture.reads).toBe(1);
    expect(fixture.ranges[0]).toEqual({ file, offset: history.length - 65_536, count: 65_536 });

    fixture.files.set(file, { text: history + other, mtimeMs: 2 });
    await refreshAnswers(host, "other session changed");
    expect(fixture.reads).toBe(1);
    expect(fixture.ranges.at(-1)).toEqual({ file, offset: history.length, count: other.length });

    const own = `${JSON.stringify({ id: "d_7_sess-1", ev: "updated" })}\n`;
    fixture.files.set(file, { text: history + other + own, mtimeMs: 3 });
    await refreshAnswers(host, "own session changed");
    expect(fixture.reads).toBe(2);

    // More than a window arrived between polls. Recover even if the own event is outside the retained suffix.
    fixture.files.set(file, { text: history + other + own + own + history, mtimeMs: 4 });
    await refreshAnswers(host, "overflow");
    expect(fixture.reads).toBe(3);
    expect(fixture.ranges.every((range) => range.count <= 65_536)).toBe(true);
    forgetAnswers();
    forgetGenesisProbe();
});

test("a pending form appears and resolves after an initially empty answer snapshot", async () => {
    forgetAnswers();
    forgetGenesisProbe();
    const { host, fixture } = answerLogHost();
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const file = `/home/test/.genesis-tools/question/pending/${day}.jsonl`;

    expect((await refreshAnswers(host, "empty start"))?.forms).toEqual([]);
    expect(fixture.reads).toBe(1);
    const other = `${JSON.stringify({ ev: "created", form: { sessionHint: "someone-else" } })}\n`;
    fixture.files.set(file, { text: other, mtimeMs: 1 });
    await refreshAnswers(host, "another session's form");
    expect(fixture.reads).toBe(1);

    const own = `${JSON.stringify({ ev: "created", form: { sessionHint: "sess-1", id: "ask-one" } })}\n`;
    fixture.files.set(file, { text: other + own, mtimeMs: 2 });
    fixture.snapshot = { decisions: [], forms: [{ id: "ask-one", at: 1, questions: [{ prompt: "Proceed?" }] }] };
    expect((await refreshAnswers(host, "own pending form"))?.forms).toEqual([
        { id: "ask-one", at: 1, prompts: ["Proceed?"] },
    ]);
    expect(fixture.reads).toBe(2);

    const resolved = `${JSON.stringify({ ev: "answered", form: { sessionHint: "sess-1", id: "ask-one" } })}\n`;
    fixture.files.set(file, { text: other + own + resolved, mtimeMs: 3 });
    fixture.snapshot = { decisions: [], forms: [] };
    expect((await refreshAnswers(host, "form resolved"))?.forms).toEqual([]);
    expect(fixture.reads).toBe(3);
    forgetAnswers();
    forgetGenesisProbe();
});

test("an append during a bounded log read cannot hide the session's earlier unread event", async () => {
    forgetAnswers();
    forgetGenesisProbe();
    const { host: base, fixture } = answerLogHost();
    const file = "/home/test/.genesis-tools/question/decisions/events.jsonl";
    let appendDuringRead = false;
    const host: Host = {
        ...base,
        async run(argv, init) {
            if (appendDuringRead && argv[0] === "tail" && argv[3] === file) {
                appendDuringRead = false;
                const before = fixture.files.get(file)?.text ?? "";
                fixture.files.set(file, {
                    text: before + `${JSON.stringify({ id: "d_1_other", note: "x".repeat(200) })}\n`,
                    mtimeMs: 2,
                });
            }

            return base.run(argv, init);
        },
    };
    await refreshAnswers(host, "empty start");
    fixture.files.set(file, { text: `${JSON.stringify({ id: "d_1_sess-1", ev: "created" })}\n`, mtimeMs: 1 });
    fixture.snapshot = { decisions: [{ number: 1, title: "New decision", status: "waiting" }] };
    appendDuringRead = true;
    expect((await refreshAnswers(host, "moving log"))?.decisions[0]?.n).toBe(1);
    expect(fixture.reads).toBe(2);
    forgetAnswers();
    forgetGenesisProbe();
});

test("agent details retry aborted metadata reads and rendering facts starts no discovery", async () => {
    forgetAgentDetails();
    forgetSettings();
    const base = checkoutHost();
    const agents: Awaited<ReturnType<Host["agents"]>> = [
        { id: "resumed", description: "Resumed worker", type: "general-purpose", status: "running" },
    ];
    let metaReads = 0;
    let tailReads = 0;
    const host: Host = {
        ...base,
        async agents() {
            return agents;
        },
        async read(file) {
            if (file.endsWith("hooks.json")) {
                return JSON.stringify({ mods: { agentsBand: { enabled: true } } });
            }

            if (file.endsWith(".meta.json")) {
                metaReads++;

                if (metaReads === 1) {
                    throw new Error("render replaced: aborted");
                }

                return JSON.stringify({ model: "claude-sonnet-5-5" });
            }

            return base.read(file);
        },
        async stat(file) {
            return file.endsWith(".meta.json")
                ? { kind: "file", size: 1, mtimeMs: 123, isLink: false }
                : base.stat(file);
        },
        async run(argv, init) {
            if (argv[0] === "tail") {
                tailReads++;
                return { stdout: "", stderr: "", exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false };
            }

            return base.run(argv, init);
        },
    };
    await factsOf(host, agents);
    expect(metaReads).toBe(0);
    expect(tailReads).toBe(0);
    await agentsBand.start?.(host);
    expect((await factsOf(host, agents))[0]?.model).toBeUndefined();
    expect(metaReads).toBe(1);
    await refreshAgentDetails(host);
    const facts = await factsOf(host, agents);
    expect(metaReads).toBe(2);
    expect(facts[0]?.model).toBeDefined();
    expect(facts[0]?.startedAt).toBe(123);
    await factsOf(host, [
        ...agents,
        { id: "not-discovered", description: "Unknown worker", type: "general-purpose", status: "running" },
    ]);
    expect(metaReads).toBe(2);
    expect(tailReads).toBe(1);
    forgetAgentDetails();
    forgetSettings();
});

test("interleaved checkout completions keep both roots and their branch histories", async () => {
    forgetCheckouts();
    const base = checkoutHost();
    let releaseFirst: () => void = () => undefined;
    const firstHead = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const host: Host = {
        ...base,
        async read(file) {
            if (file.endsWith("sessions/sess-1.json")) {
                return JSON.stringify({ files: [] });
            }

            if (file === "/work/wt-a/.git/HEAD") {
                await firstHead;
                return "ref: refs/heads/feat/a\n";
            }

            if (file === "/work/wt-b/.git/HEAD") {
                releaseFirst();
                return "ref: refs/heads/feat/b\n";
            }

            return base.read(file);
        },
    };
    const deadline = setTimeout(() => releaseFirst(), 5_000);

    try {
        await Promise.all([
            noteToolCall(host, { tool: "Bash", command: "git -C /work/wt-a commit -m a" }),
            noteToolCall(host, { tool: "Bash", command: "git -C /work/wt-b commit -m b" }),
        ]);
    } finally {
        clearTimeout(deadline);
    }

    const touches = await sessionCheckouts(host);
    expect(touches.map((touch) => touch.root).sort()).toEqual(["/work/wt-a", "/work/wt-b"]);
    expect(touches.find((touch) => touch.root === "/work/wt-a")?.branches).toEqual(["feat/a"]);
    expect(touches.find((touch) => touch.root === "/work/wt-b")?.branches).toEqual(["feat/b"]);
    forgetCheckouts();
    expect((await sessionCheckouts(host)).map((touch) => touch.root).sort()).toEqual(["/work/wt-a", "/work/wt-b"]);
    forgetCheckouts();
});

test("parallel manual checkout changes keep additions and removals", async () => {
    forgetCheckouts();
    const base = checkoutHost();
    const host: Host = {
        ...base,
        async stat(file) {
            return ["/work/wt-a", "/work/wt-b", "/work/main"].includes(file)
                ? { kind: "dir", size: 0, mtimeMs: 0, isLink: false }
                : base.stat(file);
        },
    };
    await Promise.all([addCheckout(host, "/work/wt-a"), addCheckout(host, "/work/wt-b")]);
    expect([...(await addedCheckouts(host))].sort()).toEqual(["/work/wt-a", "/work/wt-b"]);
    await Promise.all([removeAdded(host, "/work/wt-a"), addCheckout(host, "/work/main")]);
    expect([...(await addedCheckouts(host))].sort()).toEqual(["/work/main", "/work/wt-b"]);
    forgetCheckouts();
});

test("hiding every worked checkout stays empty across a reload instead of reseeding the journal", async () => {
    forgetCheckouts();
    const host = checkoutHost();
    const roots = (await sessionCheckouts(host)).map((touch) => touch.root);
    expect(roots.length).toBeGreaterThan(0);
    await Promise.all(roots.map((root) => hideCheckout(host, root)));
    expect(await sessionCheckouts(host)).toEqual([]);
    forgetCheckouts();
    expect(await sessionCheckouts(host)).toEqual([]);
    forgetCheckouts();
});

test("failed checkout persistence rejects, keeps the last saved state, and lets later mutations proceed", async () => {
    forgetCheckouts();
    const base = checkoutHost();
    const original = [
        { root: "/work/wt-a", at: 1 },
        { root: "/work/wt-b", at: 2 },
    ];
    await base.storeSet("git-band-checkouts", { "sess-1": original });
    await base.storeSet("git-band-added", { "sess-1": [{ root: "/work/wt-a", at: 1 }] });
    let failWrite = true;
    let failRead = false;
    const logs: string[] = [];
    const host: Host = {
        ...base,
        async storeGet(key) {
            if (failRead) {
                throw new Error("store unavailable");
            }

            return base.storeGet(key);
        },
        async storeSet(key, value) {
            if (failWrite) {
                throw new Error("disk full");
            }

            await base.storeSet(key, value);
        },
        async append(_file, line) {
            logs.push(line);
        },
    };
    expect(await sessionCheckouts(host)).toEqual(original);
    expect(await addedCheckouts(host)).toEqual(["/work/wt-a"]);
    await expect(hideCheckout(host, "/work/wt-a")).rejects.toThrow("disk full");
    await expect(removeAdded(host, "/work/wt-a")).rejects.toThrow("disk full");
    await expect(addCheckout(host, "/home/test/code/playground")).rejects.toThrow("disk full");
    await expect(noteToolCall(host, { tool: "Bash", command: "git -C /work/wt-b commit -m x" })).rejects.toThrow(
        "disk full"
    );
    expect(await sessionCheckouts(host)).toEqual(original);
    expect(await addedCheckouts(host)).toEqual(["/work/wt-a"]);
    expect(await base.storeGet("git-band-checkouts")).toEqual({ "sess-1": original });

    failWrite = false;
    failRead = true;
    await expect(addCheckout(host, "/home/test/code/playground")).rejects.toThrow("store unavailable");
    expect(await addedCheckouts(host)).toEqual(["/work/wt-a"]);
    expect(await base.storeGet("git-band-added")).toEqual({ "sess-1": [{ root: "/work/wt-a", at: 1 }] });
    failRead = false;
    await addCheckout(host, "/home/test/code/playground");
    await hideCheckout(host, "/work/wt-a");
    forgetCheckouts();
    expect((await sessionCheckouts(host)).map((touch) => touch.root)).toEqual(["/work/wt-b"]);
    expect(await addedCheckouts(host)).toEqual(["/home/test/code/playground", "/work/wt-a"]);
    expect(logs.some((line) => line.includes('"event":"store-write-failed"'))).toBe(true);
    expect(logs.some((line) => line.includes('"event":"store-read-failed"'))).toBe(true);
    forgetCheckouts();
});

test("a failed sidebar save keeps the row and reports failure, and the command reports failure too", async () => {
    forgetCheckouts();
    forgetSettings();
    const base = checkoutHost();
    const notices: string[] = [];
    let flips = 0;
    const host: Host = {
        ...base,
        async read(file) {
            return file.endsWith("hooks.json")
                ? JSON.stringify({ mods: { sidebar: { feedback: "toast" } } })
                : base.read(file);
        },
        async storeSet() {
            throw new Error("disk full");
        },
        toast(message) {
            notices.push(message);
        },
    };
    await toggleGit(host, "remove-test", {
        busy: "Removing…",
        flip: () => {
            flips++;
        },
        store: async () => {
            throw new Error("disk full");
        },
        done: "Removed successfully",
    });
    expect(flips).toBe(0);
    expect(notices.some((message) => message.includes("Not saved: Error: disk full"))).toBe(true);
    expect(notices.some((message) => message.includes("Removed successfully"))).toBe(false);
    const result = await gitBand.commands?.[0]?.run(host, "add /home/test/code/playground");
    expect(result?.text).toContain("Git command failed: Error: disk full");
    expect(await addedCheckouts(host)).toEqual([]);
    forgetCheckouts();
    forgetSettings();
});

test("a git refresh requested during a read waits for roots added or removed during that read", async () => {
    forgetCheckouts();
    forgetSettings();
    const base = checkoutHost();
    await base.storeSet("git-band-checkouts", { "sess-1": [{ root: "/work/wt-a", at: 1 }] });
    const publications: string[][] = [];
    let held: { entered: () => void; wait: Promise<void> } | undefined;
    const host: Host = {
        ...base,
        async stat(file) {
            return file === "/work/wt-b" ? { kind: "dir", size: 0, mtimeMs: 0, isLink: false } : base.stat(file);
        },
        async run(argv, init) {
            if (argv[0] === "git" && argv[1] === "rev-parse") {
                return {
                    stdout: "/work/main\n",
                    stderr: "",
                    exitCode: 0,
                    isStdoutTruncated: false,
                    isStderrTruncated: false,
                };
            }

            if (argv[0] === "git" && argv[1] === "status") {
                if (held) {
                    const pending = held;
                    held = undefined;
                    pending.entered();
                    await pending.wait;
                }

                return {
                    stdout: "## topic\n",
                    stderr: "",
                    exitCode: 0,
                    isStdoutTruncated: false,
                    isStderrTruncated: false,
                };
            }

            return base.run(argv, init);
        },
        async append(file, line) {
            if (file.endsWith("/mods-log/git.jsonl")) {
                const record: unknown = JSON.parse(line);

                if (isRecord(record) && record.event === "refresh" && Array.isArray(record.rows)) {
                    publications.push(
                        record.rows.flatMap((row) => (isRecord(row) && typeof row.root === "string" ? [row.root] : []))
                    );
                }
            }
        },
    };
    const duringRead = async (change: () => Promise<unknown>) => {
        let enter: () => void = () => undefined;
        let release: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        held = { entered: enter, wait };
        const deadline = setTimeout(() => {
            enter();
            release();
        }, 5_000);
        const first = refreshGit(host, "before change");

        try {
            await entered;
            await change();
            const following = refreshGit(host, "after change");
            release();
            await Promise.all([first, following]);
        } finally {
            release();
            clearTimeout(deadline);
        }
    };
    await duringRead(() => addCheckout(host, "/work/wt-b"));
    expect(publications.at(-1)?.slice().sort()).toEqual(["/work/wt-a", "/work/wt-b"]);
    await duringRead(() => removeAdded(host, "/work/wt-b"));
    expect(publications.at(-1)).toEqual(["/work/wt-a"]);
    forgetCheckouts();
    forgetSettings();
});

test("sending clears only submitted unchanged field text and preserves unstaged or in-flight edits", async () => {
    forgetAnswers();
    forgetGenesisProbe();
    forgetSettings();
    const { host: base, fixture } = answerLogHost();
    fixture.snapshot = {
        decisions: [
            { number: 101, status: "drafted", draft: "staged one" },
            { number: 102, status: "waiting" },
            { number: 103, status: "drafted", draft: "staged three" },
            { number: 104, status: "drafted", draft: "staged four" },
        ],
    };
    const outgoing = "DECISION 101: staged one\nDECISION 103: staged three\nDECISION 104: staged four";
    const host: Host = {
        ...base,
        async run(argv, init) {
            if (argv[1] === "question" && argv.includes("send")) {
                const result = argv.includes("--ack-prompt")
                    ? { numbers: [101, 103, 104] }
                    : {
                          text: outgoing,
                          promptReceipt: {
                              ids: ["d_101_s", "d_103_s", "d_104_s"],
                              text: outgoing,
                              token: "prompt-fields",
                          },
                      };
                return {
                    stdout: JSON.stringify(result),
                    stderr: "",
                    exitCode: 0,
                    isStdoutTruncated: false,
                    isStderrTruncated: false,
                };
            }

            return base.run(argv, init);
        },
        async submit() {
            editAnswer(103, "edited while sending");
        },
    };
    await refreshAnswers(host, "seed", true);
    editAnswer(101, "staged one");
    editAnswer(102, "unstaged other decision");
    editAnswer(103, "staged three");
    editAnswer(104, "unstaged edit to a submitted decision");
    await sendDecisionAnswers(host, { outgoing, how: "send" });
    expect(typedAnswer(101)).toBeUndefined();
    expect(typedAnswer(102)).toBe("unstaged other decision");
    expect(typedAnswer(103)).toBe("edited while sending");
    expect(typedAnswer(104)).toBe("unstaged edit to a submitted decision");
    forgetAnswers();
    forgetGenesisProbe();
    forgetSettings();
});

test("the inbox watcher activates after enabling it and gates reads when both consumers are off", async () => {
    forgetAnswers();
    forgetGenesisProbe();
    forgetSettings();
    const { host: base, fixture } = answerLogHost();
    let inboxEnabled = false;
    let decisionsEnabled = false;
    let timers = 0;
    let logStats = 0;
    const host: Host = {
        ...base,
        async read(file) {
            return file.endsWith("hooks.json")
                ? JSON.stringify({
                      mods: { inbox: { enabled: inboxEnabled }, decisions: { enabled: decisionsEnabled } },
                  })
                : base.read(file);
        },
        every(ms) {
            if (ms === 10_000) {
                timers++;
            }
        },
        async stat(file) {
            if (file.includes("/.genesis-tools/question/")) {
                logStats++;
            }

            return base.stat(file);
        },
    };
    await inbox.start?.(host);
    await decisions.start?.(host);
    expect(timers).toBe(1);
    expect(fixture.reads).toBe(0);
    expect(logStats).toBe(0);

    inboxEnabled = true;
    forgetSettings();
    fixture.snapshot = {
        decisions: [],
        entries: [{ id: "entry-one", ts: 1, tag: "message", question: "Hello", answerMd: "Reply" }],
    };
    await pollAnswers(host, "tick");
    expect(answersOf()?.entries[0]?.id).toBe("entry-one");
    expect(fixture.reads).toBe(1);
    inboxEnabled = false;
    forgetSettings();
    const before = logStats;
    await pollAnswers(host, "off tick");
    expect(logStats).toBe(before);
    expect(fixture.reads).toBe(1);

    decisionsEnabled = true;
    forgetSettings();
    const file = "/home/test/.genesis-tools/question/decisions/events.jsonl";
    fixture.files.set(file, { text: `${JSON.stringify({ id: "d_1_sess-1", ev: "created" })}\n`, mtimeMs: 1 });
    fixture.snapshot = { decisions: [{ number: 1, status: "waiting", title: "New decision" }] };
    await pollAnswers(host, "decisions only");
    expect(fixture.reads).toBe(2);
    expect(answersOf()?.decisions[0]?.n).toBe(1);
    expect(timers).toBe(1);
    forgetAnswers();
    forgetGenesisProbe();
    forgetSettings();
});
