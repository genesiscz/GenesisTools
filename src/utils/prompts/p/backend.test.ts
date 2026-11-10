import { afterEach, describe, expect, it } from "bun:test";
import { PromptCancelledError } from "@genesiscz/utils/prompts/cancel";
import { CANCEL_ANSWER, makeTestBackend } from "./__tests__/test-backend";
import * as p from "./index";

describe("p/ default backend (static clack, sync — no opentui)", () => {
    it("getBackend() returns a working clack backend WITHOUT a prior setBackend, and stays sync", () => {
        const { getBackend } = require("./backend") as typeof import("./backend");
        const b = getBackend(); // SYNC — no await (advisor: 700+ sync log.* callers)
        expect(typeof b.text).toBe("function");
        expect(typeof b.log.info).toBe("function");
    });
    it("does not pull @opentui into the module graph from the default path", () => {
        // resolved specifiers of the loaded p/ graph must not include @opentui
        const ids = Object.keys(require.cache ?? {});
        expect(ids.some((m) => m.includes("@opentui"))).toBe(false);
    });
});

describe("p/ cancel outcome on the test adapter", () => {
    const { getBackend, setBackend } = require("./backend") as typeof import("./backend");
    const original = getBackend();

    afterEach(() => {
        setBackend(original);
    });

    const cancelEverything = () =>
        makeTestBackend(
            Object.fromEntries(
                [
                    "text",
                    "confirm",
                    "typedConfirm",
                    "select",
                    "multiselect",
                    "password",
                    "search",
                    "editor",
                    "number",
                ].map((key) => [key, CANCEL_ANSWER])
            )
        );

    it('cancel: "back" hands the cancel symbol to the caller for every prompt', async () => {
        setBackend(cancelEverything());
        const answers = [
            await p.text({ message: "t", cancel: "back" }),
            await p.confirm({ message: "c", cancel: "back" }),
            await p.typedConfirm({ message: "tc", phrase: "yes", cancel: "back" }),
            await p.select({ message: "s", options: [{ value: "a", label: "A" }], cancel: "back" }),
            await p.multiselect({ message: "m", options: [{ value: "a", label: "A" }], cancel: "back" }),
            await p.password({ message: "pw", cancel: "back" }),
            await p.search({ message: "se", options: async () => [], cancel: "back" }),
            await p.editor({ message: "e", cancel: "back" }),
            await p.number({ message: "n", cancel: "back" }),
        ];

        expect(answers.map((answer) => p.isCancel(answer))).toEqual(answers.map(() => true));
    });

    it("the default exit ends the prompt with PromptCancelledError inside a test, for every prompt", async () => {
        setBackend(cancelEverything());
        const calls: Array<() => Promise<unknown>> = [
            () => p.text({ message: "t" }),
            () => p.confirm({ message: "c", cancel: "exit" }),
            () => p.typedConfirm({ message: "tc", phrase: "yes" }),
            () => p.select({ message: "s", options: [{ value: "a", label: "A" }] }),
            () => p.multiselect({ message: "m", options: [{ value: "a", label: "A" }] }),
            () => p.password({ message: "pw" }),
            () => p.search({ message: "se", options: async () => [] }),
            () => p.editor({ message: "e" }),
            () => p.number({ message: "n" }),
        ];

        for (const call of calls) {
            await expect(call()).rejects.toBeInstanceOf(PromptCancelledError);
        }
    });

    it("an answer passes through unchanged with either outcome", async () => {
        setBackend(makeTestBackend({ text: "typed", select: "b" }));

        expect(await p.text({ message: "t" })).toBe("typed");
        expect(await p.select({ message: "s", options: [{ value: "b", label: "B" }], cancel: "back" })).toBe("b");
    });

    it("group calls onCancel for a member cancelled with back and keeps the answers before it", async () => {
        setBackend(makeTestBackend({ "text.0": "first", "text.1": CANCEL_ANSWER }));
        const seen: unknown[] = [];

        const answers = await p.group(
            {
                one: () => p.text({ message: "one", cancel: "back" }),
                two: () => p.text({ message: "two", cancel: "back" }),
            },
            { onCancel: ({ results }) => seen.push({ ...results }) }
        );

        expect(seen).toEqual([{ one: "first", two: "canceled" }]);
        expect(answers.one).toBe("first");
    });
});
