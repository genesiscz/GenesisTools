import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { requireInteractiveTty } from "./tty-guard";

describe("requireInteractiveTty", () => {
    let origIsTTY: boolean | undefined;

    beforeEach(() => {
        origIsTTY = process.stdin.isTTY;
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    });

    // Regression test: #446 item 4 — an Ink screen rendered against a non-TTY
    // stdin (agents, CI, cron) crashed with a full React/reconciler stack
    // instead of one clear line.
    it("prints one line, sets exit code 1, and returns false when stdin is not a TTY", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
        const printSpy = spyOn(out, "printlnErr");
        const originalExitCode = process.exitCode;

        const result = requireInteractiveTty();

        expect(result).toBe(false);
        expect(printSpy).toHaveBeenCalledWith(expect.stringContaining("needs an interactive terminal"));
        expect(process.exitCode).toBe(1);
        printSpy.mockRestore();
        process.exitCode = originalExitCode;
    });

    it("includes the given hint in the printed line", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
        const printSpy = spyOn(out, "printlnErr");

        requireInteractiveTty({ hint: "use --json" });

        expect(printSpy).toHaveBeenCalledWith(expect.stringContaining("use --json"));
        printSpy.mockRestore();
    });

    it("returns true and prints nothing when stdin is a TTY", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        const printSpy = spyOn(out, "printlnErr");

        const result = requireInteractiveTty();

        expect(result).toBe(true);
        expect(printSpy).not.toHaveBeenCalled();
        printSpy.mockRestore();
    });

    // Regression test: PR #456 review — Ink reads `options.stdin` when one is given, so a redirected
    // process.stdin must not refuse a render whose own input stream is a terminal
    it("checks the stdin it is given instead of process.stdin", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
        const printSpy = spyOn(out, "printlnErr");

        expect(requireInteractiveTty({ stdin: { isTTY: true } })).toBe(true);
        expect(printSpy).not.toHaveBeenCalled();
        printSpy.mockRestore();
    });

    it("refuses a given stdin that is not a TTY even when process.stdin is one", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        const printSpy = spyOn(out, "printlnErr");
        const originalExitCode = process.exitCode;

        expect(requireInteractiveTty({ stdin: { isTTY: false } })).toBe(false);
        expect(printSpy).toHaveBeenCalledWith(expect.stringContaining("needs an interactive terminal"));
        printSpy.mockRestore();
        process.exitCode = originalExitCode;
    });
});

// Regression test: #446 item 4 — `renderFullScreen` (the shared mount point behind
// `tools claude usage`, `tools ai usage`, …) called Ink's `render()` even when stdin
// was not a TTY, which threw Ink's raw-mode React/reconciler stack instead of a clear
// message. Mocked at the "ink" boundary so this never actually mounts a real screen.
describe("renderFullScreen", () => {
    let origIsTTY: boolean | undefined;

    beforeEach(() => {
        origIsTTY = process.stdin.isTTY;
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
        mock.restore();
    });

    it("never calls Ink's render when stdin is not a TTY", async () => {
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

        const renderSpy = mock(() => ({ waitUntilExit: () => Promise.resolve() }));
        mock.module("ink", () => ({ render: renderSpy }));

        const { renderFullScreen } = await import("./fullscreen");
        await renderFullScreen(null);

        expect(renderSpy).not.toHaveBeenCalled();
    });
});

// Regression test: #446 item 4 (aside) — ink and react-reconciler pick their dev/production
// build off `process.env.NODE_ENV` the moment they are first required (`react/index.js`:
// `require(NODE_ENV === "production" ? "./cjs/react.production.js" : "./cjs/react.development.js")`).
// Every Ink CLI ran with NODE_ENV unset, so they always loaded the slower, warning-noisy
// development build. Each test is a real child process: no mock can observe which of two
// on-disk files `require()` actually resolved.
describe("ink/react-production", () => {
    function loadedReactReconcilerBuild(nodeEnv: string | undefined): string {
        const snapshot = env.getProcessEnv();
        const childEnv: Record<string, string> = {};

        for (const [key, value] of Object.entries(snapshot)) {
            if (value !== undefined && key !== "NODE_ENV") {
                childEnv[key] = value;
            }
        }

        if (nodeEnv !== undefined) {
            childEnv.NODE_ENV = nodeEnv;
        }

        const result = Bun.spawnSync({
            cmd: [
                "bun",
                "-e",
                `
                import { createRequire } from "node:module";
                const req = createRequire(import.meta.url);
                await import("@genesiscz/utils/ink/react-production");
                await import("react-reconciler");
                const key = Object.keys(req.cache).find(
                    (k) => k.endsWith("react-reconciler.production.js") || k.endsWith("react-reconciler.development.js")
                );
                console.log(key ?? "none");
                `,
            ],
            cwd: process.cwd(),
            env: childEnv,
        });

        return new TextDecoder().decode(result.stdout).trim();
    }

    it("loads the production react-reconciler build when NODE_ENV is unset", () => {
        const loaded = loadedReactReconcilerBuild(undefined);

        expect(loaded.endsWith("react-reconciler.production.js")).toBe(true);
    });

    it("keeps the development build when NODE_ENV=development is set explicitly", () => {
        const loaded = loadedReactReconcilerBuild("development");

        expect(loaded.endsWith("react-reconciler.development.js")).toBe(true);
    });
});
