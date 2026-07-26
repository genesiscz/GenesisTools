export type StageStatus = "ready" | "planned";

export interface StageInfo {
    name: string;
    status: StageStatus;
    description: string;
    example: string;
}

/** Pipeline stages, in order. Every stage runs separately; nothing forces the full pipeline. */
export const STAGES: StageInfo[] = [
    {
        name: "bootstrap",
        status: "ready",
        description: "Check/create ~/.genesis-tools/claude/fable/config.json (asks where the pack repo lives).",
        example: "tools learn-from-fable bootstrap",
    },
    {
        name: "stats",
        status: "ready",
        description:
            "Corpus census + mined/unmined state + last mined session + per-project breakdown (default command).",
        example: "tools learn-from-fable stats",
    },
    {
        name: "list",
        status: "ready",
        description: "Selection details for unmined sessions: age, size, project, branch, first prompt. Oldest first.",
        example: "tools learn-from-fable list --limit 10 --details",
    },
    {
        name: "select",
        status: "ready",
        description: "Machine-readable selection (paths only) for piping into mine.",
        example: "tools learn-from-fable select --limit 5",
    },
    {
        name: "pre-mine",
        status: "ready",
        description:
            "Deterministic parse + condensed windows for chosen sessions (fable turns only, sidechains excluded); no model calls.",
        example: "tools learn-from-fable pre-mine --limit 5 --max-windows 6",
    },
    {
        name: "mine",
        status: "ready",
        description:
            "Decision-point episodes + principle candidates via ai-proxy (model pickable; results kept per model).",
        example: "tools learn-from-fable mine --limit 5 --model grok-4.5 --max-windows 6",
    },
    {
        name: "filter",
        status: "ready",
        description: "Contrastive filter: keep episodes where the reference scores high AND a bare model scores low.",
        example: "tools learn-from-fable filter --filter-bare-model sonnet-5 --filter-reference-model opus",
    },
    {
        name: "pre-score",
        status: "ready",
        description:
            "Rank unmined sessions by expected teachable-episode density before spending mining calls (late-stage addition).",
        example: "tools learn-from-fable pre-score --model grok-4.5",
    },
    {
        name: "consolidate",
        status: "ready",
        description:
            "Hand ALL unconsolidated principles to several models; each votes useful/useless with % confidence; rounds parameterized.",
        example: "tools learn-from-fable consolidate --models fable,opus,grok-4.5 --rounds 3",
    },
    {
        name: "self-review",
        status: "ready",
        description:
            "Instruct-stage for a live Fable session: audit the spec (incl. growth control) while Fable is still served.",
        example: "tools learn-from-fable self-review",
    },
    {
        name: "skill",
        status: "ready",
        description:
            "Regenerate fable-style SKILL.md from the spec; line budget is a parameter, then sync to ~/.claude/skills/.",
        example: "tools learn-from-fable skill --max-lines 220",
    },
    {
        name: "eval",
        status: "ready",
        description:
            "A/B eval: bare model vs model+skill (skill injected into context) on held-out episodes, via ai-proxy.",
        example: "tools learn-from-fable eval --model sonnet-5 --judge-model opus",
    },
    {
        name: "hooks",
        status: "ready",
        description:
            "Instruct-stage: prints pack data + instructions for the running LLM to propose deterministic hooks.",
        example: "tools learn-from-fable hooks",
    },
];
