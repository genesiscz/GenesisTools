import { toolCommand } from "@genesiscz/utils/cli/tool-command";
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

/**
 * How mail reaches the worker. A codex worker's daemon delivers every message addressed to it as turn input
 * (merged into a running turn, or a new turn when idle), so a model-side `login --once` only blocked the turn and
 * received the same mail twice; one held the identity's slot for 3+ minutes on 2026-10-13. Other backends still
 * receive through `login --once`.
 */
function receiveLines(backend: WorkerBackend, bus: WorkerBus, sessionFlag: string): string[] {
    if (backend === "codex") {
        return [
            `Mail addressed to you arrives by itself as input that starts with \`[Bus message from <sender> #<id>. Reply with: ...]\`: inside your running turn, or as a new turn when you are idle. Never run \`${toolCommand("agents login")}\` or \`${toolCommand("agents request")}\`: they block your turn and receive that mail a second time.`,
            "At a checkpoint where you must wait for the lead, send your message and END your turn; the reply starts your next turn.",
        ];
    }

    return [
        "Check for replies or steering from the lead with:",
        `${toolCommand("agents login")} --agent-name ${bus.agentName} --once ${sessionFlag}`,
    ];
}

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
            `Your sandbox is READ-ONLY: do NOT run \`${toolCommand("agents")}\` commands — any write, including the messaging feed, fails with EPERM.`,
            "Instead, narrate progress as short standalone assistant messages (one concise line per meaningful step);",
            "the lead automatically receives every message and command you produce through the session event bridge.",
        ];
    }

    if (bus) {
        const sessionFlag = `--session ${bus.rendezvousSession}`;
        return [
            `You are \`${bus.agentName}\`, a headless ${label} worker in a Claude Code agent swarm. The lead agent is \`${bus.leadName}\`.`,
            `If you are a subagent that another agent of this worker started, these bus lines are not yours: never run \`${toolCommand("agents")}\` as \`${bus.agentName}\` (it is refused), and report to the agent that started you.`,
            "Report progress, findings, and questions with:",
            `${toolCommand("agents message")} --from ${bus.agentName} --to ${bus.leadName} --body '<text>' ${sessionFlag}`,
            ...receiveLines(input.backend, bus, sessionFlag),
            "Reply to a specific message with:",
            `${toolCommand("agents message")} --from ${bus.agentName} --reply <id> --body '<text>' ${sessionFlag}`,
            "Prefer one concise message per meaningful step.",
            `Your first action is to report in: ${toolCommand("agents message")} --from ${bus.agentName} --to ${bus.leadName} --body 'received; starting' ${sessionFlag}`,
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

/**
 * A codex sandbox denies watchman's state directory (`~/.local/state/watchman`), so Jest failed before any test on
 * its `fchmod` (2026-10-13). The flag, not a writable root: that directory also holds watchman triggers, which run
 * commands outside the sandbox, so making it writable would let a worker escape.
 */
function sandboxLines(input: WorkerContractInput): string[] {
    if (input.backend !== "codex" || input.sandbox === "none") {
        return [];
    }

    return [
        "Run Jest with `--watchman=false`: your sandbox blocks watchman's state directory, and Jest then fails before any test runs.",
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
        `\`${toolCommand("say")}\`, spoken or end-of-turn summaries addressed to a human, asking the user questions) do not apply to you;`,
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
    return [
        ...channelLines(input),
        ...checkpointLines(),
        ...sandboxLines(input),
        ...reportShapeLines(),
        ...surfaceLines(input),
    ].join("\n");
}
