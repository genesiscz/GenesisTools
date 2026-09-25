import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetById } from "@genesiscz/utils/browser-router/presets";
import { defaultRouterConfig, parseConfig, route } from "@genesiscz/utils/browser-router/route";
import {
    answerDecision,
    buildQuestionAnswer,
    choiceForOption,
    claudeSessionExists,
    type DecideDeps,
    decisionLinks,
    decisionText,
    type LinksSessionDeps,
    linksSession,
    sendDecision,
    validateDecide,
    validateTarget,
} from "./decide";

const SESSION = "3f2a9c1e-0000-4000-8000-00000000abcd";

/** Every refusal must stop before the pane: reaching the send primitive fails the test. */
const neverSend: DecideDeps["send"] = (session, text) => {
    throw new Error(`typed "${text}" into ${session}`);
};

describe("decide", () => {
    test("the text is the exact decision line", () => {
        expect(decisionText(2, "b")).toBe("DECISION 2: b)");
    });

    test("a valid answer calls the send primitive once with the exact template", async () => {
        const calls: string[] = [];
        const sent = await answerDecision(
            { session: SESSION, decision: "3", option: "a" },
            {
                sessionExists: (session) => session === SESSION,
                send: (session, line) => {
                    calls.push(`${session} ${line}`);
                    return true;
                },
            }
        );

        expect(sent.text).toBe("DECISION 3: a)");
        expect(calls).toEqual([`${SESSION} DECISION 3: a)`]);
    });

    test("an unknown session, a non-integer decision, or a multi-letter option never reach the send primitive", async () => {
        const known = { sessionExists: (session: string) => session === SESSION, send: neverSend };

        await expect(answerDecision({ session: "no-such-session", decision: "3", option: "a" }, known)).rejects.toThrow(
            "no Claude session no-such-session"
        );
        await expect(answerDecision({ session: SESSION, decision: "3.5", option: "a" }, known)).rejects.toThrow(
            "integer"
        );
        await expect(answerDecision({ session: SESSION, decision: "x", option: "a" }, known)).rejects.toThrow(
            "integer"
        );
        await expect(answerDecision({ session: SESSION, decision: "3", option: "ab" }, known)).rejects.toThrow(
            "single letter"
        );
        await expect(answerDecision({ session: SESSION, decision: "3", option: "B" }, known)).rejects.toThrow(
            "single letter"
        );
        await expect(
            answerDecision({ session: SESSION, decision: "3", option: "a", question: "ask_1; rm" }, known)
        ).rejects.toThrow("form id");
        await expect(answerDecision({ session: "a b)", decision: "3", option: "a" }, known)).rejects.toThrow(
            "session id"
        );
    });

    test("a sender that typed nothing is an error, not a sent line", async () => {
        const decision = validateDecide({ session: "work_1", decision: "3", option: "a" });

        await expect(sendDecision(decision, () => false)).rejects.toThrow(/was not sent/);
        await expect(sendDecision(decision, async () => true)).resolves.toBe("DECISION 3: a)");
    });

    test("links need a valid session and number; a send needs an option", () => {
        expect(() => validateTarget({ session: "abc", decision: "x" })).toThrow(/integer/);
        expect(() => validateTarget({ session: "abc", decision: "9007199254740993" })).toThrow(/integer/);
        expect(() => validateTarget({ session: "a b)", decision: "1" })).toThrow(/session id/);
        expect(() => validateDecide({ session: "abc", decision: "1" })).toThrow(/single letter/);
        expect(validateDecide({ session: "abc", decision: "1", option: "a", question: "" })).toEqual({
            session: "abc",
            decision: 1,
            option: "a",
        });
    });

    test("links use the genesis.tools shape, with labels and the question id", () => {
        expect(decisionLinks({ session: "abc", decision: 1, options: ["a", "b"] })).toBe(
            [
                "**a)** [a](https://genesis.tools/decide/abc/1/a)",
                "**b)** [b](https://genesis.tools/decide/abc/1/b)",
            ].join("\n")
        );
        expect(
            decisionLinks({
                session: "abc",
                decision: 4,
                options: ["a", "b"],
                labels: ["Keep [it]", "Drop"],
                question: "ask_1",
            })
        ).toBe(
            [
                "**a)** [Keep it](https://genesis.tools/decide/abc/4/a?q=ask_1)",
                "**b)** [Drop](https://genesis.tools/decide/abc/4/b?q=ask_1)",
            ].join("\n")
        );
        expect(() => decisionLinks({ session: "abc", decision: 1, options: ["ab"] })).toThrow("single letter");
    });

    test("every printed link is one the decide preset routes back to this exact answer", () => {
        const config = parseConfig({
            ...defaultRouterConfig(),
            routes: presetById("decide", () => true)?.routes ?? [],
        });
        const printed = decisionLinks({ session: SESSION, decision: 12, options: ["a", "c"], question: "ask_7" });
        const urls = [...printed.matchAll(/\((https:[^)]+)\)/g)].map((match) => match[1] ?? "");

        expect(urls.map((url) => route(url, config))).toMatchObject(
            ["a", "c"].map((option) => ({
                kind: "run",
                argv: [
                    "tools",
                    "claude",
                    "decide",
                    "--session",
                    SESSION,
                    "--decision",
                    "12",
                    "--option",
                    option,
                    "--question",
                    "ask_7",
                ],
            }))
        );
    });

    test("a link the decide preset would not route is refused, not printed as a dead link", () => {
        // A dead link opens https://genesis.tools/decide/... in the browser instead of answering.
        expect(() => decisionLinks({ session: "s".repeat(65), decision: 1, options: ["a"] })).toThrow("decide link");
        expect(() => decisionLinks({ session: SESSION, decision: 1_234_567, options: ["a"] })).toThrow("decide link");
        expect(() => decisionLinks({ session: SESSION, decision: 1, options: ["a"], question: "a b" })).toThrow(
            "question must be a form id"
        );
    });

    test("a session exists when its transcript does", () => {
        const projects = mkdtempSync(join(tmpdir(), "decide-projects-"));
        mkdirSync(join(projects, "-tmp-repo"));
        writeFileSync(join(projects, "-tmp-repo", `${SESSION}.jsonl`), "{}\n");

        expect(claudeSessionExists(SESSION, projects)).toBe(true);
        expect(claudeSessionExists("3f2a9c1e-0000-4000-8000-000000000000", projects)).toBe(false);
        expect(claudeSessionExists("../x", projects)).toBe(false);
    });
});

describe("the question form channel", () => {
    const choices = [
        { id: "c1", label: "a) Keep" },
        { id: "c2", label: "b) Drop" },
    ];

    test("a letter picks its choice by id, by an `a)` label, or by position", () => {
        expect(choiceForOption([{ id: "b", label: "Drop" }], "b")?.id).toBe("b");
        expect(choiceForOption(choices, "b")?.id).toBe("c2");
        expect(
            choiceForOption(
                [
                    { id: "x", label: "Keep" },
                    { id: "y", label: "Drop" },
                ],
                "b"
            )?.id
        ).toBe("y");
        expect(choiceForOption(choices, "z")).toBeNull();
    });

    test("the answer names the item with choices and, when it takes text, the decision line", () => {
        expect(
            buildQuestionAnswer(
                [
                    { id: "q1", allowFreeText: true },
                    { id: "q2", choices, allowFreeText: true },
                ],
                { decision: 4, option: "b" }
            )
        ).toEqual({ itemId: "q2", selectedChoices: ["c2"], freeText: "DECISION 4: b)" });
        expect(buildQuestionAnswer([{ id: "q1" }], { decision: 4, option: "b" })).toEqual({ itemId: "q1" });
        expect(buildQuestionAnswer([], { decision: 4, option: "b" })).toBeNull();
    });
});

describe("linksSession", () => {
    const deps = (over: Partial<LinksSessionDeps>): LinksSessionDeps => ({
        current: () => null,
        interactive: () => true,
        recent: () => [
            { sessionId: "newer-0001", title: "Newer", project: "shop", mtime: Date.now() },
            { sessionId: "older-0002", title: null, project: null, mtime: Date.now() - 3_600_000 },
        ],
        select: async () => null,
        ...over,
    });

    test("in a terminal without --session it offers recent sessions, newest first, and uses the pick", async () => {
        let offered: { value: string; label: string }[] = [];
        const session = await linksSession(
            undefined,
            deps({
                select: async (choices) => {
                    offered = choices;
                    return choices[1]?.value ?? null;
                },
            })
        );

        expect(session).toBe("older-0002");
        expect(offered.map((choice) => [choice.value, choice.label])).toEqual([
            ["newer-0001", "Newer · shop"],
            ["older-0002", "(untitled)"],
        ]);
    });

    test("--session and the running session win; without a terminal it refuses instead of prompting", async () => {
        const select = async () => {
            throw new Error("must not prompt");
        };

        expect(await linksSession("given", deps({ select }))).toBe("given");
        expect(await linksSession(undefined, deps({ current: () => "running", select }))).toBe("running");
        await expect(linksSession(undefined, deps({ interactive: () => false, select }))).rejects.toThrow(
            "no --session"
        );
        await expect(linksSession(undefined, deps({}))).rejects.toThrow("no session picked");
    });
});
