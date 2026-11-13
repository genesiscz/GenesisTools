/**
 * The `census` source of the roster proposer: shapes that one module of the current tree already owns.
 *
 * For each shape in tracked non-test TypeScript under `src/`, it groups the files that hold it by module
 * (`src/<tool>/`, `src/utils/<area>/`). The owner is the module with most occurrences. A shape that lives almost only
 * in its owner is a roster candidate: the few files outside are the baseline, and a fully owned shape (nothing outside)
 * gets a roster with an empty baseline that stops the first leak.
 */
import { allowedInSource, isStateFileName, moduleOf, type Shape, type ShapeKind, shapeKey } from "./propose-shapes";

export type CensusKind = Extract<ShapeKind, "argv" | "import" | "new" | "literal">;

export interface CensusCandidate {
    source: "census";
    key: string;
    shape: Shape;
    /** The module with most occurrences (`src/<tool>/`, `src/utils/<area>/`, or one file). */
    owner: string;
    /** The owner's occurrences divided by all occurrences. */
    share: number;
    ownerFiles: number;
    totalFiles: number;
    /** Files outside the owner that hold the shape (the roster's baseline), sorted. */
    outliers: string[];
    fullyOwned: boolean;
    allowedIn: string;
}

export interface CensusHit {
    shape: Shape;
    count: number;
    /** For `new`: the package the class is imported from. */
    origin?: string;
}

export interface CensusOptions {
    /** At least this many files in total. */
    minFiles?: number;
    /** The owner holds at least this share of the occurrences. */
    minShare?: number;
    /** At most this many files outside the owner. */
    maxOutliers?: number;
    /** A fully owned shape needs at least this many files inside its owner. */
    minOwnedFiles?: number;
    /**
     * The third-party packages to count (the root package.json dependencies). Without it, every bare specifier that
     * is not an alias of this repo counts.
     */
    packages?: ReadonlySet<string>;
    /**
     * Whether an argv head is an external command (on PATH). Without it, every head counts. Words that are not
     * commands (`["metadata", …]`, `["window", …]`) are option lists or subcommands of a wrapper, not a CLI.
     */
    isCommand?: (name: string) => boolean;
}

/**
 * Argv heads no module owns: CLIs every tool spawns for its own reasons, and plain words that also exist as a macOS
 * binary (`["chat", …]` is a list of modes, not a call of /usr/sbin/chat).
 */
const NOT_OWNED_COMMANDS = new Set([
    "git",
    "bun",
    "bunx",
    "node",
    "npx",
    "npm",
    "open",
    "sh",
    "bash",
    "zsh",
    "env",
    "chat",
    "time",
    "login",
    "test",
    "true",
    "false",
    "file",
    "find",
    "sort",
    "join",
    "split",
    "head",
    "tail",
    "paste",
    "diff",
    "kill",
    "wait",
    "read",
    "which",
    "users",
    "uptime",
]);

/** The head of an array literal of two or more items (`["launchctl", "load", plist]`). */
const ARGV = /\[\s*["']([a-z][\w.-]*)["']\s*,/g;
const IMPORT_FROM = /\bimport\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const NEW = /\bnew\s+([A-Z][\w$]*)\s*[(<]/g;
const STRING = /["'`]([\w.-]+\.(?:jsonl?|db|sqlite|lock|pid|sock|plist))["'`]/g;

/** A third-party package specifier reduced to its package (`@scope/pkg`, `pkg`); null for anything local. Pure. */
export function thirdPartyPackage(specifier: string): string | null {
    if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("@app/") ||
        specifier.startsWith("@genesiscz/utils") ||
        /^(?:node|bun):/.test(specifier) ||
        specifier === "bun"
    ) {
        return null;
    }

    const parts = specifier.split("/");
    return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The local names an import clause binds (`A`, `{ B, C as D }`, `* as E`). Pure. */
function importedNames(clause: string): string[] {
    return clause
        .replace(/[{}]/g, ",")
        .split(",")
        .map((part) => part.trim().replace(/^type\s+/, ""))
        .filter(Boolean)
        .map((part) => part.split(/\s+as\s+/).at(-1) ?? part)
        .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/** The census shapes one file holds, with their occurrence counts. Comment lines are left out. Pure. */
export function censusShapesOf(
    text: string,
    { packages, isCommand }: Pick<CensusOptions, "packages" | "isCommand"> = {}
): Map<string, CensusHit> {
    const found = new Map<string, CensusHit>();
    const code = text
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .map((line) => line.replace(/\s\/\/.*$/, ""))
        .join("\n");

    const add = (kind: CensusKind, value: string, origin?: string) => {
        const shape = { kind, value };
        const key = shapeKey(shape);
        const entry = found.get(key);

        if (entry) {
            entry.count += 1;
        } else {
            found.set(key, { shape, count: 1, origin });
        }
    };

    /**
     * Names imported from a package, `node:` or `bun:`, with the package. Constructing one (`new Database(`) is a
     * dependency a module can own; a class of this repo is meant to be reused, so building it is not a pattern.
     */
    const external = new Map<string, string>();

    for (const match of code.matchAll(IMPORT_FROM)) {
        const specifier = match[2] ?? match[3] ?? "";
        const pkg = thirdPartyPackage(specifier);
        const isPackage =
            pkg !== null && !specifier.startsWith("@/") && !specifier.startsWith("~/") && (packages?.has(pkg) ?? true);

        if (pkg !== null && isPackage) {
            add("import", pkg);
        }

        const origin = isPackage ? pkg : /^(?:node|bun):|^bun$/.test(specifier) ? specifier : null;

        if (origin !== null) {
            for (const name of importedNames(match[1] ?? "")) {
                external.set(name, origin);
            }
        }
    }

    for (const match of code.matchAll(NEW)) {
        const origin = external.get(match[1]);

        // An error class is thrown wherever its failure happens: constructing one is not a dependency to own.
        if (origin !== undefined && !match[1].endsWith("Error")) {
            add("new", match[1], origin);
        }
    }

    for (const match of code.matchAll(ARGV)) {
        if (!NOT_OWNED_COMMANDS.has(match[1]) && (isCommand?.(match[1]) ?? true)) {
            add("argv", match[1]);
        }
    }

    for (const match of code.matchAll(STRING)) {
        if (isStateFileName(match[1])) {
            add("literal", match[1]);
        }
    }

    return found;
}

/**
 * The census of a file map (path → source): every shape that one module owns, fully owned shapes first (by the
 * owner's file count), then the rest by fewest outliers. Pure.
 */
export function census(files: ReadonlyMap<string, string>, options: CensusOptions = {}): CensusCandidate[] {
    const { minFiles = 3, minShare = 0.6, maxOutliers = 8, minOwnedFiles = 3 } = options;
    const byShape = new Map<string, { shape: Shape; files: Map<string, number>; origins: Set<string> }>();

    for (const [file, text] of files) {
        for (const [key, { shape, count, origin }] of censusShapesOf(text, options)) {
            let entry = byShape.get(key);

            if (!entry) {
                entry = { shape, files: new Map(), origins: new Set() };
                byShape.set(key, entry);
            }

            entry.files.set(file, count);

            if (origin !== undefined) {
                entry.origins.add(origin);
            }
        }
    }

    const candidates: CensusCandidate[] = [];

    for (const [key, { shape, files: holders, origins }] of byShape) {
        // Two classes of one name (`new Api(` of two clients) are two shapes the name alone cannot tell apart.
        if (holders.size < minFiles || origins.size > 1) {
            continue;
        }

        const modules = new Map<string, { count: number; files: number }>();
        let total = 0;

        for (const [file, count] of holders) {
            const module = moduleOf(file);
            const entry = modules.get(module) ?? { count: 0, files: 0 };
            entry.count += count;
            entry.files += 1;
            modules.set(module, entry);
            total += count;
        }

        const [owner, stats] = [...modules.entries()].sort(
            (a, b) => b[1].count - a[1].count || b[1].files - a[1].files || a[0].localeCompare(b[0])
        )[0];
        const outliers = [...holders.keys()].filter((file) => moduleOf(file) !== owner).sort();
        const share = stats.count / total;
        const fullyOwned = outliers.length === 0 && stats.files >= minOwnedFiles;

        if (share < minShare || outliers.length > maxOutliers || (outliers.length === 0 && !fullyOwned)) {
            continue;
        }

        candidates.push({
            source: "census",
            key,
            shape,
            owner,
            share: Math.round(share * 100) / 100,
            ownerFiles: stats.files,
            totalFiles: holders.size,
            outliers,
            fullyOwned,
            allowedIn: allowedInSource(owner),
        });
    }

    return candidates.sort(
        (a, b) =>
            Number(b.fullyOwned) - Number(a.fullyOwned) ||
            (a.fullyOwned ? b.ownerFiles - a.ownerFiles : a.outliers.length - b.outliers.length) ||
            b.totalFiles - a.totalFiles ||
            a.key.localeCompare(b.key)
    );
}
