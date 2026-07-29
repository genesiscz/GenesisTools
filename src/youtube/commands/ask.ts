import { loadAskProviderChoice } from "@app/youtube/commands/_shared/ask-provider";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { resolveTargetsToVideoIds } from "@app/youtube/commands/_shared/utils";
import { answerOverVideos, formatCitationLines } from "@app/youtube/lib/ask-answer";
import { resolveAskScope } from "@app/youtube/lib/ask-scope";
import { askInSession, ensureAskSession } from "@app/youtube/lib/ask-session";
import { withConsoleContext } from "@app/youtube/lib/service-user";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * Ask across a set of videos, with optional conversational memory.
 *
 * The three selectors (`--channel`, explicit targets, `--dir`) all funnel through
 * `resolveAskScope`, which imports a directory into the DB rather than growing a
 * second retrieval engine. Answering is `answerOverVideos` in both modes, so a
 * one-shot ask and a session turn cite identically.
 */

interface AskOpts {
    channel?: string;
    dir?: string;
    limit?: number;
    session?: string;
    topK?: number;
    stream?: boolean;
    history?: boolean;
    provider?: string;
    model?: string;
    json?: boolean;
}

export function registerAskCommand(program: Command): void {
    program
        // Question FIRST: commander refuses any argument after a variadic one.
        .command("ask <question> [targets...]")
        .description("Ask a question across videos, a channel, or a transcript directory")
        .option("--channel <handle>", "Ask over every stored video of a channel")
        .option("--dir <path>", "Import a transcript directory, then ask over it")
        .option("--limit <n>", "Cap channel members, newest first", (value) => Number.parseInt(value, 10))
        .option("--session <name>", "Keep conversational memory under this session name")
        .option("--top-k <n>", "Chunks to retrieve", (value) => Number.parseInt(value, 10))
        .option("--stream", "Stream the answer as it is generated")
        .option("--history", "Print the session's prior turns and exit")
        .option("--provider <name>", "Provider override")
        .option("--model <id>", "Model override")
        .option("--json", "Machine-readable output")
        .action(async (question: string, targets: string[], opts: AskOpts, cmd: Command) => {
            const yt = await getYoutube();

            await withConsoleContext(yt.db, async (user) => {
                if (opts.history) {
                    if (!opts.session) {
                        out.error("--history needs --session <name>.");
                        process.exitCode = 1;
                        return;
                    }

                    const existing = yt.db.getAskSessionByTitle(user.id, opts.session);

                    if (!existing) {
                        out.error(`No session named "${opts.session}".`);
                        process.exitCode = 1;
                        return;
                    }

                    const messages = yt.db.listAskSessionMessages(existing.id);
                    const text = messages
                        .filter((message) => message.role === "user" || message.role === "assistant")
                        .map((message) => `${pc.dim(message.role.padEnd(9))} ${message.content}`)
                        .join("\n\n");

                    await renderOrEmit({ text, json: messages, flags: cmd.optsWithGlobals() });
                    return;
                }

                const providerChoice = await loadAskProviderChoice({ provider: opts.provider, model: opts.model });
                const scopeInput = {
                    ...(opts.channel ? { channel: opts.channel } : {}),
                    ...(opts.dir ? { dir: opts.dir } : {}),
                    ...(targets.length > 0 ? { videoIds: await resolveTargetsToVideoIds(yt, targets) } : {}),
                    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
                };

                const streamTarget = opts.stream ? process.stdout : undefined;

                const result = opts.session
                    ? await askInSession({
                          yt,
                          question,
                          providerChoice,
                          topK: opts.topK,
                          streaming: opts.stream,
                          streamTarget,
                          session: (
                              await ensureAskSession({
                                  yt,
                                  userId: user.id,
                                  name: opts.session,
                                  scope: scopeInput,
                                  providerSpec: opts.provider ?? null,
                              })
                          ).session,
                      })
                    : await answerOverVideos({
                          yt,
                          question,
                          providerChoice,
                          topK: opts.topK,
                          streaming: opts.stream,
                          streamTarget,
                          videoIds: (await resolveAskScope(yt, scopeInput)).videoIds,
                      });

                const citations = formatCitationLines(result.citations).join("\n");
                const notes: string[] = [];

                if (result.missingTranscript.length > 0) {
                    notes.push(pc.yellow(`${result.missingTranscript.length} video(s) have no transcript yet`));
                }

                if (result.skippedUnindexed.length > 0) {
                    notes.push(pc.yellow(`${result.skippedUnindexed.length} left unindexed by the index budget`));
                }

                await renderOrEmit({
                    // Streaming already wrote the answer to stdout, so repeating it
                    // here would print it twice.
                    text: [opts.stream ? "" : result.answer, pc.dim("Citations:"), citations, ...notes]
                        .filter(Boolean)
                        .join("\n"),
                    json: result,
                    flags: cmd.optsWithGlobals(),
                });
            });
        });
}
