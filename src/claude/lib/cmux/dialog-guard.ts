import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { openDialogFor } from "@genesiscz/utils/agents/dialogs/guard";
import type { DialogProvider, OpenDialog } from "@genesiscz/utils/agents/dialogs/types";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { type ClaudeLiveSession, listClaudeSessionInventory } from "@genesiscz/utils/claude/peer-message";
import { logger } from "@genesiscz/utils/logger";
import { isTestProcess } from "@genesiscz/utils/test-process";

const { log } = logger.scoped("cmux-dialog-guard");

/**
 * Claude Code's own registry entry (`<config dir>/sessions/<pid>.json`) says `status: "waiting"` with `waitingFor:
 * "input needed"` while a question dialog is open, and `idle` or `busy` otherwise (observed live on 2.1.312,
 * 2026-10-30). It is the one signal that sees an open `AskUserQuestion` before it is answered: Claude Code writes the
 * assistant record that holds the tool call only after the tool returns, so the transcript's turn state cannot. The
 * entry does not say which dialog it is, so the kind stays `decision`. `turn-state` is the closest source name: the
 * entry is Claude's own turn state, and `OpenQuestionSource` has no registry member yet.
 */
export function claudeRegistryDialog(
    sessionId: string,
    sessions: () => ClaudeLiveSession[] = () => listClaudeSessionInventory()
): OpenDialog | null {
    const waiting = sessions().some(
        (session) => session.sessionId === sessionId && session.status === "waiting" && !session.parkedJobId
    );

    return waiting ? { kind: "decision", question: null, signal: "turn-state" } : null;
}

/**
 * Is a question, plan or permission dialog open in this session right now? State signals only, never a screen read
 * (handoff h_ppczhri1): the hook records first, then the transcript's turn state (`openDialogFor`), then, for a
 * Claude session, Claude Code's own registry entry (`claudeRegistryDialog`).
 *
 * Every path that types into a pane asks this first: `tools claude cmux send` and the typed rung of
 * `deliverToSession`. Without a provider the resolved transcript names it; a session whose transcript is not found
 * still gets every harness's hook records, so a recorded permission prompt blocks the typing either way. A test
 * process reads the records only, because the transcript folders are the real home and the test sandbox covers only
 * `~/.genesis-tools`.
 */
export async function sessionOpenDialog({
    sessionId,
    provider,
}: {
    sessionId: string;
    provider?: DialogProvider;
}): Promise<OpenDialog | null> {
    let transcript: ResolvedTranscript | undefined;

    if (!isTestProcess()) {
        try {
            transcript = await resolveTranscript(sessionId, {}, provider);
        } catch (error) {
            log.debug({ error, sessionId, provider }, "no transcript for the dialog guard; hook records only");
        }
    }

    const providers: readonly DialogProvider[] = provider
        ? [provider]
        : transcript
          ? [transcript.provider]
          : ACCOUNT_PROVIDER_ALIASES;

    // An unreadable registry is unknown, not evidence that the session exited.
    const sessionAlive =
        transcript?.source === "native"
            ? resolveHistoryProvider(transcript.provider).reader.dialog.sessionAlive(transcript.filePath, sessionId)
            : null;

    for (const owner of providers) {
        try {
            const dialog = openDialogFor({
                provider: owner,
                sessionId,
                transcriptPath: transcript?.filePath,
                sessionAlive,
            });

            if (dialog) {
                return dialog;
            }
        } catch (error) {
            // Only a session id the record store refuses gets here, and no hook can have written a record for it.
            log.warn({ error, sessionId, provider: owner }, "the dialog guard could not read this session");
        }
    }

    // The registry is this Mac's live processes, which a test must not read.
    if (providers.includes("claude") && !isTestProcess()) {
        return claudeRegistryDialog(sessionId);
    }

    return null;
}
