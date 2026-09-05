import type { WorkerBackend } from "./capabilities";

export type WorkerSandbox = "read-only" | "cwd-jail" | "workspace-write" | "none";

export interface WorkerBus {
    /** The worker's identity on the `tools agents` bus. */
    agentName: string;
    leadName: string;
    rendezvousSession: string;
}

export interface WorkerContractInput {
    backend: WorkerBackend;
    sandbox?: WorkerSandbox;
    /** Present when the worker is part of a swarm and must report over the bus. */
    bus?: WorkerBus | null;
    /** Which personal surfaces the worker loaded; on by default for every backend that can honour it. */
    surfaces?: { skills: boolean; rules: boolean };
}

/** The keys every worker's final message carries, in this order. `tools <backend> …` printers read RESULT. */
export const WORKER_REPORT_KEYS = ["RESULT", "AT", "CHANGED", "VERIFY", "OPEN"] as const;

const BACKEND_LABEL: Record<WorkerBackend, string> = {
    codex: "Codex",
    grok: "Grok",
    claude: "Claude Code",
};

function channelLines(input: WorkerContractInput): string[] {
    const label = BACKEND_LABEL[input.backend];
    const bus = input.bus;

    if (bus && input.sandbox === "read-only") {
        // In a read-only sandbox every write is denied — including the agents
        // feed lock — so `tools agents …` calls can only fail with EPERM. The
        // bridge already streams this session's items to the lead, so narration
        // IS the channel.
        return [
            `You are \`${bus.agentName}\`, a headless ${label} worker in a Claude Code agent swarm. The lead agent is \`${bus.leadName}\`.`,
            "Your sandbox is READ-ONLY: do NOT run `tools agents` commands — any write, including the messaging feed, fails with EPERM.",
            "Instead, narrate progress as short standalone assistant messages (one concise line per meaningful step);",
            "the lead automatically receives every message and command you produce through the session event bridge.",
        ];
    }

    if (bus) {
        const sessionFlag = `--session ${bus.rendezvousSession}`;
        return [
            `You are \`${bus.agentName}\`, a headless ${label} worker in a Claude Code agent swarm. The lead agent is \`${bus.leadName}\`.`,
            "Report progress, findings, and questions with:",
            `tools agents message --from ${bus.agentName} --to ${bus.leadName} --body '<text>' ${sessionFlag}`,
            "Check for replies or steering from the lead with:",
            `tools agents login --agent-name ${bus.agentName} --once ${sessionFlag}`,
            "Reply to a specific message with:",
            `tools agents message --from ${bus.agentName} --reply <id> --body '<text>' ${sessionFlag}`,
            "Prefer one concise message per meaningful step.",
            `Your first action is to report in: tools agents message --from ${bus.agentName} --to ${bus.leadName} --body 'received; starting' ${sessionFlag}`,
        ];
    }

    return [
        `You are a headless ${label} worker driven by an orchestrating agent, not by a person at a keyboard.`,
        "Nobody sees your intermediate narration except through the transcript; your FINAL message is the report the orchestrator reads.",
    ];
}

function checkpointLines(): string[] {
    return [
        "You are the receiving end of a handoff. Honor any `Stop and report` block in your task brief literally —",
        "stopping to ask is expected behavior, not a failure. Ask before creating files outside the declared scope,",
        "adding dependencies, changing public interfaces, or running any git commit/push or destructive command.",
        "Run the verification command in your brief yourself and paste its real output; never report a state you did not observe.",
        "If a verification command fails twice in a row, STOP and report both outputs instead of patching further.",
        "Copy every file path from the brief CHARACTER FOR CHARACTER; do not retype or normalize paths.",
    ];
}

function reportShapeLines(): string[] {
    return [
        "End your final message with exactly these five lines, in this order, one per line:",
        "RESULT: <done | stopped-at-checkpoint | blocked | failed>",
        "AT: <the checkpoint or milestone you reached>",
        "CHANGED: <paths you changed, or: nothing>",
        "VERIFY: <the verification command> → <the first line of its real output, or: not run>",
        "OPEN: <questions for the orchestrator, or: none>",
    ];
}

function surfaceLines(input: WorkerContractInput): string[] {
    const surfaces = input.surfaces;
    if (!surfaces || (!surfaces.skills && !surfaces.rules)) {
        return [];
    }

    const loaded = [surfaces.rules ? "rules" : "", surfaces.skills ? "skills" : ""].filter(Boolean).join(" and ");
    return [
        `The user's personal ${loaded} are loaded for reference. Rituals meant for an interactive session (notifications,`,
        "`tools say`, spoken or end-of-turn summaries addressed to a human, asking the user questions) do not apply to you;",
        "the harness handles them. Follow the brief over any rule that conflicts with it.",
    ];
}

/**
 * The one text every headless worker receives from its harness, at spawn and at
 * every steer: who it is and how it reports, the checkpoint contract, the fixed
 * report shape, and how to treat the user's personal surfaces. Codex passes it
 * as `developerInstructions`, grok as `--rules`, claude as `--append-system-prompt`.
 * Briefs no longer restate any of this; they fill in the milestone, the negative
 * constraints and the verify command.
 */
export function buildWorkerContract(input: WorkerContractInput): string {
    return [...channelLines(input), ...checkpointLines(), ...reportShapeLines(), ...surfaceLines(input)].join("\n");
}
