import { formatTokens } from "@app/utils/format";
import type { ScannedFile } from "./types";

export interface IncludedFile {
    file: ScannedFile;
    tokens: number;
}

interface RenderSummary {
    root: string;
    budget: number;
    usedTokens: number;
    filesIncluded: number;
    filesTotal: number;
}

interface RenderTreeArgs extends RenderSummary {
    included: IncludedFile[];
    elided: ScannedFile[];
    filesOnly: boolean;
}

/** Render the human-readable map (tree or files-only) as a string. */
export function renderTree(args: RenderTreeArgs): string {
    const { root, budget, usedTokens, filesIncluded, filesTotal, included, elided, filesOnly } = args;
    const lines: string[] = [];

    lines.push(`repo-map: ${root}  (budget ${budget} tok, used ${usedTokens}, ${filesIncluded}/${filesTotal} files)`);
    lines.push("");

    for (const { file, tokens } of included) {
        if (filesOnly) {
            lines.push(`${file.path}\t${file.symbols.length} symbols\t~${formatTokens(tokens)}`);
            continue;
        }

        lines.push(file.path);

        for (const sym of file.symbols) {
            lines.push(`  ${sym.signature}`);
        }

        lines.push("");
    }

    if (elided.length > 0) {
        const noun = elided.length === 1 ? "file" : "files";
        lines.push(`… ${elided.length} ${noun} elided to fit budget (raise --max-tokens or use --files-only)`);
    }

    return lines.join("\n");
}

interface JsonSymbol {
    kind: string;
    name: string;
    signature: string;
}

interface JsonFile {
    path: string;
    language: string;
    tokens: number;
    included: boolean;
    symbols: JsonSymbol[];
}

export interface RepoMapJson {
    root: string;
    budget: number;
    usedTokens: number;
    filesIncluded: number;
    filesTotal: number;
    files: JsonFile[];
    elided: string[];
}

/** Build the structured JSON object for --json output. */
export function renderJson(args: RenderSummary & { included: IncludedFile[]; elided: ScannedFile[] }): RepoMapJson {
    const { root, budget, usedTokens, filesIncluded, filesTotal, included, elided } = args;

    const files: JsonFile[] = included.map(({ file, tokens }) => ({
        path: file.path,
        language: file.language,
        tokens,
        included: true,
        symbols: file.symbols.map((s) => ({ kind: s.kind, name: s.name, signature: s.signature })),
    }));

    return {
        root,
        budget,
        usedTokens,
        filesIncluded,
        filesTotal,
        files,
        elided: elided.map((f) => f.path),
    };
}
