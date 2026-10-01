import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { parseItems, parseMs, registerAskCommand, withSupersedes } from "./ask";

describe("parseMs", () => {
    test("a non-numeric duration is refused instead of silently becoming NaN", () => {
        // NaN made `--timeout` mean "no timeout", and gave `--wait-timeout` a deadline that
        // can never pass — a wait that polls the store forever at zero sleep.
        expect(() => parseMs("abc")).toThrow();
    });

    test("an empty value is refused, because Number('') is 0 rather than NaN", () => {
        expect(() => parseMs("")).toThrow();
        expect(() => parseMs("   ")).toThrow();
    });

    test("a negative duration is refused", () => {
        expect(() => parseMs("-5")).toThrow();
    });

    test("a numeric PREFIX is refused, not silently truncated", () => {
        // parseInt read a prefix: "10ms" became 10 and "1.5" became 1, so a mistyped timeout
        // expired far earlier than the user asked for.
        expect(() => parseMs("10ms")).toThrow();
        expect(() => parseMs("1.5")).toThrow();
    });

    test("a plain millisecond count parses", () => {
        expect(parseMs("2500")).toBe(2500);
    });
});

describe("registerAskCommand", () => {
    function commandNamed(name: string) {
        const program = new Command();
        registerAskCommand(program);

        return program.commands.find((command) => command.name() === name);
    }

    test("answer offers --json, because a partial submit is never stored", () => {
        const answer = commandNamed("answer");

        expect(answer).toBeDefined();
        expect(answer?.options.some((option) => option.long === "--json")).toBe(true);
    });

    test("every duration flag refuses a non-numeric value", () => {
        for (const [command, flag] of [
            ["ask", "--timeout"],
            ["ask", "--wait-timeout"],
            ["wait", "--timeout"],
        ] as const) {
            const option = commandNamed(command)?.options.find((candidate) => candidate.long === flag);

            expect(option).toBeDefined();
            // Behavior, not identity: the old inline parser returned NaN here without a word.
            expect(() => option?.parseArg?.("abc", undefined)).toThrow();
        }
    });
});

describe("parseItems", () => {
    test("a decision written with the store's names says which keys to use and points to --help", () => {
        const json = '[{"type":"decision","prompt":"Keep?","options":["a","b"]}]';

        expect(() => parseItems({ json })).toThrow(/unknown key "prompt" \(did you mean promptMarkdown\?\)/);
        expect(() => parseItems({ json })).toThrow(/unknown key "options" \(did you mean choices\?\)/);
        expect(() => parseItems({ json })).toThrow(/Run tools question ask --help/);
    });

    test("an item without promptMarkdown is refused, also inside a question_post payload", () => {
        expect(() => parseItems({ json: '{"items":[{"type":"todo","title":"Rerun"}]}' })).toThrow(
            /item 1: promptMarkdown must be a non-empty string/
        );
    });

    test("a well-formed item passes through with the payload fields", () => {
        const parsed = parseItems({
            json: '{"items":[{"type":"decision","promptMarkdown":"Keep?","choices":["a"]}],"source":"test"}',
        });

        expect(parsed.items).toEqual([{ type: "decision", promptMarkdown: "Keep?", choices: ["a"] }]);
        expect(parsed.fields).toEqual({ source: "test" });
    });

    test("--help lists the item fields and an example", () => {
        const program = new Command();
        registerAskCommand(program);
        let help = "";
        const ask = program.commands.find((command) => command.name() === "ask");
        ask?.configureOutput({ writeOut: (text) => (help += text) });
        ask?.outputHelp();

        expect(help).toContain("promptMarkdown   required");
        expect(help).toContain('"recommended":"a"');
        expect(help).toContain("supersedes       decision/todo");
        expect(help).toContain("--no-transclude");

        for (const kind of ["lines", "file", "symbol", "diff", "tail", "json", "cmd", "url", "image", "pr-thread"]) {
            expect(help).toMatch(new RegExp(`\\n\\s+${kind}\\s+.*\\n.*params: .*\\n.*e\\.g\\. \\{\\{`));
        }
    });
});

describe("withSupersedes", () => {
    const decision = { type: "decision" as const, promptMarkdown: "Q?" };

    test("names the one decision or todo item of the post", () => {
        expect(withSupersedes([{ promptMarkdown: "form" }, decision], "d_2_s")).toEqual([
            { promptMarkdown: "form" },
            { ...decision, supersedes: "d_2_s" },
        ]);
    });

    test("refuses an ambiguous post and a form id", () => {
        expect(() => withSupersedes([decision, decision], "d_2_s")).toThrow("found 2");
        expect(() => withSupersedes([decision], "ask_123")).toThrow('not "ask_123"');
    });
});
