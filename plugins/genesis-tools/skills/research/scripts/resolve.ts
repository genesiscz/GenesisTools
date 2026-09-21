#!/usr/bin/env bun

/**
 * research target resolver: "which directory does this research file go in?"
 *
 *   resolve  : print the directory, where the answer came from, and every reason it may be
 *              wrong. Context comes from the shell cwd unless --project/--branch/--cwd pin it.
 *   config   : print the effective research config and the paths it was read from.
 *
 * Resolution order, first hit wins:
 *   1. --path              the caller named a directory for this run only
 *   2. resolverCommand     a per-project script that DERIVES the directory (see SKILL.md)
 *   3. vault registry      the project-to-folder mappings wrap-up already keeps
 *   4. defaultPath         the global fallback
 *
 * Tiers 2 and 3 are why this script exists. Before it, research had one global `defaultPath`
 * and nothing else, so every project that answered "where should research go?" overwrote the
 * previous project's answer, and the 46 project-to-folder mappings in the registry were
 * invisible to it.
 */

import { isAbsolute, join } from "node:path";
import { ambientBranchWarnings, type Ctx, gitContext } from "../../../lib/git-context.ts";
import {
    expandHome,
    LEGACY_PATHS,
    migrateOnce,
    PLUGIN_CONFIG_PATH,
    pluginSection,
    writePluginSection,
} from "../../../lib/plugin-config.ts";
import { loadProjectOverrides, resolveOverride } from "../../../lib/project-overrides.ts";
import { dirFor, loadRegistry, rankEntries, registryPath } from "../../../lib/vault-registry.ts";

const LABEL = "research";

export interface ResearchConfig {
    defaultPath?: string;
    pathKind?: "absolute" | "project-relative";
    /** Overrides the registry location, same key wrap-up uses. */
    registryPath?: string;
}

let migration: Promise<unknown> | undefined;

/**
 * The research config moved from its own file into the shared plugin config, so that one
 * project answering the save-path prompt can no longer overwrite another project's answer.
 * Named in shipped code, so other installs can have the old file too.
 */
async function migrateConfig(): Promise<void> {
    migration ??= migrateOnce({
        from: LEGACY_PATHS.research,
        to: `${PLUGIN_CONFIG_PATH} ("research")`,
        label: LABEL,
        targetPresent: async () => Object.keys(await pluginSection<ResearchConfig>("research", LABEL)).length > 0,
        write: async (legacy) => {
            // `version` and `updatedAt` belonged to the standalone file's schema; the shared
            // config versions itself as a whole, so they are dropped rather than carried.
            const { version: _version, updatedAt: _updatedAt, ...rest } = legacy;

            await writePluginSection("research", rest, LABEL);
        },
    });

    await migration;
}

export async function loadConfig(): Promise<Partial<ResearchConfig>> {
    await migrateConfig();

    return pluginSection<ResearchConfig>("research", LABEL);
}

export function configuredDefault(config: Partial<ResearchConfig>, ctx: Ctx): string | null {
    if (!config.defaultPath) {
        return null;
    }

    const expanded = expandHome(config.defaultPath);
    const relative = config.pathKind === "project-relative" || (config.pathKind === undefined && !isAbsolute(expanded));

    return relative ? join(ctx.toplevel, expanded) : expanded;
}

function parseFlags(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] as string;

        if (!token.startsWith("--")) {
            continue;
        }

        const next = argv[index + 1];

        args[token.slice(2)] = next && !next.startsWith("--") ? (next as string) : "";
    }

    return args;
}

async function cmdResolve(args: Record<string, string>): Promise<void> {
    const ctx = await gitContext(args, LABEL);
    const config = await loadConfig();
    const warnings = [...ambientBranchWarnings(ctx)];

    const emit = (payload: Record<string, unknown>): void => {
        console.log(
            // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
            JSON.stringify(
                {
                    project: ctx.toplevel,
                    branch: ctx.branch,
                    cwd: ctx.cwd,
                    worktreeOf: ctx.mainProject || null,
                    config: PLUGIN_CONFIG_PATH,
                    ...payload,
                    warnings: [...warnings, ...((payload.warnings as string[]) ?? [])],
                },
                null,
                2
            )
        );
    };

    if (args.path) {
        emit({ found: true, source: "request", dir: expandHome(args.path) });

        return;
    }

    const override = await resolveOverride({
        overrides: await loadProjectOverrides(LABEL),
        ctx,
        consumer: LABEL,
        label: LABEL,
    });

    if (override.kind === "resolver" || override.kind === "dir") {
        emit({
            found: true,
            source: override.kind === "resolver" ? "resolver" : "override",
            dir: override.dir,
            rule: override.rule ?? null,
            ...(override.kind === "resolver"
                ? { resolver: { project: override.key, command: override.command, output: override.output } }
                : {}),
            warnings: override.warnings,
        });

        return;
    }

    if (override.kind === "failed") {
        // Falling through to the registry or the global default here would put this project's
        // research in another project's folder, which is the failure the override exists to stop.
        emit({
            found: false,
            source: "resolver",
            rule: override.rule ?? null,
            resolver: { project: override.key, command: override.command },
            warnings: [
                `${override.error} — this project declares a resolverCommand for research, so do NOT fall back: fix the resolver or pass --path`,
            ],
        });
        process.exitCode = 1;

        return;
    }

    const ranked = rankEntries(
        (await loadRegistry(await registryPath(config.registryPath, LABEL), LABEL)).entries,
        ctx
    );

    if (ranked.length > 0) {
        const { entry } = ranked[0] as { entry: Parameters<typeof dirFor>[0] };

        emit({
            found: true,
            source: "registry",
            dir: dirFor(entry, LABEL),
            matchedEntry: entry,
            alternatives: ranked
                .slice(1)
                .map(({ entry: alt, score }) => ({ dir: dirFor(alt, LABEL), branch: alt.branch ?? null, score })),
            warnings: [
                ...(entry.branch
                    ? []
                    : [
                          `matched a project-wide registry entry: it claims EVERY branch of this project, not just "${ctx.branch}"`,
                      ]),
                ...(ranked.length > 1
                    ? [`${ranked.length - 1} other registry entries also match — see "alternatives"`]
                    : []),
            ],
        });

        return;
    }

    const fallback = configuredDefault(config, ctx);

    if (fallback) {
        emit({
            found: true,
            source: "config",
            dir: fallback,
            warnings: [
                `no registry entry and no resolver for this project: this is the GLOBAL default, shared with every other project — register a folder if research for ${ctx.toplevel} belongs somewhere of its own`,
            ],
        });

        return;
    }

    // Exit 0, unlike the resolver-failure branch above. "Nothing is configured for this project"
    // is a question for the user, not an error: wrap-up answers the same condition the same way,
    // and a non-zero exit would make an ordinary first run look like a broken tool.
    emit({
        found: false,
        source: "none",
        warnings: [
            "no --path, no resolverCommand, no registry entry and no defaultPath — ask the user where this research file belongs",
        ],
    });
}

async function cmdConfig(): Promise<void> {
    const config = await loadConfig();

    console.log(
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        JSON.stringify(
            {
                config: PLUGIN_CONFIG_PATH,
                registry: await registryPath(config.registryPath, LABEL),
                legacyConfig: LEGACY_PATHS.research,
                research: config,
            },
            null,
            2
        )
    );
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    // `resolve` is the default, so a bare `--branch x` must not be read as a subcommand name.
    const command = argv[0]?.startsWith("--") ? "resolve" : argv[0];
    const args = parseFlags(argv[0]?.startsWith("--") ? argv : argv.slice(1));

    if (command === "config") {
        await cmdConfig();

        return;
    }

    if (command === undefined || command === "resolve") {
        await cmdResolve(args);

        return;
    }

    console.error(
        "usage: resolve.ts [resolve] [--path <dir>] [--project <dir>] [--branch <name>] [--cwd <dir>] | config"
    );
    process.exitCode = 2;
}

if (import.meta.main) {
    await main();
}
