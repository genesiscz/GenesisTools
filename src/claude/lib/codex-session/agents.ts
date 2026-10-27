/**
 * The subagents of a `tools claude codex` session (P14): one generator, two writers. Writer 1 is the `--agents` flag,
 * passed on every launch and resume because Claude Code does not keep it. Writer 2 writes the same definitions as
 * agent files, only into an isolated `CLAUDE_CONFIG_DIR` under `~/.genesis-tools/claude-codex/config/`.
 *
 * Every model id here is a session route form (`codex/<id>`, a bare `claude-*` id), which ai-proxy sends to the
 * accounts in the session record. The effort is the agent's `effort` field, not a `:<effort>` suffix: Claude Code
 * sends it as `output_config.effort`, so an Agent call's own `effort` can raise it. A suffix would win over both
 * (on 2026-10-27 a terra agent asked for xhigh ran at its `:high` and refused the task).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withSystemNote } from "@app/ai-proxy/lib/sessions/settings";
import type { ClaudeSessionsConfig } from "@app/ai-proxy/lib/types";
import { CLAUDE_MODELS } from "@app/claude/lib/models";
import type { CodexModelInfo } from "@genesiscz/utils/ai/openai/codex-models";
import { resolveOpenAiSubModel } from "@genesiscz/utils/ai/openai/sub-models";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/** A `claude --agents` entry, with the fields Claude Code 2.1.296 takes. */
export interface SessionAgentDefinition {
    description: string;
    prompt: string;
    model: string;
    effort?: string;
    /** Absent: the session's tools. */
    tools?: string[];
    disallowedTools?: string[];
    /** The subagent's own window in tokens, so a 272K Codex model does not inherit the main loop's 500K. */
    autoCompactWindow?: number;
}

export interface SessionAgentsInput {
    /** The Codex model catalog (`codexModelInfo`), for each model's window and efforts. */
    codexModel: (slug: string) => CodexModelInfo | undefined;
    /** Set when the session has a Claude account: adds `opus`, and `fable` when that account has Fable. */
    claude?: { fable: boolean };
    /** The Codex login the `codex-worker` pins its worker to (`tools codex spawn -a`). */
    codexAccount?: string;
    /** `claudeSessions` of the proxy config: the subagents' note and the skills nudge. */
    settings?: ClaudeSessionsConfig;
}

/** Whether the lead names each subagent's skills: on unless `claudeSessions.subagents.skills.nudge` is false. */
function skillsNudge(settings: ClaudeSessionsConfig | undefined): boolean {
    return settings?.subagents?.skills?.nudge !== false;
}

/** The Codex subagents' system prompt: the built-in one, the configured note around it, and the skills rule. */
function codexAgentPrompt(settings: ClaudeSessionsConfig | undefined): string {
    const skills = skillsNudge(settings)
        ? "\n\nSkills: load only the skills your brief names. A brief that names none needs none; do not load a skill to look around."
        : "";

    return withSystemNote(`${CODEX_PROMPT}${skills}`, settings?.subagents?.systemNote);
}

interface CodexAgentSpec {
    name: string;
    /** A built-in alias of `sub-models.ts`. */
    alias: string;
    effort: string;
    use: string;
}

/** Descriptions follow the Codex catalog's own (`~/.codex/models_cache.json`, read 2026-10-25). */
const CODEX_AGENTS: CodexAgentSpec[] = [
    {
        name: "sol",
        alias: "sol",
        effort: "high",
        use: "The default Codex worker for well-specified coding, refactoring, test and research tasks.",
    },
    {
        name: "sol-xhigh",
        alias: "sol",
        effort: "xhigh",
        use: "For hard or high-stakes work (security, auth, data integrity, a subtle algorithm) where depth matters more than speed.",
    },
    {
        name: "sol6",
        alias: "sol6",
        effort: "high",
        use: "The previous Sol generation, for a second Codex opinion.",
    },
    {
        name: "astra",
        alias: "astra",
        effort: "high",
        use: "OpenAI's frontier model, for the most demanding problems. Slower than sol and uses more of the Codex limits.",
    },
    {
        name: "terra",
        alias: "terra",
        effort: "high",
        use: "A fast, efficient model for visual reasoning, computer use, and internal writing, at half sol's price. Prefer sol for complex coding, and opus for user-facing copy.",
    },
    {
        name: "luna",
        alias: "luna",
        effort: "high",
        use: "A fast and affordable model for easy, quick tasks.",
    },
];

const CODEX_PROMPT = [
    "You are a worker subagent of a Claude Code session, running on a Codex model through ai-proxy. The session that spawned you reads only your final message.",
    "",
    "- Do the task in your brief yourself. Never spawn agents or workflows.",
    "- Change files only when the brief asks for changes. Never commit, push or merge unless the brief says so.",
    "- A file the brief names as your output (a report, notes or a patch at a given path) is the brief's deliverable: write it. Claude Code's rule against report files covers reports nobody asked for, and on 2026-10-27 eight review agents stopped as blocked instead of writing the report their brief named.",
    "",
    "Final message: a first line `STATUS: done`, `STATUS: blocked` or `STATUS: failed`, then a short summary, the files you changed, and the checks you ran with their results.",
].join("\n");

const CLAUDE_PROMPT = [
    "You are Claude, called by a Claude Code session whose main loop runs on a Codex model. The session reads only your final message, so keep it short.",
    "",
    "Work the brief to its end. Change files only when the brief asks for changes.",
    "",
    "Final message: a first line `STATUS: done`, `STATUS: blocked` or `STATUS: failed`, then what you found or changed (with file paths), and what the session must decide.",
].join("\n");

function codexWorkerPrompt(codexAccount: string | undefined): string {
    const account = codexAccount ? ` -a ${codexAccount}` : "";

    return [
        "You hand one task to a headless Codex CLI worker and report its result. Do not do the task yourself.",
        "",
        "1. Write the brief you were given, unchanged, to a new file under $TMPDIR.",
        `2. Start the worker: \`${toolCommand("codex spawn")} --name <a short unique name> --prompt-file <that file> --cwd <the folder the brief names, else the current one>${account}\`. Add \`--write allow\` when the brief asks for file changes.`,
        `3. Wait for its turn to end: \`${toolCommand("codex wait")} <name>\`. Exit 0 means it ended; 3 means it stalled, which you report.`,
        `4. Read the result with \`${toolCommand("codex read")} --name <name>\` and take the worker's final message.`,
        `5. Stop the worker: \`${toolCommand("codex stop")} --name <name>\`.`,
        "",
        "Final message: the worker's name, its final message unchanged, and any error from these commands.",
    ].join("\n");
}

/**
 * The note ccx appends to the lead's system prompt. On 2026-10-27 a review loop lead followed its skills to
 * `tools codex spawn --write ask` workers: 833 of its 1,635 wake-ups were worker approvals and messages, and five
 * hours went by. Here the native agents already are Codex, inside the session, with no approvals to relay.
 */
export function leadPrompt(agents: Record<string, SessionAgentDefinition>, settings?: ClaudeSessionsConfig): string {
    const codex = Object.entries(agents)
        .filter(([name, agent]) => agent.model.startsWith("codex/") && name !== "codex-worker")
        .map(([name, agent]) => `${name} (${agent.model.slice("codex/".length)}, effort ${agent.effort ?? "default"})`);

    const lines = [
        "This Claude Code session runs on Codex through ai-proxy.",
        `Its subagents ${codex.join(", ")} are Codex models. When a skill or brief asks for a Codex, Sol, Terra, Luna or Astra worker, start that subagent with the Agent tool (subagent_type, and effort to raise it, for example effort "xhigh"), not \`${toolCommand("codex spawn")}\` or the handoff-to skill.`,
        `A native subagent needs no approvals from you and reports back once, when it finishes. A \`${toolCommand("codex spawn")}\` worker started with --write ask makes you approve its commands one by one.`,
        "Use the codex-worker subagent only when the work must run in the Codex CLI's own sandbox.",
    ];

    if (skillsNudge(settings)) {
        const allowed = settings?.subagents?.skills?.allowed;
        lines.push(
            `Every subagent brief names the skills the subagent should load (or says "no skills"); a subagent loads only those, because each skill it loads costs its context.${allowed?.length ? ` Pick them from: ${allowed.join(", ")}.` : ""}`
        );
    }

    return withSystemNote(lines.join("\n"), settings?.lead?.systemNote);
}

/** The Claude Code id of a Claude model by its catalog alias, with `[1m]` where the model needs the suffix for its 1M window (P5). */
function claudeModelId(alias: string): string | undefined {
    const model = CLAUDE_MODELS.find((item) => item.aliases?.includes(alias));

    if (!model) {
        return undefined;
    }

    return model.supports1m ? `${model.id}[1m]` : model.id;
}

/** The session's subagents: the Codex models of P3, the `codex-worker`, and Opus (and Fable) on the Claude account. */
export function sessionAgents(input: SessionAgentsInput): Record<string, SessionAgentDefinition> {
    const agents: Record<string, SessionAgentDefinition> = {};

    for (const spec of CODEX_AGENTS) {
        const slug = resolveOpenAiSubModel(spec.alias);
        const info = input.codexModel(slug);

        if (info && !info.efforts.includes(spec.effort)) {
            continue;
        }

        const name = info?.displayName ?? slug;
        agents[spec.name] = {
            description: `Codex ${name} at ${spec.effort} effort. ${spec.use} Bills the session's Codex account.`,
            prompt: codexAgentPrompt(input.settings),
            model: `codex/${slug}`,
            effort: spec.effort,
            disallowedTools: ["Agent"],
            ...(info ? { autoCompactWindow: info.window } : {}),
        };
    }

    const lunaSlug = resolveOpenAiSubModel("luna");
    const luna = input.codexModel(lunaSlug);
    agents["codex-worker"] = {
        description: `Hands a task to a headless Codex CLI worker (\`${toolCommand("codex spawn")}\`), waits for it and reports its final message. For long or independent work that should run in the Codex CLI's own sandbox instead of this session.`,
        prompt: codexWorkerPrompt(input.codexAccount),
        model: `codex/${lunaSlug}`,
        effort: "low",
        tools: ["Bash", "Read", "Write"],
        ...(luna ? { autoCompactWindow: luna.window } : {}),
    };

    if (!input.claude) {
        return agents;
    }

    const opus = claudeModelId("opus");

    if (opus) {
        agents.opus = {
            description:
                "Claude Opus at high effort, for work that wants Claude's judgment: a hard design call, root-causing a subtle bug, a careful review, UI and frontend craft, or a second opinion. Bills the session's Claude account.",
            prompt: CLAUDE_PROMPT,
            model: opus,
            effort: "high",
        };
    }

    const fable = input.claude.fable ? claudeModelId("fable") : undefined;

    if (fable) {
        agents.fable = {
            description:
                "Claude Fable at high effort, Anthropic's strongest model, for the hardest reasoning when Opus is not enough. Bills the session's Claude account.",
            prompt: CLAUDE_PROMPT,
            model: fable,
            effort: "high",
        };
    }

    return agents;
}

/** Writer 1: the `--agents` arguments, or none when the user passed `--agents` after `--` (the user's wins). */
export function agentsArgs(passthrough: string[], agents: Record<string, SessionAgentDefinition>): string[] {
    if (passthrough.some((arg) => arg === "--agents" || arg.startsWith("--agents="))) {
        return [];
    }

    return ["--agents", SafeJSON.stringify(agents)];
}

/** Where `tools claude codex --isolated` keeps its own Claude Code config folders. */
export function claudeCodexConfigRoot(): string {
    return genesisToolsDir("claude-codex", "config");
}

function frontmatterValue(value: string | number | string[]): string {
    if (Array.isArray(value)) {
        return value.join(", ");
    }

    return typeof value === "number" ? String(value) : SafeJSON.stringify(value);
}

/**
 * Writer 2: the same definitions as `<configDir>/agents/<name>.md`. Refuses any folder outside
 * `claudeCodexConfigRoot()`, so it never writes into `~/.claude/agents` or a project. Returns the files written.
 */
export function writeAgentFiles(configDir: string, agents: Record<string, SessionAgentDefinition>): string[] {
    const root = claudeCodexConfigRoot();
    const target = resolve(configDir);
    const inside = relative(root, target);

    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(`agent files are written only into a folder under ${root}, not ${target}`);
    }

    const dir = join(target, "agents");
    mkdirSync(dir, { recursive: true });

    return Object.entries(agents).map(([name, agent]) => {
        const fields: Array<[string, string | number | string[] | undefined]> = [
            ["name", name],
            ["description", agent.description],
            ["model", agent.model],
            ["effort", agent.effort],
            ["tools", agent.tools],
            ["disallowedTools", agent.disallowedTools],
            ["autoCompactWindow", agent.autoCompactWindow],
        ];
        const header = fields
            .filter((field): field is [string, string | number | string[]] => field[1] !== undefined)
            .map(([key, value]) => `${key}: ${frontmatterValue(value)}`);
        const file = join(dir, `${name}.md`);
        writeFileSync(file, `---\n${header.join("\n")}\n---\n\n${agent.prompt}\n`);
        return file;
    });
}
