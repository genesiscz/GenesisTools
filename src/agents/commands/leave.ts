import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { deriveRegistry, findByName } from "../lib/derived-registry";
import { FriendlyError, runWithFriendlyErrors } from "../lib/errors";
import { readFeed } from "../lib/feed";
import { announceLeave } from "../lib/leave";
import { sessionPaths } from "../lib/paths";
import { resolveSession } from "../lib/session-resolve";

interface LeaveOpts {
    agentName?: string;
    session?: string;
    note?: string;
}

async function runLeaveImpl(opts: LeaveOpts): Promise<void> {
    if (!opts.agentName) {
        throw new FriendlyError("--agent-name is required", "tools agents leave --agent-name <me> --session <s>");
    }

    const paths = sessionPaths(resolveSession(opts.session).session);
    const record = findByName(deriveRegistry(await readFeed(paths)), opts.agentName);

    if (!record) {
        throw new FriendlyError(`no agent named "${opts.agentName}" in session "${paths.session}"`);
    }

    const event = await announceLeave(paths, {
        agent_id: record.agent_id,
        agent_name: record.agent_name,
        reason: "leave",
        ...(opts.note ? { note: opts.note } : {}),
    });
    const remaining = event.type === "agent_left" ? event.remaining : [];
    out.result({ left: record.agent_name, session: paths.session, remaining });
    await out.flush();
}

export function registerLeaveCommand(program: Command): void {
    program
        .command("leave")
        .description(
            "Announce that an agent stops listening; every other agent gets agent_left with the agents still on the bus"
        )
        .option("--agent-name <name>", "The agent that leaves")
        .option("--session <id>", "Override session resolution")
        .option("--note <text>", "One line for the others, e.g. a status")
        .action(async (opts: LeaveOpts) => {
            await runWithFriendlyErrors(() => runLeaveImpl(opts));
        });
}
