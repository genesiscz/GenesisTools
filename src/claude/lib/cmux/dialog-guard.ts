import { openDialogFor } from "@genesiscz/utils/agents/dialogs/guard";
import type { DialogProvider, OpenDialog } from "@genesiscz/utils/agents/dialogs/types";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { logger } from "@genesiscz/utils/logger";
import { isTestProcess } from "@genesiscz/utils/test-process";

const { log } = logger.scoped("cmux-dialog-guard");

/**
 * Is a question, plan or permission dialog open in this session right now? State signals only, never a screen read
 * (handoff h_ppczhri1): the hook records first, then the transcript's turn state (`openDialogFor`).
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

    for (const owner of providers) {
        try {
            const dialog = openDialogFor({ provider: owner, sessionId, transcriptPath: transcript?.filePath });

            if (dialog) {
                return dialog;
            }
        } catch (error) {
            // Only a session id the record store refuses gets here, and no hook can have written a record for it.
            log.warn({ error, sessionId, provider: owner }, "the dialog guard could not read this session");
        }
    }

    return null;
}
