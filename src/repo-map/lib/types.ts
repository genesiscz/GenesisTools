export type SymbolKind = "function" | "class" | "interface" | "type" | "const" | "method";

export interface ExtractedSymbol {
    kind: SymbolKind;
    name: string;
    /** Body-free signature, whitespace-collapsed. e.g. `export function foo(a: number): string` */
    signature: string;
}

/** A file as produced by the scanner, before ranking. */
export interface ScannedFile {
    /** Repo-relative POSIX path, e.g. "src/utils/format.ts" */
    path: string;
    /** Absolute path on disk. */
    absPath: string;
    language: string;
    /** Bytes of source. */
    size: number;
    /** File mtime in ms since epoch. */
    mtimeMs: number;
    symbols: ExtractedSymbol[];
    /** Import sources this file references (raw module specifiers). */
    imports: string[];
}

/** Input to the ranking core (numbers only — no fs, no clock). */
export interface RankInputFile {
    path: string;
    size: number;
    /** Number of other mapped files that import this file. */
    fanIn: number;
    mtimeMs: number;
}

export interface RankedFile extends RankInputFile {
    /** Normalized 0..1 importance score (higher = more important). */
    rank: number;
}

/** A file as fed to the packer: rank + total token cost already computed. */
export interface PackInputFile {
    path: string;
    rank: number;
    tokens: number;
}

export interface PackResult<T extends PackInputFile = PackInputFile> {
    included: T[];
    elided: T[];
    usedTokens: number;
    budget: number;
}
