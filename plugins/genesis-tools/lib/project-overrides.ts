/**
 * Per-project, per-consumer output folders.
 *
 *   ~/.genesis-tools/plugins/config.json
 *     { "projectOverrides": { "<projectDir>": {
 *         "appliesToWorktrees": true,
 *         "rule": "one sentence shown to the user",
 *         "consumers": {
 *           "research": { "dir": "~/Vault/Acme/Research" },
 *           "wrap-up":  { "resolverCommand": "bun ~/…/acme.ts --cwd <cwd>" }
 *         } } } }
 *
 * One project, one block, one entry per consumer, and each entry is either a static `dir` or a
 * `resolverCommand` that DERIVES one. That is the whole point of the split: a project can want
 * its research in a single flat folder while its wrap-ups go to a per-ticket folder whose name
 * nothing can know in advance, and the reverse for the next project.
 *
 * Only reach for a `resolverCommand` when the folder genuinely cannot be written down, because
 * it depends on an issue id, an MR number or a sprint. A static folder belongs in `dir`, or in
 * the vault registry when several projects share the pattern.
 */

import type { Ctx } from "./git-context.ts";
import { sh } from "./git-context.ts";
import { expandHome, pluginSection } from "./plugin-config.ts";

export interface ConsumerOverride {
    /** A folder that never changes for this project. Absolute or `~/`-prefixed. */
    dir?: string;
    /**
     * Shell command printing JSON with a `dir` field. Placeholders are substituted before it
     * runs: `<cwd>`, `<project>`, `<worktree>`, `<branch>`.
     */
    resolverCommand?: string;
}

export interface ProjectOverride {
    /** Match linked worktrees of this project too, not just the main checkout. Default true. */
    appliesToWorktrees?: boolean;
    /** Free text, echoed back so the agent can show the user the rule it followed. */
    rule?: string;
    consumers?: Record<string, ConsumerOverride>;
}

export type ProjectOverrides = Record<string, ProjectOverride>;

export async function loadProjectOverrides(label: string): Promise<ProjectOverrides> {
    return pluginSection<ProjectOverrides>("projectOverrides", label) as Promise<ProjectOverrides>;
}

/**
 * Which block applies to this checkout.
 *
 * Keyed by the main checkout, because a project's worktrees come and go while its vault folders
 * do not. `appliesToWorktrees: false` opts out for a project whose worktrees want different
 * homes; a block keyed directly on the worktree still wins for that worktree.
 */
export function overrideFor(overrides: ProjectOverrides, ctx: Ctx): { key: string; override: ProjectOverride } | null {
    const candidates = [ctx.toplevel, ctx.mainProject].filter((path): path is string => Boolean(path));

    for (const key of Object.keys(overrides ?? {})) {
        const expanded = expandHome(key);
        const override = overrides[key] as ProjectOverride;

        if (candidates.includes(expanded) && (expanded === ctx.toplevel || override.appliesToWorktrees !== false)) {
            return { key: expanded, override };
        }
    }

    return null;
}

/** `<cwd>`, `<project>`, `<worktree>` and `<branch>` filled in from the resolved context. */
export function fillPlaceholders(command: string, ctx: Ctx): string {
    return command
        .replaceAll("<cwd>", ctx.cwd)
        .replaceAll("<project>", ctx.mainProject || ctx.toplevel)
        .replaceAll("<worktree>", ctx.toplevel)
        .replaceAll("<branch>", ctx.branch);
}

export interface ResolverOutput {
    dir?: string;
    warnings?: string[];
    [key: string]: unknown;
}

/**
 * Run a resolver and read `dir` out of its JSON.
 *
 * A resolver that fails must never silently demote the run to a shared default: that is how one
 * project's notes land in another project's folder. Failures are reported and the caller stops.
 */
export async function runResolver(
    command: string,
    ctx: Ctx,
    label: string
): Promise<{ output?: ResolverOutput; error?: string }> {
    const filled = fillPlaceholders(command, ctx);
    const raw = await sh(["sh", "-c", filled], label);

    if (!raw) {
        return { error: `resolverCommand printed nothing: ${filled}` };
    }

    try {
        // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
        const parsed = JSON.parse(raw);

        if (typeof parsed?.dir !== "string" || !parsed.dir) {
            return { error: `resolverCommand returned no "dir": ${raw.slice(0, 200)}` };
        }

        return { output: parsed as ResolverOutput };
    } catch (err) {
        return { error: `resolverCommand did not print JSON (${String(err)}): ${raw.slice(0, 200)}` };
    }
}

export type OverrideResolution =
    | { kind: "none" }
    | { kind: "dir"; dir: string; key: string; rule?: string; warnings: string[] }
    | {
          kind: "resolver";
          dir: string;
          key: string;
          rule?: string;
          command: string;
          output: ResolverOutput;
          warnings: string[];
      }
    | { kind: "failed"; key: string; rule?: string; command: string; error: string };

/**
 * This consumer's folder for this checkout, from the project overrides alone.
 *
 * `kind: "failed"` is deliberately not the same as `kind: "none"`. A project that declares a
 * resolver has said where its output belongs; when that resolver breaks, the answer is to fix
 * it, never to fall through to whatever default the next tier would have produced.
 */
export async function resolveOverride({
    overrides,
    ctx,
    consumer,
    label,
}: {
    overrides: ProjectOverrides;
    ctx: Ctx;
    consumer: string;
    label: string;
}): Promise<OverrideResolution> {
    const matched = overrideFor(overrides, ctx);
    const forConsumer = matched?.override.consumers?.[consumer];

    if (!matched || !forConsumer) {
        return { kind: "none" };
    }

    const { key, override } = matched;

    if (forConsumer.resolverCommand) {
        const { output, error } = await runResolver(forConsumer.resolverCommand, ctx, label);

        if (output?.dir) {
            return {
                kind: "resolver",
                dir: output.dir,
                key,
                rule: override.rule,
                command: forConsumer.resolverCommand,
                output,
                warnings: output.warnings ?? [],
            };
        }

        return {
            kind: "failed",
            key,
            rule: override.rule,
            command: forConsumer.resolverCommand,
            error: error ?? "resolver failed",
        };
    }

    if (forConsumer.dir) {
        return { kind: "dir", dir: expandHome(forConsumer.dir), key, rule: override.rule, warnings: [] };
    }

    return { kind: "none" };
}
