import { deliverMessage, MessageError } from "@app/ai/lib/agent-message/delivery";
import type { TurnProvider } from "@genesiscz/utils/ai/transcripts/turn-state";
import type { PeerPriority } from "@genesiscz/utils/claude/peer-message";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseWaitFlags, UsageError, waitCommand } from "./wait";

/**
 * `tools <agent> message <session> <text>`: the CLI adapter over `@app/ai/lib/agent-message/delivery`, which
 * resolves the session and delivers through the agent's own structured channel. This file parses flags,
 * hands off to `--wait`, and renders the result.
 */

interface MessageFlags {
    priority?: string;
    first?: boolean;
    allowKeystrokes?: boolean;
    json?: boolean;
    wait?: boolean;
    waitTimeout?: string;
    stallTimeout?: string;
    stream?: boolean;
    last?: string;
    tools?: boolean;
    quiet?: boolean;
}

async function readText(parts: string[]): Promise<string> {
    if (parts.length === 1 && parts[0] === "-") {
        return (await new Response(Bun.stdin.stream()).text()).trim();
    }

    return parts.join(" ").trim();
}

const PRIORITIES: readonly PeerPriority[] = ["now", "next", "later"];

export async function messageCommand(alias: TurnProvider, query: string, parts: string[], flags: MessageFlags) {
    const text = await readText(parts);

    if (!text) {
        out.error(`nothing to send: tools ${alias} message <session> <text> (or - to read stdin)`);
        process.exitCode = 2;
        return;
    }

    if (flags.priority !== undefined && !PRIORITIES.some((priority) => priority === flags.priority)) {
        out.error(`--priority must be one of ${PRIORITIES.join(", ")} (got ${flags.priority})`);
        process.exitCode = 2;
        return;
    }

    const priority = PRIORITIES.find((value) => value === flags.priority);

    // Delivery cannot be undone, so the wait flags are checked first: a retry after a typo would send twice.
    if (flags.wait) {
        try {
            parseWaitFlags(
                { timeout: flags.waitTimeout, stallTimeout: flags.stallTimeout, last: flags.last },
                { timeoutFlag: "--wait-timeout" }
            );
        } catch (error) {
            if (!(error instanceof UsageError)) {
                throw error;
            }

            out.error(`${error.message}; nothing was sent`);
            process.exitCode = 2;
            return;
        }
    }

    const sentAt = Date.now();

    try {
        const delivery = await deliverMessage({
            alias,
            request: { query, text, priority, first: flags.first },
            allowKeystrokes: flags.allowKeystrokes === true,
        });
        const sentLine = `sent to ${alias} ${delivery.sessionId}${delivery.name ? ` (${delivery.name})` : ""} via ${delivery.via}; ${delivery.note}`;

        if (flags.wait) {
            // The wait owns stdout from here: the reply is the result, the send line is status.
            if (!flags.json) {
                out.printlnErr(sentLine);
            }

            await waitCommand(alias, delivery.sessionId, {
                timeout: flags.waitTimeout,
                stallTimeout: flags.stallTimeout,
                next: true,
                stream: flags.stream,
                json: flags.json,
                last: flags.last,
                tools: flags.tools,
                quiet: flags.quiet,
                sentAt,
                embed: { delivery },
            });
            return;
        }

        if (flags.json) {
            out.result(delivery);
        } else {
            out.println(sentLine);
        }
    } catch (error) {
        if (error instanceof MessageError) {
            out.error(error.message);

            for (const line of error.suggestions) {
                out.error(`  ${line}`);
            }
        } else {
            out.error(error instanceof Error ? error.message : String(error));
        }

        process.exitCode = 1;
    }

    await out.flush();
}

export function registerAgentMessageCommand(program: Command, alias: TurnProvider): Command {
    return program
        .command("message <session> [text...]")
        .description(
            `Send a message into a RUNNING ${alias} session through the agent's own channel, not by typing into its terminal`
        )
        .option("--priority <now|next|later>", "Claude: when the session handles it (default: its own queue order)")
        .option("--first", "When a /rename title matches several sessions, take the newest instead of failing")
        .option(
            "--allow-keystrokes",
            "When the agent has no structured channel (Grok, a Codex TUI without the shared app-server), paste into its cmux tab with cmux paste --submit"
        )
        .option("--json", "Print {agent,sessionId,name,via,note}; with --wait, the wait report with a delivery field")
        .option(
            "--wait",
            "After sending, wait for the turn that answers it and print the reply (exit codes as in wait)"
        )
        .option("--wait-timeout <seconds>", "With --wait: give up after this long (exit 124)")
        .option(
            "--stall-timeout <seconds>",
            "With --wait: a silent transcript this long is a stall (exit 3; 0 = never)"
        )
        .option("--stream", "With --wait: print the reply as it is written")
        .option("--last <n>", "With --wait: print the last N assistant messages, not only the final one")
        .option("--tools", "With --wait: also list the tool calls of the answering turn")
        .option("--quiet", "With --wait: status line and exit code only")
        .addHelpText(
            "after",
            `
<session> is a session id (8+ characters is enough), a session name, a /rename title, or part of the
cmux tab or workspace title the session runs in ("vybava" finds the tab "vybava - grok").
<text> is the message; pass - to read it from stdin.

Channels:
  claude  its cross-session socket (~/.claude/sessions/<pid>.json -> /tmp/cc-socks/<pid>.sock).
          A busy session reads it between tool calls; an idle one starts a turn. The receiving
          Claude sees it as a message from another session (advice, not the user's own words), and a
          session in bypass mode holds it for approval unless its crossSessionInbound setting is accept.
  codex   codex queue on the shared app-server; runs after the current turn. Needs a TUI attached to
          that server (started with --remote or the default daemon).
  grok    no structured channel: the TUI listens on no socket. --allow-keystrokes pastes into its cmux
          tab instead (cmux paste --submit refuses over a draft or an open dialog).

Not the agents bus: \`${toolCommand("agents message")}\` sends to agents logged into a bus session.`
        )
        .action(async (session: string, parts: string[], flags: MessageFlags) => {
            await messageCommand(alias, session, parts, flags);
        });
}
