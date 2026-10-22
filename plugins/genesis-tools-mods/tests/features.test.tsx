import type { On, TurnStepChunk } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { quoteOf } from "../hooks/ask-row";
import { cacheRowsOf } from "../hooks/cache-band";
import { openDecisions, stagedMessage } from "../hooks/decisions";
import { checkCounts, parseStatus } from "../hooks/git-band";
import { dedupeEntry, tokensText } from "../hooks/hook-ledger";
import { targetFor } from "../hooks/links";
import { toolLabel } from "../hooks/spinner";

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
    expect(
        checkCounts([
            { conclusion: "SUCCESS" },
            { conclusion: "FAILURE" },
            { state: "PENDING" },
            { conclusion: "", status: "IN_PROGRESS" },
            { state: "SUCCESS" },
        ])
    ).toEqual({ passed: 2, failed: 1, pending: 2 });
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
});

test("ask quote and spinner label", async () => {
    expect(quoteOf([{ tool: "Bash", input: { command: "ls  -la" }, output: { stdout: "a\nb" } }])).toBe(
        "> Bash: ls -la\n> a\n> b\n\n"
    );
    expect(toolLabel("Bash", { command: "bun run test", description: "Run the suite" })).toBe("Bash Run the suite");
    expect(toolLabel("Read", {})).toBe("Read");
});

test("link targets by kind", async () => {
    expect(targetFor("/r/My Notes/a.md", "file", 3, 9)).toBe(
        "https://genesis.tools/md/open?path=/r/My%20Notes/a.md&range=3-9"
    );
    expect(targetFor("/r/src", "dir")).toBe("https://genesis.tools/finder/reveal?target=/r/src");
    expect(targetFor("/r/src/a.ts", "file", 12)).toBe("cursor://file/r/src/a.ts:12");
    expect(targetFor("/r/src/a (1).ts", "file")).toBe("/r/src/a%20%281%29.ts");
});

/** The machine beneath the plugin: a repository at /repo with three paths and one commit. */
function machine(on: On): void {
    mock.env(on, { HOME: "/home/test" });
    const files: Record<string, "file" | "dir"> = {
        "/repo/src/a.ts": "file",
        "/repo/docs": "dir",
        "/repo/notes/plan.md": "file",
    };

    on("fs.read", async () => {
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
            "See [src/a.ts:12](cursor://file/repo/src/a.ts:12) and [docs/](https://genesis.tools/finder/reveal?target=/repo/docs) and [**abc1234f**](https://genesis.tools/hub?repo=acme%2Fwidgets&commit=abc1234f).",
            "Repeat [❓ DECISION 3](https://genesis.tools/claude/find/sess-1/decision/3) now, not ❓ DECISION 9.",
            "```",
            "src/a.ts",
            "```",
            "Already [a](src/a.ts), https://b.c/src/a.ts#9, missing/x.ts, [notes/plan.md](https://genesis.tools/md/open?path=/repo/notes/plan.md), PR [#42 (feat: widgets)](https://github.com/acme/widgets/pull/42), #43",
        ].join("\n")
    );
    expect(chunks.at(-1)?.kind).toBe("stop");
});
