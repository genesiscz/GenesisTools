import { asResult } from "@genesiscz/utils/cli/result";
import { hoursArg, limitArg } from "../../commands/agents-args";
import { parseArgv, stringFlag } from "../argv";
import { type CallDoor, failed, ok } from "./types";

/** A flag value the CLI's own parser accepts, or null (the process then prints the CLI's error). */
function parsedOrNull<T>(value: string | undefined, parse: (raw: string) => T): T | undefined | null {
    if (value === undefined) {
        return undefined;
    }

    try {
        return parse(value);
    } catch {
        return null;
    }
}

interface TreeArgs {
    hours?: number;
    limit?: number;
    session?: string;
    agent?: string;
}

/** `hub agents --json [--session s] [--since d] [--limit n] [--agent id]`: the Agents mode's tree, or one agent. */
export const agentsTreeDoor: CallDoor<TreeArgs> = {
    kind: "call",
    name: "hub agents --json",
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "agents"],
            positionals: 0,
            flags: {
                "--json": "bool",
                "--session": "value",
                "--since": "value",
                "--limit": "value",
                "--agent": "value",
            },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        const hours = parsedOrNull(stringFlag(parsed, "--since"), hoursArg);
        const limit = parsedOrNull(stringFlag(parsed, "--limit"), limitArg);
        if (hours === null || limit === null) {
            return null;
        }

        return { hours, limit, session: stringFlag(parsed, "--session"), agent: stringFlag(parsed, "--agent") };
    },
    async run(args, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const agents = await import("../../lib/agents/index");
            if (args.agent) {
                const detail = await agents.hubAgent({ ...args, agent: args.agent });
                if (!detail) {
                    const where = args.session ? ` under session ${args.session}` : " in the window";
                    return { stdout: "", stderr: `No agent ${args.agent}${where}\n`, exit: 1 };
                }

                return ok(asResult(detail));
            }

            return ok(asResult(await agents.hubAgents(args)));
        } catch (error) {
            return failed(error);
        }
    },
};

interface CountsArgs {
    session: string;
    ids: string[];
}

/** `hub agents counts --session s --ids a,b --json`: the 5 s refresh of running rows. */
export const agentsCountsDoor: CallDoor<CountsArgs> = {
    kind: "call",
    name: "hub agents counts",
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "agents", "counts"],
            positionals: 0,
            flags: { "--json": "bool", "--session": "value", "--ids": "value" },
        });
        const session = parsed ? stringFlag(parsed, "--session") : undefined;
        const ids = (parsed ? (stringFlag(parsed, "--ids") ?? "") : "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
        if (parsed?.flags.get("--json") !== true || !session || ids.length === 0) {
            return null;
        }

        return { session, ids };
    },
    async run(args, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const { agentCounts } = await import("../../lib/agents/counts");
            return ok(asResult(await agentCounts(args)));
        } catch (error) {
            return failed(error);
        }
    },
};

interface MailArgs {
    session: string;
    agent: string;
}

/** `hub agents mail --session s --agent a --json`: one teammate's mail. */
export const agentsMailDoor: CallDoor<MailArgs> = {
    kind: "call",
    name: "hub agents mail",
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "agents", "mail"],
            positionals: 0,
            flags: { "--json": "bool", "--session": "value", "--agent": "value" },
        });
        const session = parsed ? stringFlag(parsed, "--session") : undefined;
        const agent = parsed ? stringFlag(parsed, "--agent") : undefined;
        if (parsed?.flags.get("--json") !== true || !session || !agent) {
            return null;
        }

        return { session, agent };
    },
    async run(args, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const { agentMail } = await import("../../lib/agents/mail");
            return ok(asResult(await agentMail(args)));
        } catch (error) {
            return failed(error);
        }
    },
};

/** `ai sessions subagents <id> --json`: one session's sub-agents (the session detail's list). */
export const subagentsDoor: CallDoor<string> = {
    kind: "call",
    name: "ai sessions subagents --json",
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["ai", "sessions", "subagents"],
            positionals: 1,
            flags: { "--json": "bool" },
        });
        return parsed?.flags.get("--json") === true ? parsed.positionals[0] : null;
    },
    async run(sessionId, { signal }) {
        try {
            // A cancel that arrived before the work started stops it here.
            signal.throwIfAborted();
            const { resolveTranscript } = await import("@genesiscz/utils/ai/transcripts/resolve");
            const { listSubagents } = await import("@genesiscz/utils/ai/transcripts/subagents");
            return ok(asResult(listSubagents(await resolveTranscript(sessionId, {}))));
        } catch (error) {
            return failed(error);
        }
    },
};
