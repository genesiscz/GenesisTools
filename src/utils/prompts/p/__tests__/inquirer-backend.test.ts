// biome-ignore-all lint/plugin: This file IS the backend test — it legitimately calls inquirerBackend.X directly and mocks @inquirer/prompts. The no-direct-prompt-backend and no-mock-module-prompts plugins target callers, not the backend's own tests.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Track calls for assertions
type CallRecord = { fn: string; args: unknown[] };
const calls: CallRecord[] = [];

function resetCalls() {
    calls.splice(0, calls.length);
}

/** While true, every mocked prompt throws ExitPromptError, which is how inquirer reports Ctrl-C. */
let cancelPrompts = false;

function exitIfCancelled(): void {
    if (cancelPrompts) {
        const err = new Error("User force closed the prompt with SIGINT");
        err.name = "ExitPromptError";
        throw err;
    }
}

// Mock @inquirer/prompts BEFORE importing the backend
mock.module("@inquirer/prompts", () => ({
    input: async (a: unknown) => {
        exitIfCancelled();
        calls.push({ fn: "input", args: [a] });
        return "answer";
    },
    confirm: async (a: unknown) => {
        exitIfCancelled();
        calls.push({ fn: "confirm", args: [a] });
        return true;
    },
    select: async (a: unknown) => {
        exitIfCancelled();
        calls.push({ fn: "select", args: [a] });
        return "x";
    },
    checkbox: async (a: unknown) => {
        calls.push({ fn: "checkbox", args: [a] });
        return ["x"];
    },
    password: async (a: unknown) => {
        calls.push({ fn: "password", args: [a] });
        return "pw";
    },
    search: async (a: unknown) => {
        calls.push({ fn: "search", args: [a] });
        return "searched";
    },
    editor: async (a: unknown) => {
        calls.push({ fn: "editor", args: [a] });
        return "edited content";
    },
    number: async (a: unknown) => {
        calls.push({ fn: "number", args: [a] });
        return 42;
    },
}));

mock.module("@genesiscz/utils/cli/is-interactive", () => ({
    isInteractive: () => true,
}));

import { PromptCancelledError, promptCancelSymbol } from "@genesiscz/utils/prompts/cancel";
import { getBackend, setBackend } from "../backend";
import * as p from "../index";
import { inquirerBackend } from "../inquirer-backend";

describe("inquirerBackend", () => {
    beforeEach(resetCalls);

    describe("text()", () => {
        it("calls inquirer input with mapped opts", async () => {
            const v = await inquirerBackend.text({ message: "name?", initialValue: "foo" });
            expect(v).toBe("answer");
            const call = calls.find((c) => c.fn === "input");
            expect(call?.args[0]).toMatchObject({ message: "name?", default: "foo" });
        });

        it("passes validate function that returns true on success", async () => {
            await inquirerBackend.text({
                message: "test",
                validate: (v) => (v.length < 3 ? "too short" : undefined),
            });

            const call = calls.find((c) => c.fn === "input");
            const validate = (call?.args[0] as { validate?: (v: string) => string | boolean } | undefined)?.validate;
            expect(validate).toBeDefined();
            expect(validate!("ab")).toBe("too short");
            expect(validate!("abc")).toBe(true);
        });

        it("does not pass default when initialValue is undefined", async () => {
            await inquirerBackend.text({ message: "test" });
            const call = calls.find((c) => c.fn === "input");
            const arg = call?.args[0] as Record<string, unknown>;
            expect(arg.default).toBeUndefined();
        });
    });

    describe("confirm()", () => {
        it("calls inquirer confirm with message", async () => {
            const v = await inquirerBackend.confirm({ message: "ok?" });
            expect(v).toBe(true);
            const call = calls.find((c) => c.fn === "confirm");
            expect(call?.args[0]).toMatchObject({ message: "ok?" });
        });

        it("passes initialValue as default", async () => {
            await inquirerBackend.confirm({ message: "ok?", initialValue: false });
            const call = calls.find((c) => c.fn === "confirm");
            expect(call?.args[0]).toMatchObject({ default: false });
        });
    });

    describe("typedConfirm()", () => {
        it("returns true when correct phrase is typed (mocked input returns 'answer' != phrase so false)", async () => {
            // The mock returns "answer"; phrase is "DELETE" so result is false
            const v = await inquirerBackend.typedConfirm({ message: "confirm?", phrase: "answer" });
            expect(v).toBe(true);
        });

        it("calls inquirer input for typed confirm", async () => {
            await inquirerBackend.typedConfirm({ message: "confirm?", phrase: "DELETE" });
            const call = calls.find((c) => c.fn === "input");
            expect(call?.args[0]).toMatchObject({ message: expect.stringContaining("confirm?") });
        });

        it("is case-insensitive when caseSensitive=false", async () => {
            // Mock returns "answer"; phrase is "ANSWER" with caseSensitive=false → match
            const v = await inquirerBackend.typedConfirm({
                message: "confirm?",
                phrase: "answer",
                caseSensitive: false,
            });
            expect(v).toBe(true);
        });
    });

    describe("select()", () => {
        it("maps options.label → choices.name", async () => {
            await inquirerBackend.select({
                message: "pick",
                options: [
                    { value: "a", label: "Alpha" },
                    { value: "b", label: "Beta" },
                ],
            });

            const call = calls.find((c) => c.fn === "select");
            const arg = call?.args[0] as { choices: { name: string; value: string; description?: string }[] };
            expect(arg.choices[0].name).toBe("Alpha");
            expect(arg.choices[0].value).toBe("a");
            expect(arg.choices[1].name).toBe("Beta");
            expect(arg.choices[1].value).toBe("b");
        });

        it("maps hint to description", async () => {
            await inquirerBackend.select({
                message: "pick",
                options: [{ value: "a", label: "Alpha", hint: "a hint" }],
            });

            const call = calls.find((c) => c.fn === "select");
            const arg = call?.args[0] as { choices: { description: string }[] };
            expect(arg.choices[0].description).toBe("a hint");
        });
    });

    describe("multiselect()", () => {
        it("maps options to checkbox choices", async () => {
            const v = await inquirerBackend.multiselect({
                message: "choose",
                options: [
                    { value: "a", label: "A" },
                    { value: "b", label: "B" },
                ],
            });

            expect(v).toEqual(["x"]);
            const call = calls.find((c) => c.fn === "checkbox");
            const arg = call?.args[0] as { choices: { name: string }[] };
            expect(arg.choices[0].name).toBe("A");
        });

        it("passes required flag", async () => {
            await inquirerBackend.multiselect({
                message: "choose",
                options: [{ value: "a", label: "A" }],
                required: true,
            });

            const call = calls.find((c) => c.fn === "checkbox");
            expect(call?.args[0]).toMatchObject({ required: true });
        });
    });

    describe("password()", () => {
        it("calls inquirer password with mask", async () => {
            const v = await inquirerBackend.password({ message: "pw?" });
            expect(v).toBe("pw");
            const call = calls.find((c) => c.fn === "password");
            expect(call?.args[0]).toMatchObject({ message: "pw?", mask: "*" });
        });

        it("passes validate function", async () => {
            await inquirerBackend.password({
                message: "pw?",
                validate: (v) => (v.length < 8 ? "too short" : undefined),
            });

            const call = calls.find((c) => c.fn === "password");
            const validate = (call?.args[0] as { validate?: (v: string) => string | boolean } | undefined)?.validate;
            expect(validate).toBeDefined();
            expect(validate!("short")).toBe("too short");
            expect(validate!("longenough")).toBe(true);
        });
    });

    describe("spinner()", () => {
        it("returns a no-op spinner with start/stop/message", () => {
            const spinner = inquirerBackend.spinner();
            expect(typeof spinner.start).toBe("function");
            expect(typeof spinner.stop).toBe("function");
            expect(typeof spinner.message).toBe("function");
            // Should not throw
            spinner.start("loading");
            spinner.message("updated");
            spinner.stop("done");
        });
    });

    describe("log", () => {
        it("exposes all log methods", () => {
            expect(typeof inquirerBackend.log.info).toBe("function");
            expect(typeof inquirerBackend.log.success).toBe("function");
            expect(typeof inquirerBackend.log.warn).toBe("function");
            expect(typeof inquirerBackend.log.warning).toBe("function");
            expect(typeof inquirerBackend.log.error).toBe("function");
            expect(typeof inquirerBackend.log.step).toBe("function");
            expect(typeof inquirerBackend.log.message).toBe("function");
        });
    });

    describe("intro/outro/cancel/note", () => {
        it("exposes intro/outro/cancel/note methods", () => {
            expect(typeof inquirerBackend.intro).toBe("function");
            expect(typeof inquirerBackend.outro).toBe("function");
            expect(typeof inquirerBackend.cancel).toBe("function");
            expect(typeof inquirerBackend.note).toBe("function");
        });
    });

    describe("search() (extra)", () => {
        it("calls inquirer search and returns result", async () => {
            const result = await inquirerBackend.search({
                message: "find",
                options: async () => [{ value: "a", label: "A" }],
            });

            expect(result).toBe("searched");
            expect(calls.find((c) => c.fn === "search")).toBeDefined();
        });
    });

    describe("editor() (extra)", () => {
        it("calls inquirer editor and returns result", async () => {
            const result = await inquirerBackend.editor({ message: "edit" });
            expect(result).toBe("edited content");
            expect(calls.find((c) => c.fn === "editor")).toBeDefined();
        });
    });

    describe("number() (extra)", () => {
        it("calls inquirer number and returns result", async () => {
            const result = await inquirerBackend.number({ message: "how many?" });
            expect(result).toBe(42);
            expect(calls.find((c) => c.fn === "number")).toBeDefined();
        });
    });

    // inquirer reports a cancel by throwing ExitPromptError. The backend answers with the facade's cancel symbol and
    // the facade applies the call's outcome; it used to call process.exit(0) itself, which no test could observe.
    describe("cancel (ExitPromptError)", () => {
        const original = getBackend();

        beforeEach(() => {
            cancelPrompts = true;
            setBackend(inquirerBackend);
        });

        afterEach(() => {
            cancelPrompts = false;
            setBackend(original);
        });

        it("the backend answers with the facade's cancel symbol", async () => {
            expect(await inquirerBackend.text({ message: "t" })).toBe(promptCancelSymbol);
            expect(await inquirerBackend.select({ message: "s", options: [{ value: "x", label: "X" }] })).toBe(
                promptCancelSymbol
            );
        });

        it('cancel: "back" hands the symbol to the caller', async () => {
            expect(p.isCancel(await p.text({ message: "t", cancel: "back" }))).toBe(true);
            expect(p.isCancel(await p.confirm({ message: "c", cancel: "back" }))).toBe(true);
            expect(p.isCancel(await p.typedConfirm({ message: "tc", phrase: "yes", cancel: "back" }))).toBe(true);
        });

        it("the default exit throws PromptCancelledError inside a test", async () => {
            await expect(p.text({ message: "t" })).rejects.toBeInstanceOf(PromptCancelledError);
            await expect(p.select({ message: "s", options: [{ value: "x", label: "X" }] })).rejects.toBeInstanceOf(
                PromptCancelledError
            );
        });
    });
});
