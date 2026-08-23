import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Importing `logger` used to pull the prompts/p barrel → inquirer → cli barrel
 * → commander → readme → markdown → highlight.js (~150ms). These files must
 * stay off the static graph.
 */
const UTILS = resolve(import.meta.dir, "..");
const LOGGER_ENTRY = join(UTILS, "logger.ts");

const FORBIDDEN_SUFFIXES = [
    "/markdown/index.ts",
    "/readme.ts",
    "/prompts/p/index.ts",
    "/prompts/p/inquirer-backend.ts",
    "/prompts/p/offer-install.ts",
    "/prompts/clack/table-select.ts",
    "/cli/index.ts",
    "/cli/commander.ts",
    "/cli/executor.ts",
];

function existingFile(base: string): string | null {
    const stripped = base.replace(/\.js$/, "");
    const candidates = [
        base,
        `${stripped}.ts`,
        `${stripped}.tsx`,
        join(stripped, "index.ts"),
        join(stripped, "index.tsx"),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
    if (spec.startsWith("node:") || spec.startsWith("bun:")) {
        return null;
    }

    if (spec.startsWith("@genesiscz/utils/")) {
        return existingFile(join(UTILS, spec.slice("@genesiscz/utils/".length)));
    }

    if (spec.startsWith(".")) {
        return existingFile(resolve(dirname(fromFile), spec));
    }

    return null;
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function valueImportSpecs(src: string): string[] {
    const body = stripComments(src);
    const specs: string[] = [];
    const fromRe =
        /(?:^|[\n;])\s*(?:import|export)\s+(?!type\b)(?:(?![\n](?:import|export)\b)[\s\S])*?\sfrom\s+["']([^"']+)["']/g;
    const sideRe = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;

    for (const re of [fromRe, sideRe]) {
        re.lastIndex = 0;
        let match = re.exec(body);

        while (match) {
            specs.push(match[1]);
            match = re.exec(body);
        }
    }

    return specs;
}

function walk(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
        const file = queue.pop();
        if (!file || seen.has(file)) {
            continue;
        }

        seen.add(file);
        const specs = valueImportSpecs(readFileSync(file, "utf8"));

        for (const spec of specs) {
            const resolved = resolveSpecifier(file, spec);
            if (resolved && !seen.has(resolved)) {
                queue.push(resolved);
            }
        }
    }

    return [...seen];
}

describe("logger static import graph", () => {
    it("does not reach markdown, readme, inquirer, or the cli barrel", () => {
        const files = walk(LOGGER_ENTRY);
        const rel = files.map((f) => relative(UTILS, f).split("\\").join("/"));

        expect(rel).toContain("logger.ts");
        expect(rel).toContain("logger/out.ts");
        expect(rel).toContain("prompts/p/backend.ts");

        const hits = FORBIDDEN_SUFFIXES.filter((suffix) =>
            files.some((f) => f.endsWith(suffix) || f.endsWith(suffix.replace(/^\//, "")))
        );

        expect(hits).toEqual([]);
    });
});
