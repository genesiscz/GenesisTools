import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { shellWord } from "@genesiscz/utils/shell/quote";
import { parseSync } from "oxc-parser";
import type { DeployedFile } from "./deployed.ts";

const { log } = logger.scoped("ts:sourcemaps:env");
const prof = profiler.scope("sourcemaps");

/** Keys a bundler inlines from the build environment: the tool's own, and each framework's public prefix. */
const ENV_KEY =
    /^(?:NODE_ENV|PUBLIC_URL|BASE_URL|MODE|DEV|PROD|SSR|(?:REACT_APP|VITE|NEXT_PUBLIC|NUXT_PUBLIC|PUBLIC|GATSBY|EXPO_PUBLIC|STORYBOOK)_[A-Z0-9_]+)$/;
/** Keys the build tool sets itself; a caller never passes them. */
const TOOL_KEYS = new Set(["NODE_ENV", "BASE_URL", "MODE", "DEV", "PROD", "SSR"]);

export interface InlinedEnvValue {
    name: string;
    /** The inlined value as text; null when the build had it unset (`void 0`). */
    value: string | null;
    /** Deployed files whose env object carries this value. */
    files: number;
    /** Other values the same name has in other env objects of the deployment. */
    conflicts: string[];
}

interface EstreeNode {
    type: string;
    [key: string]: unknown;
}

function isNode(value: unknown): value is EstreeNode {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** A property value as the build wrote it: a literal, `!0`/`!1`, or `void 0`. Undefined for anything computed. */
function literalText(node: unknown): string | null | undefined {
    if (!isNode(node)) {
        return undefined;
    }

    if (node.type === "Literal") {
        return typeof node.value === "string" || typeof node.value === "number" || typeof node.value === "boolean"
            ? String(node.value)
            : undefined;
    }

    if (node.type === "UnaryExpression" && isNode(node.argument) && node.argument.type === "Literal") {
        if (node.operator === "void") {
            return null;
        }

        if (node.operator === "!") {
            return String(!node.argument.value);
        }
    }

    if (node.type === "Identifier" && node.name === "undefined") {
        return null;
    }

    return undefined;
}

/**
 * The env objects a bundle inlined (`process.env` in webpack/CRA/rsbuild, `import.meta.env` in Vite): object
 * literals with NODE_ENV or MODE and at least two env-shaped keys. Values that a define replaced one by one are
 * not recoverable as name=value, so they do not show up here.
 */
export function inlinedEnvObjects(code: string, filename = "chunk.js"): Array<Record<string, string | null>> {
    const parsed = parseSync(filename, code, { sourceType: "unambiguous", preserveParens: false });
    const objects: Array<Record<string, string | null>> = [];
    const stack: unknown[] = [parsed.program];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!isNode(node)) {
            continue;
        }

        if (node.type === "ObjectExpression") {
            const env: Record<string, string | null> = {};
            for (const property of (node.properties as unknown[]) ?? []) {
                if (!isNode(property) || property.type !== "Property" || property.computed || !isNode(property.key)) {
                    continue;
                }

                const key = property.key.type === "Identifier" ? String(property.key.name) : String(property.key.value);
                const value = literalText(property.value);
                if (ENV_KEY.test(key) && value !== undefined) {
                    env[key] = value;
                }
            }

            const keys = Object.keys(env);
            if (keys.length >= 2 && ("NODE_ENV" in env || "MODE" in env)) {
                objects.push(env);
            }
        }

        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                stack.push(...value);
            } else if (isNode(value)) {
                stack.push(value);
            }
        }
    }

    return objects;
}

/** Every inlined env value of a deployment, most common value per name, with the values that disagree. */
export async function findInlinedEnv(deployed: { dir: string; files: DeployedFile[] }): Promise<InlinedEnvValue[]> {
    return prof.measureAsync("env.scan", async () => {
        const counts = new Map<string, Map<string | null, number>>();
        for (const file of deployed.files.filter((candidate) => /\.m?js$/.test(candidate.path))) {
            const code = await readFile(join(deployed.dir, file.path), "utf8");
            if (!/\b(?:NODE_ENV|MODE)\s*:/.test(code)) {
                continue;
            }

            let objects: Array<Record<string, string | null>>;
            try {
                objects = inlinedEnvObjects(code, file.path.split("/").pop() || "chunk.js");
            } catch (err) {
                log.debug({ err, file: file.path }, "file did not parse; its env objects are skipped");
                continue;
            }

            for (const env of objects) {
                for (const [name, value] of Object.entries(env)) {
                    const byValue = counts.get(name) ?? new Map<string | null, number>();
                    byValue.set(value, (byValue.get(value) ?? 0) + 1);
                    counts.set(name, byValue);
                }
            }
        }

        const values = [...counts.entries()].map(([name, byValue]) => {
            const ranked = [...byValue.entries()].sort((a, z) => z[1] - a[1]);
            const [value, files] = ranked[0] as [string | null, number];
            return { name, value, files, conflicts: ranked.slice(1).map(([other]) => String(other)) };
        });
        log.info({ values: values.length }, "inlined env scanned");
        return values.sort((a, z) => a.name.localeCompare(z.name));
    });
}

/** `--env NAME=VALUE` words for a command line, each quoted when the shell would otherwise split or expand it. */
export function envFlags(env: Record<string, string>): string[] {
    return Object.entries(env).map(([name, value]) => `--env ${shellWord(`${name}=${value}`)}`);
}

/** The values a caller should pass to a local build (`--env NAME=VALUE`): set, and not the build tool's own. */
export function buildEnvFrom(values: InlinedEnvValue[]): Record<string, string> {
    return Object.fromEntries(
        values
            .filter((entry) => entry.value !== null && !TOOL_KEYS.has(entry.name))
            .map((entry) => [entry.name, entry.value as string])
    );
}
