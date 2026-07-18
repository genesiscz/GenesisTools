export function buildAgentInstructions(options: {
    agentName: string;
    rendezvousSession: string;
    leadName: string;
}): string {
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
