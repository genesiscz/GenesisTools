import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The files outside `src/ai-proxy/lib/providers/` that still compare an ai-proxy provider name
 * (`AiProxyProviderType`), and how many comparisons each may keep. Counted 2026-10-28 when lint-rules
 * `no-proxy-provider-branch` was added (HTML review 3.3, points 3, 4 and 6): 71 comparisons in 17 files before the
 * `PROVIDER_DEFINITIONS` table, 9 in 5 files after it, and none since 2026-10-29: the chat paths and the compaction
 * recovery became `ProviderDefinition.routes`, the one-provider `accounts` subcommands `PROVIDER_ACCOUNT_COMMANDS`.
 * Ratchet: a file may not join the list, a count may only go down, lint-rules fails a file with one comparison more
 * than its count, and `lint-rules.test.ts` fails a count above the file's real number. A provider difference belongs
 * in its `ProviderDefinition` (`src/ai-proxy/lib/providers/definition.ts`) or in its `ProxyProvider`.
 */
export const PROXY_PROVIDER_BRANCH_RATCHET: ReadonlyMap<string, number> = new Map<string, number>([]);

/**
 * The provider definition table is a leaf of static facts (C14, 2026-11-10): a definition loads its provider class
 * only when `create` runs, and the live providers are in `providers/pool.ts`. Before that, any reader of a static fact
 * (`loadConfig`, the codex model list) sat in a 29-module import cycle and loaded all seven provider classes. These
 * entries must load none of them; `registry.test.ts` runs the check and fails on a static class import.
 */
export const PROVIDER_TABLE_LEAF_ENTRIES: readonly string[] = [
    "src/ai-proxy/lib/providers/registry.ts",
    "src/ai-proxy/lib/config.ts",
];

/** A provider class module, which only `ProviderDefinition.create` may load. */
export const PROVIDER_CLASS_MODULE = /\/src\/ai-proxy\/lib\/providers\/[a-z0-9-]+-(?:subscription|api-key)\.ts$/;

/** Importing two leaf modules takes about a second; a probe still running after this hangs and fails as such. */
export const PROVIDER_PROBE_TIMEOUT_MS = 60_000;

/** The provider class modules a fresh process loads when it imports the leaf entries, as paths under `root`. */
export function providerClassModulesLoadedByTable(root: string, timeoutMs = PROVIDER_PROBE_TIMEOUT_MS): string[] {
    const entries = PROVIDER_TABLE_LEAF_ENTRIES.map((entry) => `${root}/${entry}`);
    const script = [
        `for (const entry of ${SafeJSON.stringify(entries)}) { await import(entry); }`,
        "console.log(JSON.stringify(Object.keys(require.cache)));",
    ].join("\n");
    const child = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
    });

    if (child.exitedDueToTimeout) {
        throw new Error(
            `importing the provider table did not finish within ${timeoutMs} ms: an entry hangs at import or keeps the process alive`
        );
    }

    if (child.exitCode !== 0) {
        throw new Error(`importing the provider table failed (exit ${child.exitCode}): ${child.stderr.toString()}`);
    }

    const lines = child.stdout.toString().trim().split("\n");
    const loaded: unknown = SafeJSON.parse(lines[lines.length - 1] ?? "[]");

    if (!Array.isArray(loaded)) {
        throw new Error("importing the provider table printed no module list");
    }

    return loaded
        .filter((path): path is string => typeof path === "string" && PROVIDER_CLASS_MODULE.test(path))
        .map((path) => path.slice(path.indexOf("/src/") + 1))
        .sort();
}

if (import.meta.main) {
    const loaded = providerClassModulesLoadedByTable(process.cwd());

    if (loaded.length > 0) {
        console.error(
            `proxy-provider-ratchet: importing ${PROVIDER_TABLE_LEAF_ENTRIES.join(" and ")} loaded provider classes: ${loaded.join(", ")}. Load a class inside ProviderDefinition.create, never with a static import.`
        );
        process.exit(1);
    }

    console.log("proxy-provider-ratchet: the provider definition table loads no provider class");
}
