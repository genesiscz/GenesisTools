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
import { expandHome, pluginSection } from "./plugin-config.ts";

export interface ConsumerOverride {
    /** A folder that never changes for this project. Absolute or `~/`-prefixed. */
    dir?: string;
    /**
     * Shell command printing JSON with a `dir` field. Placeholders are substituted before it
     * runs: `<cwd>`, `<project>`, `<worktree>`, `<branch>`. Each becomes a quoted reference to
     * a `GT_RESOLVER_*` variable, so its value stays one argument wherever it sits and is never
     * read as shell syntax. The command is stopped after 30 s.
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
    const keys = Object.keys(overrides ?? {}).map((key) => ({ key, expanded: expandHome(key) }));
    // Two passes, so the answer never depends on key order in config.json: a block keyed on
    // this exact checkout always beats the main checkout's block, wherever either one sits.
    const exact = keys.find(({ expanded }) => expanded === ctx.toplevel);

    if (exact) {
        return { key: exact.expanded, override: overrides[exact.key] as ProjectOverride };
    }

    const viaMain = ctx.mainProject
        ? keys.find(
              ({ key, expanded }) =>
                  expanded === ctx.mainProject && (overrides[key] as ProjectOverride).appliesToWorktrees !== false
          )
        : undefined;

    return viaMain ? { key: viaMain.expanded, override: overrides[viaMain.key] as ProjectOverride } : null;
}

type QuoteContext = "none" | "single" | "double";

/** Each placeholder travels in its own environment variable, never as command text. */
const PLACEHOLDER_ENV: Record<string, string> = {
    cwd: "GT_RESOLVER_CWD",
    project: "GT_RESOLVER_PROJECT",
    worktree: "GT_RESOLVER_WORKTREE",
    branch: "GT_RESOLVER_BRANCH",
};

/** The values behind the placeholders, as the environment `runResolver` hands the shell. */
export function placeholderEnv(ctx: Ctx): Record<string, string> {
    return {
        GT_RESOLVER_CWD: ctx.cwd,
        GT_RESOLVER_PROJECT: ctx.mainProject || ctx.toplevel,
        GT_RESOLVER_WORKTREE: ctx.toplevel,
        GT_RESOLVER_BRANCH: ctx.branch,
    };
}

/** A variable reference written so it expands to exactly one word in this quote context. */
function reference(variable: string, context: QuoteContext): string {
    if (context === "single") {
        return `'"\${${variable}}"'`;
    }

    if (context === "double") {
        return `\${${variable}}`;
    }

    return `"\${${variable}}"`;
}

/**
 * `<cwd>`, `<project>`, `<worktree>` and `<branch>` replaced by quoted references to the
 * variables from `placeholderEnv`. Branch names and checkout paths are repository data, and
 * `x;touch${IFS}y` is a valid branch: spliced in as text it ran as a second command. The shell
 * never parses the result of an expansion as syntax, so a value can no longer change the
 * command, whichever quotes the placeholder sits in.
 */
export function fillPlaceholders(command: string): string {
    let filled = "";
    let context: QuoteContext = "none";

    for (let i = 0; i < command.length; i++) {
        const char = command[i] as string;

        if (char === "<") {
            const end = command.indexOf(">", i);
            const name = end === -1 ? "" : command.slice(i + 1, end);

            if (Object.hasOwn(PLACEHOLDER_ENV, name)) {
                filled += reference(PLACEHOLDER_ENV[name] as string, context);
                i = end;
                continue;
            }
        }

        if (char === "\\" && context !== "single") {
            filled += char + (command[i + 1] ?? "");
            i++;
            continue;
        }

        if (char === "'" && context !== "double") {
            context = context === "single" ? "none" : "single";
        } else if (char === '"' && context !== "single") {
            context = context === "double" ? "none" : "double";
        }

        filled += char;
    }

    return filled;
}

export interface ResolverOutput {
    dir?: string;
    warnings?: string[];
    [key: string]: unknown;
}

/** A resolver that has not answered by then is stopped, so resolution can never hang. */
const RESOLVER_TIMEOUT_MS = 30_000;

/**
 * Runs `sh -c` with a deadline, in its own process group. Killing only the shell is not enough:
 * `sh -c "a; b"` keeps its child, the child keeps stdout open, and the caller then waits for the
 * child anyway (measured: a 300 ms deadline still exited at 6 s). The group kill takes both.
 */
function spawnShell(script: string, env: Record<string, string>) {
    return Bun.spawn(["sh", "-c", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        env: { ...process.env, ...env },
    });
}

async function runBounded({
    script,
    env,
    timeoutMs,
}: {
    script: string;
    env: Record<string, string>;
    timeoutMs: number;
}): Promise<{ stdout: string; error?: string }> {
    let proc: ReturnType<typeof spawnShell>;

    try {
        proc = spawnShell(script, env);
    } catch (err) {
        return { stdout: "", error: `could not run (${String(err)})` };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const result = await Promise.race([finished, expired]);

    clearTimeout(timer);

    if (result === "timeout") {
        try {
            // pid-verified: retained handle of our own unreaped child, spawned detached as leader of its own group.
            process.kill(-proc.pid, "SIGKILL");
        } catch (err) {
            // No process group to signal (the shell already exited): stop the shell itself.
            console.error(`resolverCommand: group kill failed, stopping the shell only: ${String(err)}`);
            proc.kill("SIGKILL");
        }

        return { stdout: "", error: `did not finish within ${timeoutMs} ms and was stopped` };
    }

    const [stdout, stderr, code] = result;

    if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : "";

        return { stdout: "", error: `exited ${code}${detail}` };
    }

    return { stdout };
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
    label: string,
    { timeoutMs = RESOLVER_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<{ output?: ResolverOutput; error?: string }> {
    const run = await runBounded({ script: fillPlaceholders(command), env: placeholderEnv(ctx), timeoutMs });

    if (run.error) {
        const error = `resolverCommand ${run.error}: ${command}`;

        console.error(`${label}: ${error}`);

        return { error };
    }

    const raw = run.stdout.trim();

    if (!raw) {
        return { error: `resolverCommand printed nothing: ${command}` };
    }

    try {
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
