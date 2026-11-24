import { outputAgentInstructions } from "@genesiscz/utils/ai/agent-instructions";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { shellWord } from "@genesiscz/utils/shell/quote";
import type { Command } from "commander";
import { withMeetingsClient } from "../lib/service/client";
import { TOOL } from "../lib/shared";

export function registerAcousticCommands(program: Command): void {
    const acoustic = program
        .command("acoustic")
        .description("Offline channel evidence and retained raw/cleaned previews");
    acoustic
        .command("collect <meeting>")
        .description("Explicitly collect acoustic echo evidence; originals remain read-only")
        .action(async (meeting: string) => {
            out.result(
                SafeJSON.stringify(
                    await withMeetingsClient((client) =>
                        client.call("acoustic.collect", { meeting }, { timeoutMs: 300_000 })
                    )
                )
            );
        });
    for (const name of ["inspect", "clip"] as const) {
        acoustic
            .command(`${name} <meeting>`)
            .requiredOption("--from <seconds>", "Start in source seconds", Number)
            .requiredOption("--to <seconds>", "End in source seconds", Number)
            .action(async (meeting: string, opts: { from: number; to: number }) => {
                if (!Number.isFinite(opts.from) || opts.from < 0 || !Number.isFinite(opts.to) || opts.to <= opts.from) {
                    throw new Error("Invalid acoustic interval");
                }
                const args = { meeting, fromSec: opts.from, toSec: opts.to };
                out.result(
                    SafeJSON.stringify(
                        await withMeetingsClient((client) =>
                            client.call(name === "clip" ? "acoustic.clip" : "acoustic.inspect", args)
                        )
                    )
                );
            });
    }
}

/** The old voice subcommands remain on the canonical voices tree, including its voice alias. */
export function registerLegacyVoiceCommands(voice: Command): void {
    voice
        .command("collect <meeting>")
        .description("Explicitly collect identity evidence from enrolled voices")
        .action(async (meeting: string) => {
            out.result(
                SafeJSON.stringify(
                    await withMeetingsClient((client) =>
                        client.call("voice.collect", { meeting }, { timeoutMs: 3_600_000 })
                    )
                )
            );
        });
    voice
        .command("prepare")
        .description("Explicitly download the canonical public speaker model")
        .action(async () => {
            out.result(
                SafeJSON.stringify(
                    await withMeetingsClient((client) =>
                        client.call("voice.prepare", { download: true }, { timeoutMs: 300_000 })
                    )
                )
            );
        });
    for (const name of ["enroll", "score"] as const) {
        const command = voice
            .command(`${name} <meeting>`)
            .requiredOption("--from <seconds>", "Start", Number)
            .requiredOption("--to <seconds>", "End", Number)
            .requiredOption("--channel <0|1>", "Physical source channel", Number);
        if (name === "enroll") {
            command
                .requiredOption("--person <name>", "Confirmed speaker name")
                .option(
                    "--confirmed",
                    "Assert single-speaker identity was confirmed; for an agent, the user confirms it in a window"
                );
        }
        command.action(
            async (
                meeting: string,
                opts: {
                    from: number;
                    to: number;
                    channel: number;
                    person?: string;
                    confirmed?: boolean;
                    json?: boolean;
                }
            ) => {
                const channel = opts.channel;
                if (channel !== 0 && channel !== 1) {
                    throw new Error("Channel must be 0 or 1");
                }

                const person = opts.person;
                if (!person) {
                    out.result(
                        SafeJSON.stringify(
                            await withMeetingsClient((client) =>
                                client.call("voice.score", { meeting, fromSec: opts.from, toSec: opts.to, channel })
                            )
                        )
                    );
                    return;
                }

                // The decision journal and the person door load only for an enrolment, not for every acoustic read.
                const [{ callerActor }, { confirmVoiceSample }] = await Promise.all([
                    import("../lib/decision-journal"),
                    import("../lib/person-door"),
                ]);
                const confirmation = await confirmVoiceSample({
                    actor: callerActor(),
                    confirmed: opts.confirmed === true,
                    ask: () => {
                        const record = new MeetingStore().resolve(meeting);
                        if (!record) {
                            throw new Error(`No meeting "${meeting}".`);
                        }
                        const rerun = [
                            `${TOOL} voices enroll ${shellWord(record.id)} --from ${opts.from} --to ${opts.to}`,
                            `--channel ${channel} --person ${shellWord(person)} --confirmed`,
                        ].join(" ");
                        return { record, fromSec: opts.from, toSec: opts.to, person, channel, rerun };
                    },
                });
                if (!confirmation.confirmed) {
                    outputAgentInstructions(confirmation.instructions, { json: opts.json === true });
                    process.exitCode = 1;
                    return;
                }

                logger.debug({ meeting, person, confirmedBy: confirmation.by }, "voices enroll: confirmed sample");
                out.result(
                    SafeJSON.stringify(
                        await withMeetingsClient((client) =>
                            client.call("voice.enroll", {
                                meeting: confirmation.record?.id ?? meeting,
                                fromSec: opts.from,
                                toSec: opts.to,
                                channel,
                                person,
                                confirmed: true,
                            })
                        )
                    )
                );
            }
        );
    }
}
