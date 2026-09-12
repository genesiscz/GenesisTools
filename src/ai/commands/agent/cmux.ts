import { type FocusOptions, focusCommand } from "@app/claude/commands/cmux/focus";
import { type SendOptions, sendCommand } from "@app/claude/commands/cmux/send";
import { aliasesForSession, matchingSession, type SessionFocusRecord } from "@app/claude/lib/cmux/focus";
import type { ResolveDeps } from "@app/claude/lib/cmux/resolve";
import { openHistoryService } from "@genesiscz/utils/agent-sessions/open-service";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import type { AgentToolSpec } from "./spec";

const { log } = logger.scoped("agent-cmux");

/**
 * `tools <agent> cmux focus|send`: reach the pane a session of THIS agent runs in.
 *
 * The pane lookup was never Claude-specific. `record-session-cmux.ts` is a shared plugin hook,
 * so a Codex session already writes its surface into the same journal, and the resolver reads
 * that journal by session id — `tools claude cmux focus <codex-thread-id>` resolved a real
 * pane at full confidence before this command existed. The only Claude-shaped part was the
 * fallback that searches session TITLES, which read Claude's history index; `ResolveDeps`
 * already declares that as an injection point, so this supplies the right index per agent.
 *
 * ⚠️ Grok writes nothing to that journal yet, so a `tools grok cmux focus` falls back to the
 * title and pane-text matchers rather than the recorded shortcut.
 */

/** This agent's sessions in the shape the pane matcher wants. */
async function lookupAgentSession(
    alias: AccountProviderAlias,
    query: string
): Promise<{ aliases: string[]; sessionId: string | null; cwd: string | null }> {
    try {
        const service = openHistoryService({ provider: PROVIDER_ALIASES[alias] });
        const { metadata } = await service.catalog({ excludeAgents: true });
        const sessions: SessionFocusRecord[] = metadata.map((record) => ({
            sessionId: record.sessionId,
            customTitle: record.customTitle,
            summary: record.summary,
            firstPrompt: record.firstPrompt,
        }));
        const hit = matchingSession(query, sessions);
        const full = hit?.sessionId ? metadata.find((record) => record.sessionId === hit.sessionId) : undefined;

        return {
            aliases: aliasesForSession(query, sessions),
            sessionId: hit?.sessionId ?? null,
            cwd: full?.cwd ?? null,
        };
    } catch (err) {
        // The recorded-refs shortcut does not need this, so an unreadable index costs the
        // title fallback rather than the whole command.
        log.debug({ err, alias, query }, "this agent's history index is unavailable; searching panes only");
        return { aliases: [], sessionId: null, cwd: null };
    }
}

export function registerAgentCmuxCommand(program: Command, spec: AgentToolSpec): Command {
    const deps: ResolveDeps = { lookupSession: (query) => lookupAgentSession(spec.alias, query) };
    const cmux = program
        .command("cmux")
        .description(`Find and drive the cmux pane a ${spec.alias} session is already open in`);

    cmux.command("focus <session>")
        .description("Focus the cmux pane a session is already open in, and raise the app")
        .option("--no-activate", "Focus the pane without bringing the cmux app to the front")
        .option("--first", "Take the best match instead of asking when several panes match")
        .option("--include-self", "Also consider the pane this command runs in (excluded by default)")
        .option("--dry-run", "Print what would be focused and stop")
        .option("--json", "Emit the match as JSON instead of a status line")
        .action(async (session: string, options: FocusOptions) => {
            await focusCommand(session, options, deps);
        });

    cmux.command("send <session> <text>")
        .description("Type text into the cmux pane a session is running in, then press Enter")
        .option("--first", "Take the best match instead of failing when several panes match")
        .option("--include-self", "Also consider the pane this command runs in (excluded by default)")
        .option("--no-enter", "Send the text only, leave it unsubmitted at the prompt")
        .option("--enter-delay <ms>", "Wait this long between the text and Enter", "500")
        .option("--dry-run", "Print what would receive the text and stop")
        .option("--json", "Emit the outcome as JSON instead of a status line")
        .action(async (session: string, text: string, options: SendOptions) => {
            await sendCommand(session, text, options, deps);
        });

    return cmux;
}
