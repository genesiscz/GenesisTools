import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SafeJSON } from "@genesiscz/utils/json";

interface BenchCounters {
    normalizations: number;
    hashes: number;
    tokenizations: number;
    programs: number;
    checkers: number;
    splits: number;
}

interface SkeletonModule {
    parseSource: (file: string, text: string) => unknown;
    extractSkeleton: (source: unknown) => unknown[];
    enrichSymbols: (symbols: unknown[], text: string, options: { hash: boolean }) => unknown[];
}

interface DuplicatesModule {
    findDuplicates: (entries: unknown[], options: Record<string, unknown>) => unknown;
    prepareDeclarationAnalysis?: (options: { entries: unknown[] }) => {
        slices: number;
        cacheHits: number;
        shapes: number;
        retainedBytes: number;
        saturated: boolean;
    };
}

interface ShadowedModule {
    shadowedAnalyser: {
        run: (input: {
            entries: unknown[];
            modules: Map<string, unknown>;
            options: Record<string, unknown>;
        }) => unknown[];
    };
}

interface WorkerResult {
    counters: BenchCounters;
    digest: string;
    reportBytes: number;
    recommendations: number;
    analysis?: {
        slices: number;
        cacheHits: number;
        shapes: number;
        retainedBytes: number;
        saturated: boolean;
    };
}

interface Measurement extends WorkerResult {
    ref: string;
    run: number;
    wallMs: number;
    cpuMs: number;
    maxRssBytes: number;
}

const ROOT = join(import.meta.dir, "../../..");
const SCRATCH_PREFIX = "/tmp/cc/GenesisTools/typescript-performance/run-";
const INSTRUMENTED_FILES = ["skeleton.ts", "duplicates.ts", "refactors/shadowed.ts"];

function flag(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function fixtureSource(options: { fileIndex: number; declarations: number; homeFiles: number }): string {
    const { fileIndex, declarations, homeFiles } = options;
    const exported = fileIndex < homeFiles ? "export " : "";
    const blocks: string[] = [];

    for (let declaration = 0; declaration < declarations; declaration += 1) {
        const name = `run${declaration}`;
        const fallback = declaration % 4 === 0 ? `${name}("fallback")` : "prefix";
        blocks.push(
            `${exported}function ${name}(input: string) {\n` +
                `    const prefix = "group-${declaration}";\n` +
                `    const value = input.trim();\n` +
                `    return value ? prefix + value : ${fallback};\n` +
                `}`
        );
    }

    return blocks.join("\n\n");
}

async function worker(): Promise<void> {
    const moduleRoot = flag("--module-root");
    const files = Number(flag("--files") ?? 100);
    const declarations = Number(flag("--declarations") ?? 10);
    const homeFiles = Number(flag("--home-files") ?? 5);
    if (!moduleRoot) {
        throw new Error("--module-root is required in worker mode");
    }

    const counters: BenchCounters = {
        normalizations: 0,
        hashes: 0,
        tokenizations: 0,
        programs: 0,
        checkers: 0,
        splits: 0,
    };
    Object.assign(globalThis, { __tsDupBench: counters });

    const skeleton = (await import(pathToFileURL(join(moduleRoot, "skeleton.ts")).href)) as unknown as SkeletonModule;
    const duplicates = (await import(
        pathToFileURL(join(moduleRoot, "duplicates.ts")).href
    )) as unknown as DuplicatesModule;
    const shadowed = (await import(
        pathToFileURL(join(moduleRoot, "refactors", "shadowed.ts")).href
    )) as unknown as ShadowedModule;
    const entries: unknown[] = [];

    for (let fileIndex = 0; fileIndex < files; fileIndex += 1) {
        const text = fixtureSource({ fileIndex, declarations, homeFiles });
        const file = fileIndex < homeFiles ? `src/shared/home-${fileIndex}.ts` : `src/features/copy-${fileIndex}.ts`;
        const source = skeleton.parseSource(file, text);
        const symbols = skeleton.enrichSymbols(skeleton.extractSkeleton(source), text, { hash: true });
        entries.push({ file, text, symbols });
    }

    const options = { minLines: 3, similarity: 0.8, recommend: true, limit: 25 };
    const report = {
        duplicates: duplicates.findDuplicates(entries, options),
        shadowed: shadowed.shadowedAnalyser.run({ entries, modules: new Map(), options }),
    };
    const serialized = SafeJSON.stringify(report);
    const recommendations = report.shadowed.length;
    const result: WorkerResult = {
        counters,
        digest: createHash("sha256").update(serialized).digest("hex"),
        reportBytes: Buffer.byteLength(serialized),
        recommendations,
        analysis: duplicates.prepareDeclarationAnalysis?.({ entries }),
    };
    process.stdout.write(SafeJSON.stringify(result));
}

function instrument(source: string): string {
    let next = source
        .replace(
            'import ts from "typescript";',
            'import type ts from "typescript";\nimport * as tsNamespace from "typescript";\nconst ts = (tsNamespace.default ?? tsNamespace) as typeof tsNamespace;'
        )
        .replaceAll('entry.text.split("\\n")', '(__tsDupBench.splits++, entry.text.split("\\n"))')
        .replace(/(?<![.\w])text\.split\("\\n"\)/g, '(__tsDupBench.splits++, text.split("\\n"))')
        .replaceAll("ts.createProgram(", "(__tsDupBench.programs++, ts.createProgram)(")
        .replaceAll("program.getTypeChecker()", "(__tsDupBench.checkers++, program.getTypeChecker())")
        .replace(
            "export function hashDeclaration(text: string, name: string): string {",
            "export function hashDeclaration(text: string, name: string): string {\n    __tsDupBench.hashes += 1;"
        )
        .replace(
            "export function tokenizeDeclaration(text: string, name: string): string[] {",
            "export function tokenizeDeclaration(text: string, name: string): string[] {\n    __tsDupBench.tokenizations += 1;"
        );
    const shapeNeedle = "    const { text, name, stats } = options;";
    if (next.includes("export function declarationShape(")) {
        next = next.replace(
            shapeNeedle,
            "    __tsDupBench.normalizations += 1;\n    const { text, name, stats } = options;"
        );
    } else {
        next = next.replace(
            "export function normalizeDeclaration(text: string, name: string): string {",
            "export function normalizeDeclaration(text: string, name: string): string {\n    __tsDupBench.normalizations += 1;"
        );
    }
    next =
        "const __tsDupBench = (globalThis as unknown as { __tsDupBench: { normalizations: number; hashes: number; tokenizations: number; programs: number; checkers: number; splits: number } }).__tsDupBench;\n" +
        next;
    return next;
}

async function snapshot(ref: string, scratch: string): Promise<string> {
    const snapshotRoot = join(scratch, ref.replace(/[^A-Za-z0-9_.-]/g, "_"));
    const target = join(snapshotRoot, "src", "ts", "lib");
    await mkdir(dirname(target), { recursive: true });

    if (ref === "current") {
        await cp(join(ROOT, "src", "ts", "lib"), target, { recursive: true });
    } else {
        const archive = join(scratch, `${ref}.tar`);
        const archived = Bun.spawnSync(["git", "archive", "--format=tar", `--output=${archive}`, ref, "src/ts/lib"], {
            cwd: ROOT,
        });
        if (archived.exitCode !== 0) {
            throw new Error(`git archive ${ref} failed: ${archived.stderr.toString()}`);
        }

        const extracted = Bun.spawnSync([
            "tar",
            "-xf",
            archive,
            "-C",
            join(scratch, ref.replace(/[^A-Za-z0-9_.-]/g, "_")),
        ]);
        if (extracted.exitCode !== 0) {
            throw new Error(`tar extraction for ${ref} failed: ${extracted.stderr.toString()}`);
        }
    }

    for (const relative of INSTRUMENTED_FILES) {
        const path = join(target, relative);
        const source = await Bun.file(path).text();
        await Bun.write(path, instrument(source));
    }

    await symlink(join(ROOT, "node_modules"), join(snapshotRoot, "node_modules"), "dir");

    return target;
}

function measure(options: {
    ref: string;
    moduleRoot: string;
    run: number;
    files: number;
    homeFiles: number;
}): Measurement {
    const { ref, moduleRoot, run, files, homeFiles } = options;
    const started = performance.now();
    const proc = Bun.spawnSync(
        [
            "bun",
            import.meta.path,
            "--worker",
            "--module-root",
            moduleRoot,
            "--files",
            String(files),
            "--home-files",
            String(homeFiles),
        ],
        { cwd: ROOT }
    );
    if (proc.exitCode !== 0) {
        throw new Error(`${ref} worker failed: ${proc.stderr.toString()}`);
    }

    const result = SafeJSON.parse(proc.stdout.toString(), { strict: true }) as WorkerResult;
    return {
        ref,
        run,
        ...result,
        wallMs: performance.now() - started,
        cpuMs: Number(proc.resourceUsage.cpuTime.total) / 1_000,
        maxRssBytes: Number(proc.resourceUsage.maxRSS),
    };
}

async function main(): Promise<void> {
    if (process.argv.includes("--worker")) {
        await worker();
        return;
    }

    const refs = (flag("--refs") ?? "a22104e13,2b6171ec0,current").split(",");
    const runs = Number(flag("--runs") ?? 3);
    const files = Number(flag("--files") ?? 100);
    const homeFiles = Number(flag("--home-files") ?? 5);
    await mkdir(dirname(SCRATCH_PREFIX), { recursive: true });
    const scratch = await mkdtemp(SCRATCH_PREFIX);
    const roots = new Map<string, string>();
    for (const ref of refs) {
        roots.set(ref, await snapshot(ref, scratch));
    }

    const measurements: Measurement[] = [];
    for (let run = 0; run < runs; run += 1) {
        for (const ref of refs) {
            const moduleRoot = roots.get(ref);
            if (!moduleRoot) {
                throw new Error(`No snapshot root for ${ref}`);
            }

            measurements.push(measure({ ref, moduleRoot, run, files, homeFiles }));
        }
    }

    for (const ref of refs) {
        const rows = measurements.filter((measurement) => measurement.ref === ref);
        const first = rows[0]!;
        process.stdout.write(
            `${ref}\tCPU ${median(rows.map((row) => row.cpuMs)).toFixed(1)} ms\t` +
                `wall ${median(rows.map((row) => row.wallMs)).toFixed(1)} ms\t` +
                `peak RSS ${Math.max(...rows.map((row) => row.maxRssBytes))}\t` +
                `normalize ${first.counters.normalizations}\tprogram ${first.counters.programs}\t` +
                `checker ${first.counters.checkers}\tsplits ${first.counters.splits}\t` +
                `${first.analysis ? `cache ${first.analysis.cacheHits}/${first.analysis.shapes} retained ${first.analysis.retainedBytes} B\t` : ""}` +
                `report ${first.reportBytes} B\tdigest ${first.digest.slice(0, 12)}\n`
        );
    }
}

await main();
