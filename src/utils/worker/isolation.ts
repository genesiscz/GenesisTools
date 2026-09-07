import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which of the user's personal surfaces a headless worker loads. ON by default
 * on every backend that can honour it (Martin, 2026-09-04): a worker that knows
 * the user's skills and rules does better work; `--no-skills` / `--no-rules`
 * are the opt-out, sticky in the session meta so a steer keeps the choice.
 *
 * Hooks, MCP servers and session pickup are NOT surfaces: they are side effects
 * and credentials, and stay off unconditionally.
 */
export interface WorkerSurfaces {
    skills: boolean;
    rules: boolean;
}

export const DEFAULT_SURFACES: WorkerSurfaces = { skills: true, rules: true };

/** Commander's `--skills/--no-skills` pair leaves the value undefined when neither was given. */
export function surfacesFromFlags(
    flags: { skills?: boolean; rules?: boolean },
    previous: WorkerSurfaces = DEFAULT_SURFACES
): WorkerSurfaces {
    return {
        skills: flags.skills ?? previous.skills,
        rules: flags.rules ?? previous.rules,
    };
}

/**
 * The grok CLI's `[compat.claude]` toggles as environment variables. `skills`
 * gates `~/.claude/skills` and `<cwd>/.claude/skills`; `rules` gates
 * `~/.claude/rules` and the home-level `~/.claude/CLAUDE.md` (the `agents` cell).
 * The `~/.agents/skills` tier has no toggle and is handled by the worker home's
 * config.toml (`grokWorkerConfigToml`).
 */
export function grokSurfaceEnv(surfaces: WorkerSurfaces): Record<string, string> {
    return {
        GROK_CLAUDE_SKILLS_ENABLED: surfaces.skills ? "1" : "0",
        GROK_CLAUDE_RULES_ENABLED: surfaces.rules ? "1" : "0",
        GROK_CLAUDE_AGENTS_ENABLED: surfaces.rules ? "1" : "0",
    };
}

const SKILLS_IGNORE_BEGIN = "# genesis-tools: worker skills isolation (begin)";
const SKILLS_IGNORE_END = "# genesis-tools: worker skills isolation (end)";
const SKILLS_IGNORE_BLOCK = [
    SKILLS_IGNORE_BEGIN,
    "[skills]",
    'ignore = ["~/.agents", "~/.claude"]',
    SKILLS_IGNORE_END,
    "",
].join("\n");

/**
 * The worker home's config.toml with the skills-ignore block present or absent.
 * grok scans `~/.agents/skills` against the real $HOME regardless of GROK_HOME
 * and offers no env toggle for it, so `--no-skills` has to say it in config
 * (`[skills] ignore`, docs 08-skills.md). The block is marked so it can be
 * removed again when a later steer turns skills back on.
 */
export function grokWorkerConfigToml(existing: string, surfaces: WorkerSurfaces): string {
    const begin = existing.indexOf(SKILLS_IGNORE_BEGIN);
    const end = existing.indexOf(SKILLS_IGNORE_END);
    const stripped =
        begin !== -1 && end !== -1
            ? `${existing.slice(0, begin)}${existing.slice(end + SKILLS_IGNORE_END.length).replace(/^\n/, "")}`
            : existing;

    if (surfaces.skills) {
        return stripped;
    }

    const separator = stripped.length > 0 && !stripped.endsWith("\n") ? "\n" : "";
    return `${stripped}${separator}${SKILLS_IGNORE_BLOCK}`;
}

/** Write the worker home's config.toml for these surfaces; a no-op when nothing changes. */
export function ensureGrokWorkerConfig(workerHome: string, surfaces: WorkerSurfaces): void {
    const path = join(workerHome, "config.toml");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const next = grokWorkerConfigToml(existing, surfaces);
    if (next === existing) {
        return;
    }

    mkdirSync(workerHome, { recursive: true });
    writeFileSync(path, next, "utf8");
}
