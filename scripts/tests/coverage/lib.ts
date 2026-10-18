/**
 * Pure parts of the coverage report: lcov and junit parsing, the merge of the per-phase files
 * `scripts/test.ts` writes, the gate scan of a test source, and the per-area summary. The CLI in
 * `index.ts` does the I/O; everything here takes text and returns data, so it is tested directly.
 */

/** Line and function counts of one source file, merged over every phase that loaded it. */
export interface FileCoverage {
    file: string;
    /** Executable line number to hit count. */
    lines: Map<number, number>;
    functionsFound: number;
    functionsHit: number;
}

/**
 * Every `SF:` record of an lcov file. bun writes `DA`, `FNF` and `FNH` but no per-function
 * `FN`/`FNDA` lines, so function counts are per-file totals only.
 */
export function parseLcov(text: string): FileCoverage[] {
    const records: FileCoverage[] = [];
    let current: FileCoverage | null = null;

    for (const raw of text.split("\n")) {
        const line = raw.trim();

        if (line.startsWith("SF:")) {
            current = { file: line.slice(3), lines: new Map(), functionsFound: 0, functionsHit: 0 };
            continue;
        }

        if (!current) {
            continue;
        }

        if (line.startsWith("DA:")) {
            const [lineNo, hits] = line.slice(3).split(",");
            const n = Number(lineNo);
            current.lines.set(n, Math.max(current.lines.get(n) ?? 0, Number(hits) || 0));
        } else if (line.startsWith("FNF:")) {
            current.functionsFound = Number(line.slice(4)) || 0;
        } else if (line.startsWith("FNH:")) {
            current.functionsHit = Number(line.slice(4)) || 0;
        } else if (line === "end_of_record") {
            records.push(current);
            current = null;
        }
    }

    return records;
}

/**
 * One record per file over several lcov files. Lines take the highest hit count, so a line hit in
 * any phase counts as hit. Functions take the larger hit total: without per-function records a
 * union is impossible, and a file normally loads in one phase, so this undercounts only a file
 * whose functions are split across phases.
 */
export function mergeCoverage(sets: FileCoverage[][]): Map<string, FileCoverage> {
    const merged = new Map<string, FileCoverage>();

    for (const records of sets) {
        for (const record of records) {
            const existing = merged.get(record.file);

            if (!existing) {
                merged.set(record.file, {
                    file: record.file,
                    lines: new Map(record.lines),
                    functionsFound: record.functionsFound,
                    functionsHit: record.functionsHit,
                });
                continue;
            }

            for (const [line, hits] of record.lines) {
                existing.lines.set(line, Math.max(existing.lines.get(line) ?? 0, hits));
            }

            existing.functionsFound = Math.max(existing.functionsFound, record.functionsFound);
            existing.functionsHit = Math.max(existing.functionsHit, record.functionsHit);
        }
    }

    return merged;
}

export interface JunitCase {
    file: string;
    name: string;
    line: number;
    /** bun writes a `test.todo` as a plain `<skipped />` too, so a todo reads as "skip". */
    status: "pass" | "fail" | "skip";
}

export interface JunitReport {
    cases: JunitCase[];
    /** Test time per file in seconds, from the file-level `<testsuite>`. Imports are not in it. */
    fileSeconds: Map<string, number>;
}

function attribute(tag: string, name: string): string | undefined {
    const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);

    return match ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, "&");
}

/**
 * The cases of a junit file from `bun test --reporter=junit`. bun nests one `<testsuite>` per
 * file and one per `describe`; a case is skipped when its body holds `<skipped`.
 */
export function parseJunit(xml: string): JunitReport {
    const cases: JunitCase[] = [];
    const fileSeconds = new Map<string, number>();
    const casePattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;

    for (const match of xml.matchAll(casePattern)) {
        const tag = match[1];
        const body = match[3] ?? "";
        const file = attribute(tag, "file") ?? "";
        let status: JunitCase["status"] = "pass";

        if (/<(failure|error)\b/.test(body)) {
            status = "fail";
        } else if (/<skipped\b/.test(body)) {
            status = "skip";
        }

        cases.push({ file, name: attribute(tag, "name") ?? "", line: Number(attribute(tag, "line") ?? 0), status });
    }

    // The file-level suite is the one whose name equals its file attribute.
    for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
        const name = attribute(match[1], "name");
        const file = attribute(match[1], "file");

        if (name && file && name === file) {
            fileSeconds.set(file, (fileSeconds.get(file) ?? 0) + Number(attribute(match[1], "time") ?? 0));
        }
    }

    return { cases, fileSeconds };
}

/** One skip condition written in a test source. */
export interface GateUse {
    line: number;
    /** The call, e.g. `describe.skipIf`, `it.skip`, `test.todo`. */
    call: string;
    /** The condition text for `skipIf`/`if`, empty for an unconditional skip. */
    condition: string;
    /** The env variable that turns the gate on, when the condition names a known opt-in gate. */
    envVar?: string;
}

/**
 * Every `skipIf(...)`, `if(...)`, `.skip(` and `.todo(` on `describe`/`it`/`test` in a source,
 * with the balanced condition text. `skip.<gate>` and `optIn.<gate>` resolve to their variable
 * through `gateEnvVars` (the table in src/utils/test/skip.ts), and so does a literal
 * `RUN_*` or `GENESIS_TOOLS_TEST_*` name inside the condition.
 */
export function scanGates(source: string, gateEnvVars: Record<string, string>): GateUse[] {
    const uses: GateUse[] = [];
    const pattern = /\b(describe|it|test)((?:\.(?:concurrent|serial|each|only))*)\.(skipIf|if|skip|todo)\b\s*\(/g;

    for (const match of source.matchAll(pattern)) {
        const start = (match.index ?? 0) + match[0].length;
        const line = source.slice(0, match.index).split("\n").length;
        const kind = match[3];
        const call = `${match[1]}${match[2]}.${kind}`;
        let condition = "";

        if (kind === "skipIf" || kind === "if") {
            let depth = 1;
            let end = start;

            while (end < source.length && depth > 0) {
                const ch = source[end];

                if (ch === "(") {
                    depth++;
                } else if (ch === ")") {
                    depth--;
                }

                end++;
            }

            condition = source
                .slice(start, end - 1)
                .replace(/\s+/g, " ")
                .trim();
        }

        uses.push({ line, call, condition, envVar: envVarOf(condition, gateEnvVars) });
    }

    return uses;
}

function envVarOf(condition: string, gateEnvVars: Record<string, string>): string | undefined {
    const gate = /\b(?:skip|optIn)\.(\w+)/.exec(condition);

    if (gate && gateEnvVars[gate[1]]) {
        return gateEnvVars[gate[1]];
    }

    return /\b(RUN_[A-Z0-9_]+|GENESIS_TOOLS_TEST_[A-Z0-9_]+)\b/.exec(condition)?.[1];
}

export interface CoverageTotals {
    linesFound: number;
    linesHit: number;
    functionsFound: number;
    functionsHit: number;
    files: number;
}

export interface FileRow extends CoverageTotals {
    file: string;
    area: string;
}

export interface AreaRow extends CoverageTotals {
    area: string;
    /** Tracked source files of the area no test loaded, so bun has no record of them. */
    unloadedFiles: number;
}

/**
 * The area a file is reported under: the tool folder for `src/<tool>/…`, one level deeper for the
 * shared package (`src/utils/<module>`) and the plugin (`plugins/<plugin>/<part>`), and the first
 * folder below `scripts/` and every other root.
 */
export function areaOf(file: string): string {
    const parts = file.split("/");

    if (parts.length === 1) {
        return "(root)";
    }

    if ((parts[0] === "src" && parts[1] === "utils") || parts[0] === "plugins") {
        return parts.length > 3 ? parts.slice(0, 3).join("/") : parts.slice(0, 2).join("/");
    }

    return parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
}

export function percent(hit: number, found: number): number {
    return found === 0 ? 100 : (hit / found) * 100;
}

function emptyTotals(): CoverageTotals {
    return { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0, files: 0 };
}

function add(target: CoverageTotals, row: CoverageTotals): void {
    target.linesFound += row.linesFound;
    target.linesHit += row.linesHit;
    target.functionsFound += row.functionsFound;
    target.functionsHit += row.functionsHit;
    target.files += row.files;
}

export interface CoverageSummary {
    total: CoverageTotals;
    areas: AreaRow[];
    files: FileRow[];
    /** Tracked source files that no test loaded. */
    unloaded: string[];
}

/**
 * Totals per area and overall, over the tracked source files only: lcov also names temp-folder
 * fixtures and `data:` modules a test evaluated, and those are not code of this repository.
 */
export function summarize(merged: Map<string, FileCoverage>, sourceFiles: string[]): CoverageSummary {
    const tracked = new Set(sourceFiles);
    const files: FileRow[] = [];
    const areas = new Map<string, AreaRow>();
    const total = emptyTotals();

    const areaRow = (area: string): AreaRow => {
        let row = areas.get(area);

        if (!row) {
            row = { area, unloadedFiles: 0, ...emptyTotals() };
            areas.set(area, row);
        }

        return row;
    };

    for (const record of merged.values()) {
        if (!tracked.has(record.file)) {
            continue;
        }

        const hit = [...record.lines.values()].filter((hits) => hits > 0).length;
        const row: FileRow = {
            file: record.file,
            area: areaOf(record.file),
            linesFound: record.lines.size,
            linesHit: hit,
            functionsFound: record.functionsFound,
            functionsHit: record.functionsHit,
            files: 1,
        };

        files.push(row);
        add(areaRow(row.area), row);
        add(total, row);
    }

    const unloaded = sourceFiles.filter((file) => !merged.has(file)).sort();

    for (const file of unloaded) {
        areaRow(areaOf(file)).unloadedFiles++;
    }

    return { total, areas: [...areas.values()].sort((a, b) => a.area.localeCompare(b.area)), files, unloaded };
}

const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/**
 * The static line count bun's executable-line count is scaled from: the non-blank lines of the
 * file with its types and comments compiled away, import and re-export lines left out. bun counts
 * almost nothing in a type-only file, and a raw line count would charge every `interface` as an
 * uncovered line. A file the transpiler cannot read falls back to its raw non-blank lines.
 */
export function countSourceLines(text: string, file = "x.ts"): number {
    let code = text;

    try {
        code = (file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts).transformSync(text);
    } catch {
        // A syntax error leaves the raw text: an over-estimate for one file beats no estimate.
    }

    return code.split("\n").filter((line) => line.trim() !== "" && !/^\s*(import\b|export \{|export \*)/.test(line))
        .length;
}

export interface TrackedEstimate {
    /** bun's executable lines per static source line, measured over the loaded files of this run. */
    ratio: number;
    /** Estimated executable lines of the unloaded files, counted as uncovered. */
    unloadedLines: number;
    /** Loaded plus unloaded lines, and the share of them covered. */
    linesFound: number;
    linesHit: number;
    /** The same per area, keyed by area. */
    areas: Map<string, { linesFound: number; linesHit: number }>;
}

/**
 * Coverage over ALL tracked source, with every file no test loaded counted as 0%. bun has no line
 * count for a file it never loaded, so each one gets its static line count times the ratio
 * between bun's count and the static count on the files it did load in the same run. Without
 * this the headline overstates coverage, and a new test that first imports a file lowers it.
 */
export function estimateTracked(summary: CoverageSummary, read: (file: string) => string): TrackedEstimate {
    let bunLines = 0;
    let staticLines = 0;

    for (const row of summary.files) {
        bunLines += row.linesFound;
        staticLines += countSourceLines(read(row.file), row.file);
    }

    const ratio = staticLines === 0 ? 1 : bunLines / staticLines;
    const areas = new Map(
        summary.areas.map((row) => [row.area, { linesFound: row.linesFound, linesHit: row.linesHit }])
    );
    let unloadedLines = 0;

    for (const file of summary.unloaded) {
        const lines = Math.round(countSourceLines(read(file), file) * ratio);
        const area = areas.get(areaOf(file));
        unloadedLines += lines;

        if (area) {
            area.linesFound += lines;
        }
    }

    return {
        ratio,
        unloadedLines,
        linesFound: summary.total.linesFound + unloadedLines,
        linesHit: summary.total.linesHit,
        areas,
    };
}

/** The files with the most uncovered lines first: where a new test buys the most. */
export function leastCovered(files: FileRow[], limit: number): FileRow[] {
    return [...files]
        .filter((row) => row.linesHit < row.linesFound)
        .sort((a, b) => b.linesFound - b.linesHit - (a.linesFound - a.linesHit) || a.file.localeCompare(b.file))
        .slice(0, limit);
}

/**
 * Whether a tracked file is source the coverage run should account for: TypeScript, not a test,
 * not a declaration file, not a test fixture.
 */
export function isSourceFile(file: string): boolean {
    return (
        /\.(ts|tsx)$/.test(file) &&
        !/\.d\.ts$/.test(file) &&
        !/\.(test|spec|e2e)\.tsx?$/.test(file) &&
        !/(^|\/)test\.data\.ts$/.test(file) &&
        !/(^|\/)(__tests__|__fixtures__|fixtures|node_modules)\//.test(file)
    );
}
