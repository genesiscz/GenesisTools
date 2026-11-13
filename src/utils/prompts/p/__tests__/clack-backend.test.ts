import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import * as clack from "@clack/prompts";
import { env } from "@genesiscz/utils/env";
import { PromptCancelledError, promptCancelSymbol } from "@genesiscz/utils/prompts/cancel";
import { setBackend } from "../backend";
import { clackBackend } from "../clack-backend";
import * as p from "../index";

describe("clack backend", () => {
    it("exposes all required methods", () => {
        expect(typeof clackBackend.intro).toBe("function");
        expect(typeof clackBackend.outro).toBe("function");
        expect(typeof clackBackend.text).toBe("function");
        expect(typeof clackBackend.confirm).toBe("function");
        expect(typeof clackBackend.typedConfirm).toBe("function");
        expect(typeof clackBackend.select).toBe("function");
        expect(typeof clackBackend.multiselect).toBe("function");
        expect(typeof clackBackend.spinner).toBe("function");
        expect(clackBackend.log.info).toBeDefined();
    });
});

const ORIGINAL_CI = env.get("CI");
const PROCESS_EVENTS = ["SIGINT", "SIGTERM", "exit", "unhandledRejection", "uncaughtExceptionMonitor"] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences on purpose
const CURSOR_CONTROL = /\u001b\[[0-9;?]*[A-LN-Za-ln-z]/;

function recordingStream() {
    const chunks: string[] = [];
    let pending: { includes: string; resolve: () => void } | undefined;
    const text = () => chunks.join("");
    const output = new Writable({
        write(chunk, _encoding, done) {
            chunks.push(String(chunk));
            const current = pending;

            if (current && text().includes(current.includes)) {
                pending = undefined;
                current.resolve();
            }

            done();
        },
    });

    function whenWritten(includes: string, what: string): Promise<void> {
        const timeoutMs = 2000;

        if (text().includes(includes)) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }

                settled = true;
                pending = undefined;
                reject(new Error(`waited ${timeoutMs} ms for ${what}`));
            }, timeoutMs);
            pending = {
                includes,
                resolve: () => {
                    if (settled) {
                        return;
                    }

                    settled = true;
                    clearTimeout(timer);
                    resolve();
                },
            };

            if (text().includes(includes)) {
                const current = pending;
                pending = undefined;
                current.resolve();
            }
        });
    }

    return { output, text, whenWritten };
}

// Regression test: the patch in patches/@clack%2Fprompts@1.7.0.patch makes the spinner treat an output stream that
// is not a terminal like CI. Without it the spinner redraws with cursor escapes on every tick, and the patch can
// apply cleanly yet stop changing the runtime path.
describe("patched clack spinner on a stream that is not a terminal", () => {
    afterEach(() => {
        if (ORIGINAL_CI === undefined) {
            env.testing.unset("CI");
        } else {
            env.testing.set("CI", ORIGINAL_CI);
        }
    });

    it("keeps every message, stays quiet between messages, writes no cursor escapes and releases its listeners", async () => {
        // CI mode would hide the patch's effect, so the test runs as a developer machine does
        env.testing.set("CI", "false");
        const listeners = () => PROCESS_EVENTS.map((name) => process.listenerCount(name));
        const before = listeners();
        const stream = recordingStream();
        const spinner = clack.spinner({ output: stream.output, indicator: "dots" });

        spinner.start("loading");
        await stream.whenWritten("loading", "the first message");
        const settled = stream.text().length;
        await Bun.sleep(300);

        expect(stream.text().length).toBe(settled);

        spinner.message("parsing");
        await stream.whenWritten("parsing", "the changed message");
        spinner.stop("done");

        const text = stream.text();
        expect(text).toContain("loading");
        expect(text).toContain("parsing");
        expect(text).toContain("done");
        expect(text).not.toMatch(CURSOR_CONTROL);
        expect(listeners()).toEqual(before);
    });
});

// A real clack prompt with an aborted signal answers with clack's own cancel symbol, as Escape does. The mock only adds
// that signal and silent streams to the backend's calls; the cancel symbol and the backend's mapping of it are real.
describe("cancel outcome on the clack backend", () => {
    const real = { ...clack };
    const silent = () => new Writable({ write: (_chunk, _encoding, done) => done() });
    const aborted = { signal: AbortSignal.abort(), input: new PassThrough(), output: silent() };

    beforeAll(() => {
        mock.module("@clack/prompts", () => ({
            ...real,
            text: (opts: clack.TextOptions) => real.text({ ...opts, ...aborted }),
            confirm: (opts: clack.ConfirmOptions) => real.confirm({ ...opts, ...aborted }),
            select: (opts: clack.SelectOptions<unknown>) => real.select({ ...opts, ...aborted }),
            multiselect: (opts: clack.MultiSelectOptions<unknown>) => real.multiselect({ ...opts, ...aborted }),
        }));
        setBackend(clackBackend);
    });

    afterAll(() => {
        mock.module("@clack/prompts", () => real);
    });

    it("the backend answers a cancelled prompt with the facade's cancel symbol", async () => {
        expect(await clackBackend.text({ message: "t" })).toBe(promptCancelSymbol);
        expect(await clackBackend.select({ message: "s", options: [{ value: "a", label: "A" }] })).toBe(
            promptCancelSymbol
        );
    });

    it('cancel: "back" hands the symbol to the caller', async () => {
        expect(p.isCancel(await p.text({ message: "t", cancel: "back" }))).toBe(true);
        expect(p.isCancel(await p.confirm({ message: "c", cancel: "back" }))).toBe(true);
        expect(
            p.isCancel(await p.multiselect({ message: "m", options: [{ value: 1, label: "one" }], cancel: "back" }))
        ).toBe(true);
    });

    it("the default exit throws PromptCancelledError inside a test", async () => {
        await expect(p.text({ message: "t" })).rejects.toBeInstanceOf(PromptCancelledError);
        await expect(p.select({ message: "s", options: [{ value: "a", label: "A" }] })).rejects.toBeInstanceOf(
            PromptCancelledError
        );
    });
});
