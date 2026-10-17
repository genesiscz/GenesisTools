import { afterEach, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import * as clack from "@clack/prompts";
import { env } from "@genesiscz/utils/env";
import { clackBackend } from "../clack-backend";

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
