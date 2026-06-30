import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "@app/logger";

const SPECIFIER_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

function extractSpecifiers(source: string): string[] {
    const specs: string[] = [];
    for (const match of source.matchAll(SPECIFIER_RE)) {
        const spec = match[1] ?? match[2];
        if (spec && spec.startsWith(".")) {
            specs.push(spec);
        }
    }

    return specs;
}

/**
 * Resolve a relative specifier from `fromFile` to one of the known absolute
 * paths, trying extension and /index variants. Returns null if unresolved.
 */
function resolveSpecifier(spec: string, fromFile: string, known: Set<string>): string | null {
    const base = resolve(dirname(fromFile), spec);
    for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = base + suffix;
        if (known.has(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * For each file in `files`, count how many OTHER files import it (textually, via
 * relative specifiers). Self-imports are ignored.
 */
export function buildInboundImportCounts(files: string[]): Map<string, number> {
    const known = new Set(files);
    const counts = new Map<string, number>();
    for (const file of files) {
        counts.set(file, 0);
    }

    for (const importer of files) {
        let source: string;
        try {
            source = readFileSync(importer, "utf8");
        } catch (error) {
            logger.debug(`apoptosis: could not read ${importer} for import scan: ${error}`);
            continue;
        }

        // Heuristic strip of // and /* */ comments so commented-out imports don't
        // count as inbound references. Not a full lexer; good enough for this signal.
        const cleanSource = source.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "$1");

        const targets = new Set<string>();
        for (const spec of extractSpecifiers(cleanSource)) {
            const resolved = resolveSpecifier(spec, importer, known);
            if (resolved && resolved !== importer) {
                targets.add(resolved);
            }
        }

        for (const target of targets) {
            counts.set(target, (counts.get(target) ?? 0) + 1);
        }
    }

    return counts;
}
