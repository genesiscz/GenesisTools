import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { withMeetingsClient } from "../lib/service/client";

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
    const voice = program.command("voice").description("Confirmed enrolment and local CAM++ speaker scoring");
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
                .requiredOption("--confirmed", "Assert single-speaker identity was confirmed");
        }
        command.action(
            async (meeting: string, opts: { from: number; to: number; channel: number; person?: string }) => {
                const channel = opts.channel;
                if (channel !== 0 && channel !== 1) {
                    throw new Error("Channel must be 0 or 1");
                }

                out.result(
                    SafeJSON.stringify(
                        await withMeetingsClient((client) =>
                            opts.person
                                ? client.call("voice.enroll", {
                                      meeting,
                                      fromSec: opts.from,
                                      toSec: opts.to,
                                      channel,
                                      person: opts.person,
                                      confirmed: true,
                                  })
                                : client.call("voice.score", { meeting, fromSec: opts.from, toSec: opts.to, channel })
                        )
                    )
                );
            }
        );
    }
}
