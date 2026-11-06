import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    coerceParam,
    listPresets,
    PRESET_META,
    PRESET_SCRIPT,
    readPreset,
    removePreset,
    resolveParams,
    savePreset,
    toolsetsNamedIn,
} from "./presets";
import { runPresetHere } from "./toolsets/presets";

const known = ["movies", "computer", "presets"];
const root = () => mkdtempSync(join(tmpdir(), "repl-presets-"));

describe("preset store", () => {
    test("saves a script with its params, lists and reads it; a second save keeps the created time", () => {
        const dir = root();
        const first = savePreset({
            name: "signup-demo",
            input: {
                script: "return await movies.demo({ title: params.title, steps: [] });",
                description: "the signup flow",
                params: { title: { type: "string", default: "Signup" }, steps: { type: "number" } },
            },
            knownToolsets: known,
            root: dir,
            now: new Date("2026-11-05T10:00:00Z"),
        });
        expect(first.meta.toolsets).toEqual(["movies"]);
        expect(readFileSync(join(dir, "signup-demo", PRESET_SCRIPT), "utf8")).toContain("movies.demo");
        const again = savePreset({
            name: "signup-demo",
            input: { script: "return 1;" },
            knownToolsets: known,
            root: dir,
            now: new Date("2026-11-05T11:00:00Z"),
        });
        expect(again.meta.createdAt).toBe("2026-11-05T10:00:00.000Z");
        expect(again.meta.updatedAt).toBe("2026-11-05T11:00:00.000Z");
        expect(listPresets(dir).map((preset) => preset.name)).toEqual(["signup-demo"]);
        expect(readPreset("signup-demo", dir).script).toBe("return 1;\n");
    });

    test("refuses a bad name and an unknown toolset, and names the saved ones for a missing preset", () => {
        const dir = root();
        expect(() =>
            savePreset({ name: "../escape", input: { script: "1" }, knownToolsets: known, root: dir })
        ).toThrow("a preset name is");
        expect(() =>
            savePreset({ name: "x", input: { script: "1", toolsets: ["nope"] }, knownToolsets: known, root: dir })
        ).toThrow("unknown toolset nope");
        savePreset({ name: "kept", input: { script: "1" }, knownToolsets: known, root: dir });
        expect(() => readPreset("missing", dir)).toThrow('no preset "missing"; saved: kept');
    });

    // NR19: a script that did not parse was saved and failed at its first run; zod's issue array was the CLI's message.
    test("refuses a script that does not parse and a bad name with one line, and writes nothing", () => {
        const dir = root();
        expect(() =>
            savePreset({ name: "broken", input: { script: "return ((( ;" }, knownToolsets: known, root: dir })
        ).toThrow(/^the script of preset broken does not parse: /);
        expect(existsSync(join(dir, "broken"))).toBe(false);
        expect(() =>
            savePreset({ name: "../escape", input: { script: "1" }, knownToolsets: known, root: dir })
        ).toThrow(
            /^a preset name is 1–64 letters, digits, dots, dashes or underscores, starting with a letter or digit$/
        );
    });

    // NR19: saving a name again replaced the script with no copy anywhere.
    test("saving a name again moves the old version to .trash", () => {
        const dir = root();
        savePreset({ name: "twice", input: { script: "return 'first';" }, knownToolsets: known, root: dir });
        const second = savePreset({
            name: "twice",
            input: { script: "return 'second';" },
            knownToolsets: known,
            root: dir,
        });
        expect(second.replaced).toBeDefined();
        expect(readFileSync(join(second.replaced ?? "", PRESET_SCRIPT), "utf8")).toBe("return 'first';\n");
        expect(readPreset("twice", dir).script).toBe("return 'second';\n");
    });

    test("removal moves the folder to .trash and the list drops it", () => {
        const dir = root();
        savePreset({ name: "old", input: { script: "1" }, knownToolsets: known, root: dir });
        const trash = removePreset("old", dir, new Date("2026-11-05T10:00:00Z"));
        expect(existsSync(join(trash, PRESET_META))).toBe(true);
        expect(listPresets(dir)).toEqual([]);
    });

    test("finds the toolsets a script names, not a word that only ends like one", () => {
        expect(toolsetsNamedIn("await movies.demo(); computer.click()", known)).toEqual(["movies", "computer"]);
        expect(toolsetsNamedIn("myMovies.length; x.movies.y", known)).toEqual([]);
    });
});

describe("preset params", () => {
    const meta = savePreset({
        name: "p",
        input: {
            script: "1",
            params: {
                url: { type: "string", default: "https://example.org" },
                count: { type: "number" },
                loud: { type: "boolean", default: false },
            },
        },
        knownToolsets: known,
        root: root(),
    }).meta;

    test("defaults fill the gaps; an unknown or a missing required value is refused", () => {
        expect(resolveParams(meta, { count: 3 })).toEqual({ url: "https://example.org", count: 3, loud: false });
        expect(() => resolveParams(meta, {})).toThrow("needs count");
        expect(() => resolveParams(meta, { count: 1, colour: "red" })).toThrow("has no param colour");
    });

    // NR19: in the REPL, presets.run('p', { url: 5 }) ran with a number for a string param; the CLI checked types.
    test("a value of the wrong type is refused, as the command line refuses it", () => {
        expect(() => resolveParams(meta, { count: 1, url: 5 })).toThrow("param url takes a string (got 5)");
        expect(() => resolveParams(meta, { count: "3" })).toThrow('param count takes a number (got "3")');
        expect(() => resolveParams(meta, { count: 1, loud: "yes" })).toThrow(
            'param loud takes true or false (got "yes")'
        );
    });

    test("text from a command line is read as the param's type", () => {
        expect(coerceParam("count", meta.params.count, "4")).toBe(4);
        expect(coerceParam("loud", meta.params.loud, "yes")).toBe(true);
        expect(coerceParam("x", { type: "json" }, '{"a":[1]}')).toEqual({ a: [1] });
        expect(() => coerceParam("count", meta.params.count, "four")).toThrow("takes a number");
        expect(() => coerceParam("loud", meta.params.loud, "maybe")).toThrow("takes true or false");
    });
});

describe("running a preset in the REPL's scope", () => {
    const toolsetGlobal = "presetTestToolset";

    afterEach(() => {
        Reflect.deleteProperty(globalThis, toolsetGlobal);
    });

    test("the script sees the loaded toolsets and its params, returns its value, and the run is counted", async () => {
        const dir = root();
        savePreset({
            name: "double",
            input: {
                script: `return ${toolsetGlobal}.twice(params.n);`,
                toolsets: [toolsetGlobal],
                params: { n: { type: "number", default: 2 } },
            },
            knownToolsets: [toolsetGlobal],
            root: dir,
        });
        await expect(runPresetHere("double", {}, dir)).rejects.toThrow(`needs the ${toolsetGlobal} toolset`);
        Reflect.set(globalThis, toolsetGlobal, { twice: (value: number) => value * 2 });
        expect(await runPresetHere("double", { n: 21 }, dir)).toBe(42);
        const meta = SafeJSON.parse(readFileSync(join(dir, "double", PRESET_META), "utf8"), { strict: true });
        expect(meta.runs).toBe(1);
    });
});
