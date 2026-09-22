import type { DuplicateOptions, FileSymbols } from "../duplicates";
import type { ParsedModule } from "../types";

export type AnalyserName =
    | "duplicates"
    | "shadowed"
    | "unused-exports"
    | "long-functions"
    | "god-files"
    | "param-bloat";

export type Severity = "high" | "medium" | "low";

export interface RefactorSite {
    file: string;
    startLine: number;
    endLine: number;
    name: string;
    /** Set when the site is the one the recommendation says to keep. */
    canonical?: boolean;
}

export interface Recommendation {
    analyser: AnalyserName;
    severity: Severity;
    /** One line, the finding itself. */
    title: string;
    /** Evidence. One fact per entry, never a paragraph. */
    detail: string[];
    sites: RefactorSite[];
    /** The imperative edit. What a reader does next. */
    action: string;
    /** Lines the edit would remove. 0 when the edit only moves code. */
    savedLines: number;
    score: number;
}

export interface RefactorOptions extends DuplicateOptions {
    /** A function longer than this is reported by `long-functions`. Default 60. */
    maxFunctionLines?: number;
    /** More positional parameters than this is reported by `param-bloat`. Default 4. */
    maxParams?: number;
    /** A file with more declarations than this is a `god-files` candidate. Default 40. */
    maxDeclarations?: number;
    /** Cap on how many recommendations each analyser returns. Default 25. */
    limit?: number;
}

export interface RefactorInput {
    entries: FileSymbols[];
    modules: Map<string, ParsedModule>;
    options: RefactorOptions;
}

export interface Analyser {
    name: AnalyserName;
    /** What this analyser looks for, in one line. Printed by `--include help`. */
    summary: string;
    run: (input: RefactorInput) => Recommendation[];
}

/** Path segments that mark a module as the shared home for a helper. */
export const SHARED_SEGMENTS = ["utils", "util", "lib", "shared", "common", "core", "helpers"];

export function isSharedModule(file: string): boolean {
    return file.split("/").some((segment) => SHARED_SEGMENTS.includes(segment));
}

/** Every name a module pulls in, under whatever local alias it uses. */
export function importedNames(module: ParsedModule | undefined): Set<string> {
    const names = new Set<string>();

    if (!module) {
        return names;
    }

    for (const site of [...module.imports, ...module.reexports]) {
        for (const name of site.names) {
            names.add(name);
        }

        for (const local of site.locals) {
            names.add(local);
        }
    }

    return names;
}
