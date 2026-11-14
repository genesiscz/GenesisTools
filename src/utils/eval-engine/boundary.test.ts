import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/** The engine may import only these, so another project can take the folder as it is. */
const Allowed = [/^zod$/, /^commander$/, /^node:[a-z/_]+$/, /^\.\/[A-Za-z0-9_-]+$/];
/** A static import or export with `from` (also over several lines), a bare side-effect import, or a dynamic import of a string literal. */
const ImportPattern =
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/gm;

const folder = dirname(fileURLToPath(import.meta.url));

describe("the engine's import boundary", () => {
    const files = readdirSync(folder).filter((name) => name.endsWith(".ts"));

    it("finds the engine's files", () => {
        assert.ok(files.includes("index.ts") && files.includes("cli.ts") && files.length >= 20, files.join(", "));
    });

    it("imports only zod, commander, node built-ins and its own files", () => {
        const offenders: string[] = [];
        for (const file of files) {
            const text = readFileSync(join(folder, file), "utf8");
            for (const match of text.matchAll(ImportPattern)) {
                const target = match[1] ?? match[2] ?? match[3];
                if (!Allowed.some((pattern) => pattern.test(target))) {
                    offenders.push(`${file}: ${target}`);
                }
            }
        }
        assert.deepEqual(offenders, []);
    });

    it("the pattern catches what it must refuse", () => {
        // Written in capitals so this file's own scan does not see the sample.
        const sample = `import { db } FROM "@/lib/db";\nimport x FROM "../cli/x";\nconst m = await IMPORT("ai");`
            .replaceAll("FROM", "from")
            .replaceAll("IMPORT", "import");
        const found = [...sample.matchAll(ImportPattern)].map((m) => m[1] ?? m[2] ?? m[3]);
        assert.deepEqual(found, ["@/lib/db", "../cli/x", "ai"]);
        assert.ok(found.every((target) => !Allowed.some((pattern) => pattern.test(target))));
    });
});
