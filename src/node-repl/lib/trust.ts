import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * What a REPL turn may `import()`. Read once when the worker starts, never changed by a turn:
 * the allowlist is the one chokepoint every dynamic import passes through, so it is decided
 * outside the code it governs.
 */
export interface ImportPolicy {
    /** `node:` builtins */
    allowBuiltins: boolean;
    /** bare specifiers resolvable from the server's own dependency tree */
    allowRepoDeps: boolean;
    /** absolute paths and file: URLs anywhere on disk */
    allowPaths: boolean;
    /** extra bare specifiers, exact names */
    allowBare: string[];
    /** where the policy came from, for error messages */
    source: string;
}

export const DEFAULT_IMPORT_POLICY: ImportPolicy = {
    allowBuiltins: true,
    allowRepoDeps: true,
    allowPaths: true,
    allowBare: [],
    source: "built-in defaults",
};

export function importPolicyPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "node-repl", "trust.json");
}

export function loadImportPolicy(path = importPolicyPath()): ImportPolicy {
    if (!existsSync(path)) {
        return DEFAULT_IMPORT_POLICY;
    }

    const parsed = SafeJSON.parse(readFileSync(path, "utf8")) as Partial<ImportPolicy>;
    return {
        allowBuiltins: parsed.allowBuiltins ?? DEFAULT_IMPORT_POLICY.allowBuiltins,
        allowRepoDeps: parsed.allowRepoDeps ?? DEFAULT_IMPORT_POLICY.allowRepoDeps,
        allowPaths: parsed.allowPaths ?? DEFAULT_IMPORT_POLICY.allowPaths,
        allowBare: parsed.allowBare ?? [],
        source: path,
    };
}

export function importAllowed(specifier: string, policy: ImportPolicy, moduleDirs: string[]): boolean {
    if (specifier.startsWith("node:")) {
        return policy.allowBuiltins;
    }

    if (specifier.startsWith("/") || specifier.startsWith("file:") || specifier.startsWith(".")) {
        return policy.allowPaths;
    }

    if (specifier.startsWith("data:")) {
        return true;
    }

    if (policy.allowBare.includes(specifier) || moduleDirs.length > 0) {
        return true;
    }

    return policy.allowRepoDeps;
}
