import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, sep } from "node:path";
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

/**
 * A security policy read from disk is untrusted input. `"allowPaths": "false"` is a truthy
 * string, and an `allowBare` that is a string makes `.includes()` a substring test — both widen
 * the gate silently. Every field is therefore checked, and a malformed file is an error rather
 * than a default.
 */
function booleanField(value: unknown, field: string, path: string, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "boolean") {
        throw new Error(`${path}: "${field}" must be true or false, not ${typeof value}`);
    }

    return value;
}

function bareList(value: unknown, path: string): string[] {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        throw new Error(`${path}: "allowBare" must be an array of non-empty specifier strings`);
    }

    return value as string[];
}

export function loadImportPolicy(path = importPolicyPath()): ImportPolicy {
    if (!existsSync(path)) {
        return DEFAULT_IMPORT_POLICY;
    }

    const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${path}: the import policy must be a JSON object`);
    }

    const fields = parsed as Record<string, unknown>;
    return {
        allowBuiltins: booleanField(fields.allowBuiltins, "allowBuiltins", path, DEFAULT_IMPORT_POLICY.allowBuiltins),
        allowRepoDeps: booleanField(fields.allowRepoDeps, "allowRepoDeps", path, DEFAULT_IMPORT_POLICY.allowRepoDeps),
        allowPaths: booleanField(fields.allowPaths, "allowPaths", path, DEFAULT_IMPORT_POLICY.allowPaths),
        allowBare: bareList(fields.allowBare, path),
        source: path,
    };
}

/**
 * A directory registered with `js_add_node_module_dir` widens the allowlist for the modules IT
 * supplies, and for nothing else. Merely having registered one must not open every bare
 * specifier, so the specifier has to resolve to a file INSIDE the directory; a resolution that
 * walks up into a parent `node_modules` falls through to `allowRepoDeps` like any other.
 */
function resolveInsideModuleDir(specifier: string, moduleDirs: string[]): string | undefined {
    for (const dir of moduleDirs) {
        try {
            // Bun.resolveSync answers with the REAL path, so the directory has to be realpath'd
            // too or every registration under a symlink (macOS /var → /private/var, and every
            // temporary directory with it) fails a containment check it should pass.
            const root = realpathSync(dir);
            const resolved = Bun.resolveSync(specifier, root);

            if (resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
                return resolved;
            }
        } catch {
            // unreadable, or not resolvable from here; the next one, then the repo-deps rule
        }
    }

    return undefined;
}

export interface ImportDecision {
    allowed: boolean;
    /**
     * The exact file the caller must import, set only when a registered directory authorized
     * it. Resolving the specifier a second time can select a different file, which would make
     * the check and the import disagree about which module was approved.
     */
    resolved?: string;
}

export function importAllowed(specifier: string, policy: ImportPolicy, moduleDirs: string[]): ImportDecision {
    // Bun answers `fs` and `node:fs` with the same module, so gating only the prefixed form
    // leaves every builtin reachable through allowRepoDeps while allowBuiltins reads false.
    if (isBuiltin(specifier)) {
        return { allowed: policy.allowBuiltins };
    }

    if (specifier.startsWith("/") || specifier.startsWith("file:") || specifier.startsWith(".")) {
        return { allowed: policy.allowPaths };
    }

    if (specifier.startsWith("data:")) {
        return { allowed: true };
    }

    if (policy.allowBare.includes(specifier)) {
        return { allowed: true };
    }

    const contained = resolveInsideModuleDir(specifier, moduleDirs);

    if (contained) {
        return { allowed: true, resolved: contained };
    }

    return { allowed: policy.allowRepoDeps };
}
