import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "@app/logger";
import type { AliasConfig } from "./types";

const SPECIFIER_RE =
    /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
/** JS-ish extensions a TS import may carry — NodeNext writes `./x.js` for a `./x.ts` source. */
const REWRITABLE_JS_EXT = /\.(js|jsx|mjs|cjs)$/;

/** tsconfig `paths` entry, pre-split into the segments before/after the `*`. */
interface AliasRule {
    prefix: string;
    suffix: string;
    /** true when the pattern is an exact key (no `*`). */
    exact: boolean;
    targets: string[];
}

function extractSpecifiers(source: string): string[] {
    const specs: string[] = [];
    for (const match of source.matchAll(SPECIFIER_RE)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec) {
            specs.push(spec);
        }
    }

    return specs;
}

/**
 * Compile a tsconfig `paths` map into ordered rules. More specific patterns
 * (longer prefix) are tried first, matching TypeScript's longest-prefix-wins
 * resolution — e.g. `@app/yt/*` beats `@app/*`.
 */
function compileAliasRules(alias: AliasConfig): AliasRule[] {
    const rules: AliasRule[] = [];
    for (const [pattern, targets] of Object.entries(alias.paths)) {
        const star = pattern.indexOf("*");
        if (star === -1) {
            rules.push({ prefix: pattern, suffix: "", exact: true, targets });
        } else {
            rules.push({ prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), exact: false, targets });
        }
    }

    return rules.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Check a resolved (extensionless-ish) base path against the known set,
 *  trying extension, `/index`, and NodeNext `.js`→`.ts` variants. */
function matchKnown(base: string, known: Set<string>): string | null {
    for (const suffix of CANDIDATE_SUFFIXES) {
        if (known.has(base + suffix)) {
            return base + suffix;
        }
    }

    if (REWRITABLE_JS_EXT.test(base)) {
        const stem = base.replace(REWRITABLE_JS_EXT, "");
        for (const suffix of [".ts", ".tsx"]) {
            if (known.has(stem + suffix)) {
                return stem + suffix;
            }
        }
    }

    return null;
}

/** Resolve a relative specifier from `fromFile` to one of the known paths. */
function resolveRelative(spec: string, fromFile: string, known: Set<string>): string | null {
    return matchKnown(resolve(dirname(fromFile), spec), known);
}

/** Resolve a tsconfig-alias specifier (`@app/…`) to one of the known paths. */
function resolveAlias(spec: string, rules: AliasRule[], baseDir: string, known: Set<string>): string | null {
    for (const rule of rules) {
        let captured: string | null = null;
        if (rule.exact) {
            captured = spec === rule.prefix ? "" : null;
        } else if (
            spec.startsWith(rule.prefix) &&
            spec.endsWith(rule.suffix) &&
            spec.length >= rule.prefix.length + rule.suffix.length
        ) {
            captured = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
        }

        if (captured === null) {
            continue;
        }

        for (const target of rule.targets) {
            const substituted = target.includes("*") ? target.replace("*", captured) : target;
            const hit = matchKnown(resolve(baseDir, substituted), known);
            if (hit) {
                return hit;
            }
        }
    }

    return null;
}

/**
 * For each file in `files`, count how many OTHER files import it. Both relative
 * specifiers (`./foo`) and tsconfig-alias specifiers (`@app/foo`, when `alias`
 * is provided) are resolved textually; static `from` imports, side-effect
 * imports (`import "./foo"`), and dynamic `import()` / `require()` are all
 * counted. Self-imports are ignored.
 *
 * Limitations (documented in the CLI help): imports built from computed strings,
 * paths from an `extends`-ed tsconfig, and cross-package specifiers are not
 * resolved — such a file may still be flagged as a candidate. The grace window
 * and manual review exist to catch those.
 */
export function buildInboundImportCounts(files: string[], alias?: AliasConfig): Map<string, number> {
    const known = new Set(files);
    const counts = new Map<string, number>();
    for (const file of files) {
        counts.set(file, 0);
    }

    const aliasCtx = alias ? { rules: compileAliasRules(alias), baseDir: alias.baseDir } : null;

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
            const resolved = spec.startsWith(".")
                ? resolveRelative(spec, importer, known)
                : aliasCtx
                  ? resolveAlias(spec, aliasCtx.rules, aliasCtx.baseDir, known)
                  : null;
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
