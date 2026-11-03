#!/usr/bin/env bun
/**
 * The spend library moves from `src/ai-spend/lib/` into `@genesiscz/utils/ai/usage/spend/` (AI usage design
 * 2026-11-01, step U8), so the alert engine and attribution, which live in `src/utils/`, can read spend events.
 *
 * What stays in the tool, and why:
 * - the commander adapters: `register.ts` and `reports/commands.ts` (`tools ai-spend` stays the real command);
 * - `render.ts` and `asciichart.d.ts`: the chart needs `asciichart`, which is no dependency of `@genesiscz/utils`;
 * - `workers/`: it reads the claude, codex and grok tool stores (`@app/<tool>/lib/store`), which a util may not import;
 * - the tests that spawn `src/ai-spend/index.ts` or test the adapters.
 *
 * Every import of a moved module is rewritten: relative specifiers in the files that stay, and `@app/ai-spend/lib/...`
 * in other tools. The old paths other tools imported (`pricing`, `reports/load`, `series`) keep a re-export shim for
 * one release. One fable-replace transaction: every op is pinned to its count, all land or none.
 *
 * APPLIED 2026-11-03. Usage: bun scripts/codemods/2026-11-03-spend-core-move.ts [--dry]
 */
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { $ } from "bun";
import { type FileEdit, run, scratchDir } from "../../plugins/genesis-tools/skills/fable-replace/scripts/replace-utils";

const ROOT = resolve(import.meta.dir, "..", "..");
const OLD = "src/ai-spend/lib";
const NEW = "src/utils/ai/usage/spend";
const OLD_SPEC = "@app/ai-spend/lib";
const NEW_SPEC = "@genesiscz/utils/ai/usage/spend";

/** Paths under `src/ai-spend/lib/` that stay; a trailing `/` keeps a whole folder. */
const STAY = [
    "register.ts",
    "render.ts",
    "asciichart.d.ts",
    "reports/commands.ts",
    "reports/commands.test.ts",
    "reports/help.test.ts",
    "reports/parity.test.ts",
    "reports/reviews-cli.test.ts",
    "monitor.test.ts",
    "monitor-envelope.test.ts",
    "series-flags.test.ts",
    "summary-shape.test.ts",
    "workers/",
];

/** The old module paths other tools import: each keeps a re-export shim. */
const SHIMS = ["pricing", "reports/load", "series"];

/** Path mentions outside import specifiers (lint scopes, allowlists, docs) that follow the move. */
const MENTIONS: Array<{ file: string; find: string; replace: string; count: number }> = [
    {
        file: "scripts/ci/lint-rules.ts",
        find: "src/ai-spend/lib/drivers/test-env\\\\.ts",
        replace: "src/utils/ai/usage/spend/drivers/test-env\\\\.ts",
        count: 2,
    },
    {
        file: "scripts/ci/harness-guard-allowlist.ts",
        find: '"src/ai-spend/lib/reports/types.ts"',
        replace: '"src/utils/ai/usage/spend/reports/types.ts"',
        count: 1,
    },
    {
        file: "src/utils/harness/tool-parts.ts",
        find: "(`src/ai-spend/lib/drivers/<id>.ts`)",
        replace: "(`src/utils/ai/usage/spend/drivers/<id>.ts`)",
        count: 1,
    },
];

const dry = process.argv.includes("--dry");

function stays(rel: string): boolean {
    return STAY.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));
}

async function tracked(...paths: string[]): Promise<string[]> {
    const out = await $`git ls-files -- ${paths}`.cwd(ROOT).quiet().text();

    return out.split("\n").filter((line) => line.length > 0);
}

/** The tracked file a specifier names, or undefined. */
function resolveSpecifier(fromFile: string, spec: string, files: Set<string>): string | undefined {
    const base = spec.startsWith(`${OLD_SPEC}/`)
        ? join(OLD, spec.slice(OLD_SPEC.length + 1))
        : relative(ROOT, resolve(ROOT, dirname(fromFile), spec));

    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (files.has(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

/** The new specifier for a moved target, keeping the spelling of the old one (an index import stays an index import). */
function newSpecifier(spec: string, target: string): string {
    const rel = target.slice(OLD.length + 1);
    const named = rel.replace(/\.tsx?$/, "");
    const tail = spec.endsWith("/index") || spec.endsWith(".ts") ? named : named.replace(/\/index$/, "");

    return `${NEW_SPEC}/${spec.endsWith(".ts") || spec.endsWith(".json") ? rel : tail}`;
}

const SPEC_RE = /(["'])((?:\.\.?\/|@app\/ai-spend\/lib\/)[^"'\n]*)\1/g;

async function main(): Promise<void> {
    const libFiles = (await tracked(OLD)).filter((file) => existsSync(join(ROOT, file)));
    const known = new Set(libFiles);
    const moved = new Set(libFiles.filter((file) => !stays(file.slice(OLD.length + 1))));
    const scanned = (await tracked("src", "scripts", "plugins")).filter(
        (file) => /\.(ts|tsx)$/.test(file) && !file.startsWith("scripts/codemods/")
    );
    const edits = new Map<string, FileEdit>();
    const problems: string[] = [];

    for (const file of scanned) {
        const text = await Bun.file(join(ROOT, file)).text();
        const counts = new Map<string, { quote: string; spec: string; next: string; count: number }>();

        for (const match of text.matchAll(SPEC_RE)) {
            const [, quote, spec] = match;
            const external = spec.startsWith(`${OLD_SPEC}/`);

            if (!external && !file.startsWith(`${OLD}/`) && !file.startsWith("src/ai-spend/")) {
                continue;
            }

            const target = resolveSpecifier(file, spec, known);

            if (!target) {
                continue;
            }

            const fromMoved = moved.has(file);
            const toMoved = moved.has(target);

            if (fromMoved && !toMoved) {
                problems.push(`${file} imports ${spec}, which stays: a util cannot import the tool`);
                continue;
            }

            if (fromMoved || !toMoved) {
                // Both move (the relative path keeps working), or the target stays.
                continue;
            }

            const key = `${quote}${spec}${quote}`;
            const entry = counts.get(key) ?? { quote, spec, next: newSpecifier(spec, target), count: 0 };
            entry.count += 1;
            counts.set(key, entry);
        }

        if (counts.size > 0) {
            edits.set(file, {
                file,
                ops: [...counts.values()].map(({ quote, spec, next, count }) => ({
                    find: `${quote}${spec}${quote}`,
                    replace: `${quote}${next}${quote}`,
                    count,
                    label: `${spec} -> ${next}`,
                })),
            });
        }
    }

    if (problems.length > 0) {
        throw new Error(`the move would break the package boundary:\n${problems.join("\n")}`);
    }

    for (const mention of MENTIONS) {
        const edit = edits.get(mention.file) ?? { file: mention.file, ops: [] };
        edit.ops = [
            ...(edit.ops ?? []),
            { find: mention.find, replace: mention.replace, count: mention.count, label: "path mention" },
        ];
        edits.set(mention.file, edit);
    }

    for (const file of moved) {
        const edit = edits.get(file) ?? { file };
        edit.renameTo = join(NEW, file.slice(OLD.length + 1));
        edits.set(file, edit);
    }

    console.log(`moving ${moved.size} files, rewriting imports in ${[...edits.values()].filter((e) => e.ops).length}`);
    await run({
        edits: [...edits.values()],
        cwd: ROOT,
        dryRun: dry,
        backupDir: scratchDir("spend-core-move"),
        verbose: false,
    });

    if (dry) {
        return;
    }

    await run({
        edits: SHIMS.map((module) => ({
            file: join(OLD, `${module}.ts`),
            createWith: `/** Moved to \`${NEW_SPEC}/${module}\` (design 2026-11-01, step U8). Kept for one release. */\nexport * from "${NEW_SPEC}/${module}";\n`,
        })),
        cwd: ROOT,
        backupDir: scratchDir("spend-core-shims"),
        verbose: false,
    });
}

await main();
