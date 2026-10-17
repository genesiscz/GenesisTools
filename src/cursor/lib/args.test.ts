import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { type CursorArgs, parseCursorArgs } from "./args";

function parsed(argv: string[]): CursorArgs {
    const result = parseCursorArgs(argv, "/work/repo");

    if (!result.ok) {
        throw new Error(`expected the arguments to parse, got: ${result.message}`);
    }

    return result.args;
}

function refused(argv: string[]): string {
    const result = parseCursorArgs(argv, "/work/repo");

    if (result.ok) {
        throw new Error("expected the arguments to be refused");
    }

    return result.message;
}

describe("parseCursorArgs", () => {
    it("joins the positional words into the question and defaults to ask mode in the working directory", () => {
        expect(parsed(["which", "service", "books", "it?"])).toEqual({
            mode: "ask",
            model: undefined,
            workspace: "/work/repo",
            raw: false,
            help: false,
            question: "which service books it?",
        });
    });

    it("reads each option in both the spaced and the equals form", () => {
        const spaced = parsed(["--mode", "plan", "--model", "gpt-5", "--workspace", "/x", "--raw", "q"]);
        const equals = parsed(["--mode=plan", "--model=gpt-5", "--workspace=/x", "--raw", "q"]);

        expect(spaced).toEqual({
            mode: "plan",
            model: "gpt-5",
            workspace: "/x",
            raw: true,
            help: false,
            question: "q",
        });
        expect(equals).toEqual(spaced);
    });

    // Regression test: --mode=plan was ignored and ran in ask mode, and --mode=unsupported passed the guard
    it("checks the mode however it is written", () => {
        expect(refused(["--mode=unsupported", "q"])).toContain("Unknown --mode 'unsupported'");
        expect(refused(["--mode", "unsupported", "q"])).toContain("Unknown --mode 'unsupported'");
        expect(refused(["--mode=", "q"])).toContain("--mode needs a value");
    });

    it("refuses an option that is missing its value, including one followed by another option", () => {
        expect(refused(["q", "--model"])).toContain("--model needs a value");
        expect(refused(["--workspace", "--raw", "q"])).toContain("--workspace needs a value");
    });

    it("refuses an option it does not know instead of ignoring it", () => {
        expect(refused(["--force", "q"])).toContain("Unknown option --force");
        expect(refused(["--moode=plan", "q"])).toContain("Unknown option --moode");
    });

    it("refuses a short option it does not know, and a short option used as a value", () => {
        expect(refused(["-x", "q"])).toContain("Unknown option -x");
        expect(refused(["--model", "-x", "q"])).toContain("--model needs a value");
    });

    it("takes a question that starts with a dash after the -- end of options", () => {
        expect(parsed(["--", "-x", "q"]).question).toBe("-x q");
        expect(parsed(["hello", "--", "-x"]).question).toBe("hello -x");
        expect(parsed(["--", "--raw"])).toEqual({
            mode: "ask",
            model: undefined,
            workspace: "/work/repo",
            raw: false,
            help: false,
            question: "--raw",
        });
        expect(parsed(["--model", "gpt-5", "--", "-why"])).toEqual({
            mode: "ask",
            model: "gpt-5",
            workspace: "/work/repo",
            raw: false,
            help: false,
            question: "-why",
        });
        expect(parsed(["--", "-h"])).toEqual({
            mode: "ask",
            model: undefined,
            workspace: "/work/repo",
            raw: false,
            help: false,
            question: "-h",
        });
    });

    it("lets help win over everything else", () => {
        expect(parsed(["--nope", "--mode=bad", "-h"]).help).toBe(true);
        expect(parsed(["--help"]).help).toBe(true);
    });

    it("trims the question and leaves it empty when there are no positional words", () => {
        expect(parsed(["  spaced  "]).question).toBe("spaced");
        expect(parsed(["--raw"]).question).toBe("");
    });
});

describe("tools cursor entrypoint", () => {
    it.each([
        { words: ["ordinary", "question"] },
        { words: ["-why", "did", "this", "fail"] },
        { words: ["-h"] },
        { words: ["--raw"] },
    ])("forwards question words %j after the child's end-of-options marker", async ({ words }) => {
        const dir = mkdtempSync(join(tmpdir(), "cursor-bin-"));
        const marker = join(dir, "argv");
        writeFileSync(join(dir, "cursor"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\n`, { mode: 0o755 });

        try {
            const proc = Bun.spawn(
                [
                    "bun",
                    "run",
                    join(import.meta.dir, "../index.ts"),
                    "--mode=plan",
                    "--model=gpt-5",
                    "--workspace=/work/repo",
                    "--",
                    ...words,
                ],
                {
                    env: { ...process.env, PATH: `${dir}:${env.get("PATH") ?? ""}` },
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                }
            );
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);

            expect({ stdout, stderr, exitCode }).toEqual({ stdout: "", stderr: "", exitCode: 0 });
            expect(readFileSync(marker, "utf8").trimEnd().split("\n")).toEqual([
                "agent",
                "--mode=plan",
                "--print",
                "--stream-partial-output",
                "--output-format",
                "stream-json",
                "--trust",
                "--workspace",
                "/work/repo",
                "--model",
                "gpt-5",
                "--",
                words.join(" "),
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // Regression test: `--mode=unsupported` passed the guard and started Cursor in its default mode
    it("exits 1 and never starts cursor for an unsupported mode written with an equals sign", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cursor-bin-"));
        const marker = join(dir, "started");
        writeFileSync(join(dir, "cursor"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });

        try {
            const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../index.ts"), "--mode=unsupported", "q"], {
                env: { ...process.env, PATH: `${dir}:${env.get("PATH") ?? ""}` },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

            expect(exitCode).toBe(1);
            expect(stderr).toContain("Unknown --mode 'unsupported'");
            expect(existsSync(marker)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
