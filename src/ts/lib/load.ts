import { relative } from "node:path";
import type ts from "typescript";
import { type CollectOptions, collectAll } from "./collect";
import type { FileSymbols } from "./duplicates";
import { parseModule } from "./parse";
import { enrichSymbols, extractSkeleton, parseSource, type SkeletonSymbol } from "./skeleton";
import type { ParsedModule } from "./types";

export interface LoadOptions extends CollectOptions {
    /** Collect declarations inside function bodies too. */
    locals?: boolean;
    /** Attach a fingerprint to every symbol. */
    hash?: boolean;
    /** Attach the first N body lines to every symbol. */
    functionContext?: number;
    /** Also parse the import graph, which `shadowed` and `unused-exports` need. */
    imports?: boolean;
    /**
     * Keep every `ts.SourceFile` for a later pass. Off by default: holding 1349 parsed trees
     * at once is a different memory budget from parsing and discarding them one at a time.
     */
    keepSource?: boolean;
}

export interface LoadedFile extends FileSymbols {
    /** Absolute, for anything that must re-open the file. */
    absolute: string;
    symbols: SkeletonSymbol[];
    /** Only present with `keepSource`. */
    source?: ts.SourceFile;
}

export interface Loaded {
    entries: LoadedFile[];
    modules: Map<string, ParsedModule>;
    /** Inputs that matched no TypeScript source. The caller decides whether that is an error. */
    empty: string[];
    originalChars: number;
}

/**
 * One read of every file, shared by `skeleton`, `duplicates` and `refactors`. Parsing the same
 * tree three times was the obvious first shape and it made `refactors --include all` read
 * a sibling repo's 1349 files three times over.
 */
export async function loadFiles(paths: string[], options: LoadOptions = {}): Promise<Loaded> {
    const { files, empty } = collectAll(paths, options);
    const entries: LoadedFile[] = [];
    const modules = new Map<string, ParsedModule>();
    let originalChars = 0;

    for (const absolute of files) {
        const text = await Bun.file(absolute).text();
        const file = relative(process.cwd(), absolute) || absolute;

        originalChars += text.length;

        const source = parseSource(absolute, text);
        const symbols = enrichSymbols(extractSkeleton(source, { locals: options.locals }), text, {
            hash: options.hash,
            functionContext: options.functionContext,
        });

        entries.push({ absolute, file, text, symbols, ...(options.keepSource ? { source } : {}) });

        if (options.imports) {
            modules.set(file, parseModule(text, absolute));
        }
    }

    return { entries, modules, empty, originalChars };
}
