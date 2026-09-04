import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHunks } from "./resolve-hunks";

const SCRIPT = join(import.meta.dir, "resolve-hunks.ts");

const DIFF3 = [
    "a",
    "<<<<<<< HEAD",
    "ours line",
    "||||||| merged common ancestors",
    "base line",
    "=======",
    "theirs line",
    ">>>>>>> feat/x",
    "z",
    "",
].join("\n");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resolve-hunks-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("resolveHunks with diff3 conflict style", () => {
    test("ours keeps only the ours text, never the base section or its marker", () => {
        expect(resolveHunks(DIFF3, "ours", new Set()).text).toBe("a\nours line\nz\n");
    });

    test("theirs is unaffected by the base section", () => {
        expect(resolveHunks(DIFF3, "theirs", new Set())).toEqual({ text: "a\ntheirs line\nz\n", hunks: 1 });
    });

    test("the CLI refuses to write while a base marker would remain", () => {
        const file = join(dir, "conflicted.txt");
        writeFileSync(file, `${DIFF3}||||||| stray\n`);
        const proc = Bun.spawnSync([process.execPath, SCRIPT, file, "ours"], { stdout: "pipe", stderr: "pipe" });

        expect(proc.exitCode).toBe(1);
        expect(proc.stderr.toString()).toContain("markers would remain");
        expect(readFileSync(file, "utf8")).toBe(`${DIFF3}||||||| stray\n`);
    });
});

const CRLF = ["a", "<<<<<<< HEAD", "ours line", "=======", "theirs line", ">>>>>>> feat/x", "z", ""].join("\r\n");

const NO_TRAILING_NEWLINE = ["a", "<<<<<<< HEAD", "ours line", "=======", "theirs line", ">>>>>>> feat/x"].join("\n");

describe("resolveHunks with line endings git writes but the regex must not assume", () => {
    test("a CRLF conflict resolves and keeps its CRLF endings", () => {
        expect(resolveHunks(CRLF, "ours", new Set())).toEqual({ text: "a\r\nours line\r\nz\r\n", hunks: 1 });
    });

    test("a CRLF conflict resolves to theirs as well", () => {
        expect(resolveHunks(CRLF, "theirs", new Set())).toEqual({ text: "a\r\ntheirs line\r\nz\r\n", hunks: 1 });
    });

    test("a closing marker at EOF without a trailing newline still resolves", () => {
        expect(resolveHunks(NO_TRAILING_NEWLINE, "ours", new Set())).toEqual({ text: "a\nours line\n", hunks: 1 });
    });
});

const MARKER_IN_CONTENT = [
    "a",
    "<<<<<<< HEAD",
    'const label = "||||||| not a base";',
    "=======",
    "theirs line",
    ">>>>>>> feat/x",
    "z",
    "",
].join("\n");

describe("resolveHunks treats markers as structure only at the start of a line", () => {
    test("a marker-like string inside an ours line survives intact", () => {
        expect(resolveHunks(MARKER_IN_CONTENT, "ours", new Set())).toEqual({
            text: 'a\nconst label = "||||||| not a base";\nz\n',
            hunks: 1,
        });
    });
});
