import { afterEach, describe, expect, it } from "bun:test";
import type { PromptBackend } from "../backend";
import { getBackend, setBackend } from "../backend";
import type { EditorOpts, NumberOpts, SearchOpts } from "../types";

/**
 * Tests for search/editor/number backend routing.
 * Uses a mock backend to verify that p.search/editor/number route calls
 * through to the active backend with the correct opts.
 */

describe("search/editor/number backend routing", () => {
    const originalBackend = getBackend();

    afterEach(() => {
        setBackend(originalBackend);
    });

    function makeMockBackend() {
        const calls: { method: string; opts: unknown }[] = [];

        const mock: PromptBackend = {
            intro: () => {},
            outro: () => {},
            cancel: () => {},
            note: () => {},
            text: async () => "",
            confirm: async () => true,
            typedConfirm: async () => true,
            select: async () => "value",
            multiselect: async () => [],
            password: async () => "",
            search: async <T>(opts: SearchOpts<T>) => {
                calls.push({ method: "search", opts });
                return {} as T;
            },
            editor: async (opts: EditorOpts) => {
                calls.push({ method: "editor", opts });
                return "edited content";
            },
            number: async (opts: NumberOpts) => {
                calls.push({ method: "number", opts });
                return opts.initialValue ?? 42;
            },
            spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
            log: {
                info: () => {},
                success: () => {},
                warn: () => {},
                warning: () => {},
                error: () => {},
                step: () => {},
                message: () => {},
            },
        };

        return { mock, calls };
    }

    it("p.search() routes to backend.search() with opts", async () => {
        const { mock, calls } = makeMockBackend();
        setBackend(mock);

        const { search } = await import("../index");
        const opts: SearchOpts<string> = {
            message: "Find something",
            options: async (_input) => [{ value: "a", label: "Option A" }],
        };
        await search(opts);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("search");
        expect((calls[0]?.opts as SearchOpts<string>).message).toBe("Find something");
    });

    it("p.editor() routes to backend.editor() with opts", async () => {
        const { mock, calls } = makeMockBackend();
        setBackend(mock);

        const { editor } = await import("../index");
        const opts: EditorOpts = {
            message: "Edit your notes",
            initialValue: "initial text",
            postfix: ".md",
        };
        const result = await editor(opts);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("editor");
        expect((calls[0]?.opts as EditorOpts).message).toBe("Edit your notes");
        expect(result).toBe("edited content");
    });

    it("p.number() routes to backend.number() with opts", async () => {
        const { mock, calls } = makeMockBackend();
        setBackend(mock);

        const { number } = await import("../index");
        const opts: NumberOpts = {
            message: "Enter a number",
            initialValue: 7,
            min: 1,
            max: 100,
        };
        const result = await number(opts);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("number");
        expect((calls[0]?.opts as NumberOpts).message).toBe("Enter a number");
        expect(result).toBe(7);
    });

    it("opentuiBackend.search() throws unsupported error", async () => {
        const { opentuiBackend } = await import("../opentui-backend");
        // opentuiBackend requires a renderer arg; pass a minimal stub
        // biome-ignore lint/suspicious/noExplicitAny: test stub
        const backend = opentuiBackend({} as any);

        expect(() => backend.search({ message: "hi", options: async () => [] })).toThrow("does not support");
    });

    it("opentuiBackend.editor() throws unsupported error", async () => {
        const { opentuiBackend } = await import("../opentui-backend");
        // biome-ignore lint/suspicious/noExplicitAny: test stub
        const backend = opentuiBackend({} as any);

        expect(() => backend.editor({ message: "hi" })).toThrow("does not support");
    });

    it("opentuiBackend.number() throws unsupported error", async () => {
        const { opentuiBackend } = await import("../opentui-backend");
        // biome-ignore lint/suspicious/noExplicitAny: test stub
        const backend = opentuiBackend({} as any);

        expect(() => backend.number({ message: "hi" })).toThrow("does not support");
    });
});
