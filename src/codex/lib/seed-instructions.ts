export function buildAgentInstructions(options: {
    agentName: string;
    rendezvousSession: string;
    leadName: string;
    sandbox?: string;
}): string {
    // In a read-only sandbox every write is denied — including the agents
    // feed lock — so `tools agents …` calls can only fail with EPERM. The
    // bridge already streams this session's items (assistant messages,
    // commands, file changes) to the lead, so narration IS the channel.
    if (options.sandbox === "read-only") {
        return [
            `You are \`${options.agentName}\`, a member of a Claude Code agent swarm. The lead agent is \`${options.leadName}\`.`,
            "Your sandbox is READ-ONLY: do NOT run `tools agents` commands — any write, including the messaging feed, fails with EPERM.",
            "Instead, narrate progress as short standalone assistant messages (one concise line per meaningful step);",
            "the lead automatically receives every message and command you produce through the session event bridge.",
        ].join("\n");
    }

    const sessionFlag = `--session ${options.rendezvousSession}`;

    return [
        `You are \`${options.agentName}\`, a member of a Claude Code agent swarm. The lead agent is \`${options.leadName}\`.`,
        "Report progress, findings, and questions with:",
        `tools agents message --from ${options.agentName} --to ${options.leadName} --body '<text>' ${sessionFlag}`,
        "Check for replies or steering from the lead with:",
        `tools agents login --agent-name ${options.agentName} --once ${sessionFlag}`,
        "Reply to a specific message with:",
        `tools agents message --from ${options.agentName} --reply <id> --body '<text>' ${sessionFlag}`,
        "Prefer one concise message per meaningful step.",
    ].join("\n");
}
