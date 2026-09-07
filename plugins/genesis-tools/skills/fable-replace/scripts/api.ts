/**
 * fable-replace — PRINT THE TYPED API. `bun cli.ts --api` dumps every exported
 * function signature, interface and type alias together with its JSDoc, straight
 * from the source, so an agent gets the full parameter types without reading the
 * modules. Nothing here is hand-maintained; if it is exported, it is listed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MODULES = [
    "types.ts",
    "spec.ts",
    "sweep-many-files.ts",
    "edit-one-file.ts",
    "comments.ts",
    "rename-symbols.ts",
    "recon.ts",
    "backup-and-rollback.ts",
    "verify-command.ts",
];

interface ApiEntry {
    module: string;
    name: string;
    doc: string;
    signature: string;
}

/** Text of the JSDoc block that ends right above `lineIdx`, or "". */
const docAbove = (lines: string[], lineIdx: number): string => {
    let j = lineIdx - 1;
    if (j < 0 || !lines[j].trim().endsWith("*/")) {
        return "";
    }
    const end = j;
    while (j >= 0 && !lines[j].trim().startsWith("/**")) {
        j -= 1;
    }
    if (j < 0) {
        return "";
    }
    return lines
        .slice(j, end + 1)
        .map((l) =>
            l
                .trim()
                .replace(/^\/\*\*\s?/, "")
                .replace(/^\*\/?\s?/, "")
                .replace(/\*\/$/, "")
        )
        .join("\n")
        .trim();
};

/**
 * Text from `start` up to the line where the depth opened by `open` on that line
 * returns to zero, plus the character offset of that closing bracket. Nothing past
 * it: a function BODY is not part of its signature.
 */
const balancedSpan = ({
    lines,
    start,
    open,
    close,
}: {
    lines: string[];
    start: number;
    open: string;
    close: string;
}): { text: string; closeAt: number } => {
    let depth = 0;
    let seen = false;
    let offset = 0;
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i];
        for (let c = 0; c < line.length; c += 1) {
            const ch = line[c];
            if (ch === open) {
                depth += 1;
                seen = true;
            } else if (ch === close) {
                depth -= 1;
                if (seen && depth === 0) {
                    return { text: lines.slice(start, i + 1).join("\n"), closeAt: offset + c };
                }
            }
        }
        offset += line.length + 1;
    }
    return { text: lines[start], closeAt: lines[start].length };
};

/** `export const name = (params): Return => …` reduced to `name = (params): Return`. */
const arrowSignature = ({ lines, start }: { lines: string[]; start: number }): string => {
    const span = balancedSpan({ lines, start, open: "(", close: ")" });
    const arrow = span.text.indexOf("=>", span.closeAt);
    const head = arrow === -1 ? span.text : span.text.slice(0, arrow).trimEnd();
    return head.replace(/^export const /, "");
};

const declarationSignature = ({ lines, start }: { lines: string[]; start: number }): string => {
    const first = lines[start];
    if (first.includes("{")) {
        return balancedSpan({ lines, start, open: "{", close: "}" }).text.replace(/^export /, "");
    }
    // `type X = A | B;` possibly continued on following lines until the terminating `;`
    const out: string[] = [];
    for (let i = start; i < lines.length; i += 1) {
        out.push(lines[i]);
        if (lines[i].trimEnd().endsWith(";")) {
            break;
        }
    }
    return out.join("\n").replace(/^export /, "");
};

export const collectApi = (dir: string): ApiEntry[] => {
    const entries: ApiEntry[] = [];
    for (const module of MODULES) {
        const file = path.join(dir, module);
        if (!fs.existsSync(file)) {
            continue;
        }
        const lines = fs.readFileSync(file, "utf8").split("\n");
        for (let i = 0; i < lines.length; i += 1) {
            const l = lines[i];
            const fn = l.match(/^export const (\w+) = (?:async )?\(/);
            const decl = l.match(/^export (interface|type|class) (\w+)/);
            if (fn !== null) {
                entries.push({
                    module,
                    name: fn[1],
                    doc: docAbove(lines, i),
                    signature: arrowSignature({ lines, start: i }),
                });
            } else if (decl !== null) {
                entries.push({
                    module,
                    name: decl[2],
                    doc: docAbove(lines, i),
                    signature: declarationSignature({ lines, start: i }),
                });
            }
        }
    }
    return entries;
};

/** Print the API, optionally only the entries whose name or module contains `query` (case-insensitive). */
export const printApi = ({ dir, query }: { dir: string; query?: string }): void => {
    const q = query?.toLowerCase();
    const entries = collectApi(dir).filter(
        (e) => q === undefined || e.name.toLowerCase().includes(q) || e.module.toLowerCase().includes(q)
    );
    console.log(
        `fable-replace API — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${q === undefined ? " (narrow with --api <query>)" : ` matching "${query}"`}`
    );
    // The "## module" headings below name the file that DEFINES a symbol. That is not the
    // import path: everything is re-exported from the barrel, so a script written from this
    // dump imports one specifier and never has to track which module moved.
    console.log(
        `import { … } from "${path.join(dir, "replace-utils")}";  // every symbol below; ## headings name the defining file, not the import path`
    );
    let lastModule = "";
    for (const entry of entries) {
        if (entry.module !== lastModule) {
            console.log(`\n## ${entry.module}\n`);
            lastModule = entry.module;
        }
        if (entry.doc.length > 0) {
            console.log(`/** ${entry.doc.replace(/\n/g, "\n    ")} */`);
        }
        console.log(`${entry.signature}\n`);
    }
};
