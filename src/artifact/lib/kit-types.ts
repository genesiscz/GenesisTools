import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { REPO_ROOT, RUNTIME_DIR } from "./vite";

/**
 * Agent/editor DX without a folder scaffold:
 * - `kitApiDts()` emits the kit's full typed API (one .d.ts text) so an agent
 *   can author against the kit without ever reading component source.
 * - `writeEditorTsconfig()` drops ONE optional tsconfig.json into an artifact
 *   dir so a human editor resolves `@artifact/kit`, repo imports, and react —
 *   the runtime never needs it.
 */

const KIT_DIR = join(RUNTIME_DIR, "kit");
/**
 * rootDir for the declaration emit. It must contain every file the program
 * reaches, not just the kit: TypeScript emits a .d.ts for each source it
 * compiles, and one whose path escapes rootDir cannot be placed under outDir,
 * so it lands NEXT TO THE SOURCE instead. That is how stray .d.ts files got
 * into this tree before. A kit module importing `../../lib/markdown` is normal,
 * so the root is the whole tool directory.
 */
const EMIT_ROOT_DIR = resolve(RUNTIME_DIR, "..");
const KIT_EMIT_SUBDIR = relative(EMIT_ROOT_DIR, KIT_DIR);
const KIT_FILES = [
    "primitives.tsx",
    "data.tsx",
    "charts.tsx",
    "chartjs.tsx",
    "md.tsx",
    "simulator.tsx",
    "router.tsx",
    "index.ts",
];

function kitStamp(): string {
    return KIT_FILES.map((f) => `${f}:${statSync(join(KIT_DIR, f)).mtimeMs}`).join("|");
}

/** Generate (or reuse a cached) combined .d.ts for the kit's public API. */
export async function kitApiDts(): Promise<string> {
    const cacheDir = join(REPO_ROOT, "node_modules", ".vite-cache", "artifact-kit-dts");
    const stampPath = join(cacheDir, "stamp.txt");
    const outPath = join(cacheDir, "kit-api.d.ts");
    const stamp = kitStamp();

    if (existsSync(outPath) && existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp) {
        return readFileSync(outPath, "utf8");
    }

    mkdirSync(cacheDir, { recursive: true });
    const emitDir = join(cacheDir, "emit");
    const tsconfigPath = join(cacheDir, "tsconfig.json");
    await Bun.write(
        tsconfigPath,
        SafeJSON.stringify(
            {
                compilerOptions: {
                    target: "ESNext",
                    module: "ESNext",
                    moduleResolution: "bundler",
                    jsx: "react-jsx",
                    strict: true,
                    skipLibCheck: true,
                    declaration: true,
                    emitDeclarationOnly: true,
                    rootDir: EMIT_ROOT_DIR,
                    outDir: emitDir,
                    types: [],
                },
                // Exactly the kit's public modules. A directory glob would also
                // pull in the kit's own *.test.tsx and DOM harness, which need
                // bun:test types this emit deliberately does not load.
                files: KIT_FILES.map((f) => join(KIT_DIR, f)),
            },
            { strict: true },
            4
        )
    );

    const tsgo = join(REPO_ROOT, "node_modules", ".bin", "tsgo");
    const proc = Bun.spawnSync([tsgo, "-p", tsconfigPath], { cwd: cacheDir, stdout: "pipe", stderr: "pipe" });

    if (proc.exitCode !== 0) {
        const detail = `${proc.stdout.toString()}\n${proc.stderr.toString()}`.trim();
        throw new Error(`kit declaration emit failed (tsgo exit ${proc.exitCode}):\n${detail}`);
    }

    const parts: string[] = [
        '// @artifact/kit — generated API reference. Import everything below from "@artifact/kit".',
        "// (index re-exports the modules; the per-module headers are just provenance.)",
    ];

    for (const file of KIT_FILES) {
        if (file === "index.ts") {
            continue;
        }

        const dts = join(emitDir, KIT_EMIT_SUBDIR, file.replace(/\.tsx?$/, ".d.ts"));
        parts.push(`\n// ─── ${file} ───\n${readFileSync(dts, "utf8").trim()}`);
    }

    const combined = `${parts.join("\n")}\n`;
    await Bun.write(outPath, combined);
    await Bun.write(stampPath, stamp);
    logger.debug({ outPath }, "[artifact] kit d.ts regenerated");

    return combined;
}

/**
 * Slice the generated d.ts down to the top-level declarations whose first line
 * mentions any of `names` (case-insensitive). Module provenance headers stay so
 * the reader still knows which kit file a match came from.
 */
export function filterKitDts(dts: string, names: string[]): string {
    const needles = names.map((n) => n.toLowerCase());
    const out: string[] = [];
    let keep = false;

    for (const line of dts.split("\n")) {
        const topLevel = /^(export |declare |\/\/ ─── )/.test(line);

        if (topLevel) {
            const lower = line.toLowerCase();
            keep = line.startsWith("// ─── ") || needles.some((n) => lower.includes(n));
        }

        if (keep || line.startsWith("// @artifact/kit")) {
            out.push(line);
        }
    }

    return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

export interface EditorTsconfigResult {
    path: string;
    created: boolean;
}

/** Write an OPTIONAL tsconfig.json into an artifact dir for editor IntelliSense. */
export async function writeEditorTsconfig(dir: string): Promise<EditorTsconfigResult> {
    const path = resolve(dir, "tsconfig.json");

    if (existsSync(path)) {
        return { path, created: false };
    }

    const gt = REPO_ROOT;
    const config = {
        // Generated by `tools artifact types` — editor IntelliSense only; the
        // runtime (tools artifact serve/build) does not need this file.
        // Paths are machine-local (they point into the checkout that generated
        // this file) — regenerate after moving or switching checkouts.
        include: ["**/*"],
        compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            paths: {
                "@artifact/kit": [join(gt, "src/artifact/runtime/kit/index.ts")],
                "@genesistools/*": [join(gt, "*")],
                "@genesiscz/utils/*": [join(gt, "src/utils/*")],
                react: [join(gt, "node_modules/@types/react/index.d.ts")],
                "react/jsx-runtime": [join(gt, "node_modules/@types/react/jsx-runtime.d.ts")],
                "react-dom/client": [join(gt, "node_modules/@types/react-dom/client.d.ts")],
                "chart.js": [join(gt, "node_modules/chart.js/dist/types.d.ts")],
                recharts: [join(gt, "node_modules/recharts/types/index.d.ts")],
            },
        },
    };
    await Bun.write(path, `${SafeJSON.stringify(config, { strict: true }, 4)}\n`);

    return { path, created: true };
}
