import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { EXT_TO_DYNAMIC_LANG } from "@app/indexer/lib/ast-languages";
import { logger } from "@app/logger";
import { countTokens } from "@app/utils/tokens";
import { extractSymbols, isBuiltinLanguage, languageForFile } from "./extract";
import type { ExtractedSymbol, ScannedFile } from "./types";

export interface ScannedFileWithTokens extends ScannedFile {
    tokens: number;
}

export interface ScanResult {
    root: string;
    files: ScannedFileWithTokens[];
    /** repo-relative path → number of mapped files importing it. */
    fanIn: Record<string, number>;
}

function toPosix(p: string): string {
    return p.split("\\").join("/");
}

/** List candidate files via git (honors .gitignore) or null when not a git repo. */
async function gitListFiles(dir: string): Promise<string[] | null> {
    try {
        const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
            cwd: dir,
            stdout: "pipe",
            stderr: "ignore",
        });

        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        if (proc.exitCode !== 0) {
            return null;
        }

        return stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
    } catch (err) {
        logger.debug(
            `repo-map: git ls-files failed (git missing or not a repo): ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
    }
}

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs"]);

function isSupported(rel: string, languages: Set<string> | null): boolean {
    const ext = extname(rel).toLowerCase();

    if (!SUPPORTED_EXTS.has(ext)) {
        return false;
    }

    if (!languages) {
        return true;
    }

    const lang = languageForFile(ext);
    return lang !== null && languages.has(lang);
}

/** Extract raw import module specifiers from TS/JS source (cheap regex). */
function extractImports(source: string): string[] {
    const out: string[] = [];
    const re = /(?:import|export)[^"']*?from\s*["']([^"']+)["']|(?:require|import)\(\s*["']([^"']+)["']\s*\)/g;
    let m: RegExpExecArray | null = re.exec(source);

    while (m !== null) {
        const spec = m[1] ?? m[2];

        if (spec) {
            out.push(spec);
        }

        m = re.exec(source);
    }

    return out;
}

/** Resolve a relative import specifier to a repo-relative path (best-effort). */
function resolveImport(fromRel: string, spec: string, knownPaths: Set<string>): string | null {
    if (!spec.startsWith(".")) {
        return null;
    }

    const baseDir = toPosix(join(fromRel, ".."));
    const target = toPosix(join(baseDir, spec));
    const extensions = [".ts", ".tsx", ".js", ".jsx"];
    const candidates = [
        target,
        ...extensions.map((e) => `${target}${e}`),
        ...extensions.map((e) => `${target}/index${e}`),
    ];

    for (const c of candidates) {
        if (knownPaths.has(c)) {
            return c;
        }
    }

    return null;
}

/**
 * Scan a directory into a structural map. IMPURE: touches fs/git and calls
 * countTokens (the single token-counting site). `languages` is a set of
 * language NAMES (e.g. "typescript") or null for all supported.
 */
export async function scanRepo({
    dir,
    languages,
}: {
    dir: string;
    languages: Set<string> | null;
}): Promise<ScanResult> {
    const root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    const gitFiles = await gitListFiles(root);

    if (gitFiles === null) {
        logger.debug(
            `repo-map: ${root} is not a git repo; no files discovered (manual ignore-walk fallback unimplemented)`
        );
    }

    const rels = (gitFiles ?? []).filter((rel) => isSupported(rel, languages));
    const built: ScannedFileWithTokens[] = [];

    for (const rel of rels) {
        const absPath = join(root, rel);

        if (!existsSync(absPath)) {
            continue;
        }

        const ext = extname(rel).toLowerCase();
        const language = languageForFile(ext) ?? "unknown";
        const source = readFileSync(absPath, "utf-8");
        const stat = statSync(absPath);
        let symbols: ExtractedSymbol[] = [];

        if (isBuiltinLanguage(ext)) {
            try {
                symbols = extractSymbols(source, language);
            } catch (err) {
                logger.error({ rel, err }, "repo-map: failed to extract symbols");
            }
        }

        if (!isBuiltinLanguage(ext) && EXT_TO_DYNAMIC_LANG[ext]) {
            logger.debug(`repo-map: ${rel} is a dynamic-language file; symbol extraction is best-effort/skipped here`);
        }

        const signaturesText = symbols.map((s) => s.signature).join("\n");
        built.push({
            path: toPosix(rel),
            absPath,
            language,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            imports: extractImports(source),
            symbols,
            tokens: countTokens(`${rel}\n${signaturesText}`),
        });
    }

    const knownPaths = new Set(built.map((f) => f.path));
    const fanIn: Record<string, number> = {};

    for (const file of built) {
        for (const spec of file.imports) {
            const target = resolveImport(file.path, spec, knownPaths);

            if (target) {
                fanIn[target] = (fanIn[target] ?? 0) + 1;
            }
        }
    }

    return { root, files: built, fanIn };
}
