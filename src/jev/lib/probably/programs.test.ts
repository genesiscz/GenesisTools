import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgramStore } from "./programs";
import { absentProvider } from "./providers";
import { resolveProbablyInput, runStoredProgram } from "./run-program";

describe("Probably program store", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    function tempStore() {
        const directory = mkdtempSync(join(tmpdir(), "jev-probably-"));
        dirs.push(directory);
        return createProgramStore({ directory });
    }

    test("save list get remove round-trip", () => {
        const store = tempStore();
        expect(store.list()).toEqual([]);
        store.save("hello", 'print("hi")');
        expect(store.list().map((p) => p.name)).toEqual(["hello"]);
        expect(store.get("hello").source).toContain('print("hi")');
        store.remove("hello");
        expect(store.list()).toEqual([]);
    });

    test("rejects bad names and empty source", () => {
        const store = tempStore();
        expect(() => store.save("../x", "print(1)")).toThrow(/name/);
        expect(() => store.save("ok", "   ")).toThrow(/empty/);
    });

    test("runStoredProgram executes a saved hello program", async () => {
        const store = tempStore();
        store.save(
            "hello",
            `let greeting = "Hello, uncertainty."
print(greeting)
`
        );
        const result = await runStoredProgram({
            name: "hello",
            store,
            liveProvider: absentProvider(),
        });
        expect(result.output).toEqual(["Hello, uncertainty."]);
    });
});

describe("resolveProbablyInput", () => {
    test("literal and empty", async () => {
        expect(await resolveProbablyInput(undefined)).toEqual({ input: "", source: "empty" });
        expect(await resolveProbablyInput("hello")).toEqual({ input: "hello", source: "flag" });
    });

    test("inline JSON object", async () => {
        expect(await resolveProbablyInput('{"input":"from json"}')).toEqual({
            input: "from json",
            source: "json",
        });
    });

    test("@file and path", async () => {
        const dir = mkdtempSync(join(tmpdir(), "jev-probably-input-"));
        const file = join(dir, "msg.txt");
        const json = join(dir, "msg.json");
        await Bun.write(file, "file text");
        await Bun.write(json, '{"input":"json file"}');

        try {
            expect(await resolveProbablyInput(`@${file}`)).toEqual({ input: "file text", source: "file" });
            expect(await resolveProbablyInput(json)).toEqual({ input: "json file", source: "json" });
            expect(await resolveProbablyInput(file)).toEqual({ input: "file text", source: "file" });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
