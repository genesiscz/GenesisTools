import { describe, expect, test } from "bun:test";
import { loadCorpus, readBundledExample } from "./corpus";
import { parse } from "./language";
import { absentProvider, fixtureJudge } from "./providers";
import { distribution, type Provider, run } from "./runtime";

const absent = absentProvider();
const judge = fixtureJudge;
const condition =
    'if input() feels "urgent" with confidence 80% {print("yes")} otherwise maybe {print("maybe")} else {print("no")}';

describe("Probably runtime", () => {
    test("confidence is symmetric: high yes, ambiguous, high no", async () => {
        for (const [p, text] of [
            [0.91, "yes"],
            [0.6, "maybe"],
            [0.09, "no"],
        ] as const) {
            expect((await run(condition, judge(p))).output).toEqual([text]);
        }
    });

    test("generation receives only explicitly supplied context", async () => {
        const p: Provider = {
            ...absent,
            write: async (prompt, value) => {
                expect(prompt).toBe("rewrite");
                expect(value).toBe("hello");
                return "hi";
            },
        };
        const r = await run('let secret = "not passed" let draft = llm "rewrite" using input() print(draft)', p, {
            input: "hello",
        });
        expect(r.output).toEqual(["hi"]);
        expect(r.tape[0].args).toEqual({ prompt: "rewrite", value: "hello" });
    });

    test("while reevaluates the updated value and exits", async () => {
        const seen: unknown[] = [];
        const p: Provider = {
            write: async () => "normal",
            judge: async (value, labels) => {
                seen.push(value);
                return {
                    [labels[0]]: value === "corporate" ? 0.99 : 0.01,
                    [labels[1]]: value === "corporate" ? 0.01 : 0.99,
                };
            },
        };
        const r = await run(
            'let draft=input() while draft feels "corporate" {draft=write "fix" using draft} print(draft)',
            p,
            { input: "corporate" }
        );
        expect(seen).toEqual(["corporate", "normal"]);
        expect(r.output).toEqual(["normal"]);
    });

    test("runaway semantic loops stop explicitly", async () => {
        await expect(run('while "yes" feels "true" {print("again")}', judge(0.99))).rejects.toThrow(
            "after 5 iterations"
        );
    });

    test("chaos samples probabilities; replay preserves sample and generated text", async () => {
        const p = { ...judge(0.9), write: async () => "Generated once" };
        const source = 'let text=write "hello" chaos { if text feels "urgent" {print("yes")} else {print("no")} }';
        const first = await run(source, p, { random: () => 0.95 });
        expect(first.output).toEqual(["no"]);
        const replay = await run(source, absent, { replay: first.tape, random: () => 0 });
        expect(replay.output).toEqual(first.output);
        expect(replay.trace).toEqual(first.trace);
    });

    test("confidence gates happen before chaos sampling", async () => {
        const r = await run(`chaos {${condition}}`, judge(0.6), { random: () => 0.1 });
        expect(r.output).toEqual(["maybe"]);
    });

    test("match chooses highest probability and deterministic first-label ties", async () => {
        const source = 'match input() { "bug" => {print("bug")} "idea" => {print("idea")} }';
        expect((await run(source, judge(0.2))).output).toEqual(["idea"]);
        expect((await run(source, judge(0.5))).output).toEqual(["bug"]);
    });

    test("replay rejects altered inputs, missing and surplus effects", async () => {
        const saved = await run(condition, judge(0.9), { input: "one" });
        await expect(run(condition, absent, { input: "two", replay: saved.tape })).rejects.toThrow("does not match");
        await expect(run(condition, absent, { replay: [] })).rejects.toThrow("does not match");
        await expect(run('print("ok")', absent, { replay: saved.tape })).rejects.toThrow("unused");
    });

    test("block locals cannot escape; assignment updates outer variable", async () => {
        expect((await run('let x="before" repeat 2 {let local="ok" x=local} print(x)', absent)).output).toEqual(["ok"]);
        await expect(run('repeat 1 {let local="ok"} print(local)', absent)).rejects.toThrow("Unknown variable");
    });

    test("budgets reject extra model calls", async () => {
        await expect(
            run('repeat 5 {repeat 5 {let a=write "a"}}', { ...absent, write: async () => "a" })
        ).rejects.toThrow("12 model-call limit");
    });

    test("cancelled runs do not execute effects", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(run('print("no")', absent, { signal: controller.signal })).rejects.toThrow();
    });

    test("malformed source and host-language escapes are rejected before execution", () => {
        for (const source of [
            "print(process.env)",
            'let x = "unterminated',
            "repeat 500 {}",
            'if input() feels "yes" with confidence 5% {}',
            'match "x" {"one" => {}}',
            'print("x") }',
            'let if="no"',
            'let x = fetch("url")',
        ]) {
            expect(() => parse(source)).toThrow();
        }

        expect(() => parse(`${"repeat 1 {".repeat(14)}${"}".repeat(14)}`)).toThrow("Nesting");
    });

    test("probabilities and replay data are validated", () => {
        for (const p of [{ a: 2, b: -1 }, { a: Number.NaN, b: 1 }, { a: 0, b: 0 }, { a: 0.5 }, { a: "0.5", b: 0.5 }]) {
            expect(() => distribution(p, ["a", "b"])).toThrow();
        }

        expect(distribution({ a: 0.501, b: 0.501 }, ["a", "b"])).toEqual({ a: 0.5, b: 0.5 });
    });

    test("all bundled programs parse", () => {
        for (const example of loadCorpus()) {
            expect(parse(example.source).length).toBeGreaterThan(0);
            expect(parse(readBundledExample(example.file)).length).toBeGreaterThan(0);
        }
    });

    test("llm and legacy write produce compatible replay effects", async () => {
        const original = await run(
            'let draft=write "rewrite" using input() print(draft)',
            {
                ...absent,
                write: async () => "plain text",
            },
            { input: "jargon" }
        );
        const replay = await run('let draft=llm "rewrite" using input() print(draft)', absent, {
            input: "jargon",
            replay: original.tape,
        });
        expect(replay.output).toEqual(["plain text"]);
    });

    test("hello example runs without model calls", async () => {
        const source = readBundledExample("hello");
        const result = await run(source, absent);
        expect(result.output[0]).toBe("Hello, uncertainty.");
        expect(result.tape).toEqual([]);
    });
});
