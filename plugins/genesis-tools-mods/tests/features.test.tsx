import type { On, TurnStepChunk } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { bareDescription, lastSaidOf } from "../hooks/agents-band";
import { quoteOf } from "../hooks/ask-row";
import { cacheRowsOf, cacheTone } from "../hooks/cache-band";
import {
    forgetCheckouts,
    gitWriteDirs,
    noteToolCall,
    pickRoots,
    sessionCheckouts,
    writtenFiles,
} from "../hooks/checkouts";
import { openDecisions, stagedMessage } from "../hooks/decisions";
import { forgetGenesisProbe, type GenesisProbe, probeOf } from "../hooks/genesis";
import {
    checkCounts,
    checksOf,
    hubUrlOf,
    middleCut,
    namesCheckouts,
    parseNumstat,
    parseStatus,
} from "../hooks/git-band";
import { dedupeEntry, ledgerOf, tokensText } from "../hooks/hook-ledger";
import { targetFor } from "../hooks/links";
import type { Host } from "../hooks/shared";
import { toolLabel } from "../hooks/spinner";

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
            { name: "lint", conclusion: "FAILURE" },
            { context: "ci/deploy", state: "PENDING" },
        ])
    ).toEqual([
        { name: "lint", verdict: "fail" },
        { name: "ci/deploy", verdict: "pending" },
    ]);
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
    expect(namesCheckouts([{ root: "/work/main" }], "/work/main")).toBe(false);
    expect(namesCheckouts([{ root: "/work/wt-a" }], "/work/main")).toBe(true);
});

/**
 * A session started in /work/main that works in the worktrees /work/wt-a and /work/wt-b; its GenesisTools journal
 * also names a plan in the main checkout's ignored `.claude/plans/` and a scratch file outside every repository.
 */
function checkoutHost(): Host {
    const store = new Map<string, unknown>();
    const repos = new Set(["/work/main/.git", "/work/wt-a/.git", "/work/wt-b/.git"]);
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

            throw new Error(`ENOENT ${path}`);
        },
        async write() {},
        async list() {
            return [];
        },
        async exists(path) {
            return repos.has(path);
        },
        async stat(path) {
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
        async copy() {},
        async openUrl() {},
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
        { sessionId: "own", label: "a", expiresAt: now + 10 * minute, own: true, compacted: true },
    ]);

    // Dim above the caution window, yellow inside it, red inside the warning.
    expect(cacheTone(25 * minute, 10 * minute, 20 * minute)).toBeUndefined();
    expect(cacheTone(15 * minute, 10 * minute, 20 * minute)).toBe("yellow");
    expect(cacheTone(4 * minute, 10 * minute, 20 * minute)).toBe("red");
    // A caution under the warning means no yellow stage.
    expect(cacheTone(15 * minute, 10 * minute, 5 * minute)).toBeUndefined();
});

test("ask quote and spinner label", async () => {
    expect(quoteOf([{ tool: "Bash", input: { command: "ls  -la" }, output: { stdout: "a\nb" } }])).toBe(
        "> Bash: ls -la\n> a\n> b\n\n"
    );
    expect(toolLabel("Bash", { command: "bun run test", description: "Run the suite" })).toBe("Bash Run the suite");
    expect(toolLabel("Read", {})).toBe("Read");
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
function machine(on: On, links: "all" | "none" = "all"): void {
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
            return answer("git@github.com:acme/widgets.git\n");
        }

        if (argv.endsWith("pr view 42 --json title,url")) {
            return answer('{"title":"feat: widgets","url":"https://github.com/acme/widgets/pull/42"}');
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
    machine(on);

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
    machine(on, "none");

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
