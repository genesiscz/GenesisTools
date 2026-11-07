import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { openProject } from "../lib/edit";
import { privateData, waits } from "../lib/fx-analysis";

const { log } = logger.scoped("recorder-fx-analysis");

const clock = (seconds: number): string => new Date(Math.round(seconds * 1000)).toISOString().slice(14, 21);

function fail(error: unknown, what: string): void {
    log.debug({ error }, `${what} failed`);
    out.printlnErr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

/**
 * The two list commands behind the `hidePrivate` and `speedUpWaits` ops (fx B, round 4): they list, and
 * `tools recorder apply` applies what they listed, by id or all.
 */
export function registerFxAnalysisCommands(program: Command): void {
    program
        .command("private-data")
        .description(
            "List the private data on a recording's screen (emails, tokens and keys, phone numbers, IBANs, card numbers), read with Vision OCR on this Mac; hide them with the hidePrivate op"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--json", "print JSON")
        .action(async (value: string, flags: { json?: boolean }) => {
            try {
                const hits = await privateData((await openProject(value)).project);

                if (flags.json) {
                    out.result(hits);
                    return;
                }

                for (const hit of hits) {
                    out.println(
                        `${hit.id}  ${clock(hit.from)}-${clock(hit.to)}  ${hit.label.padEnd(13)} ${hit.masked}${hit.hidden ? "  (hidden)" : ""}${hit.plays === null ? "  (cut)" : ""}`
                    );
                }

                if (hits.length === 0) {
                    out.printlnErr("No private data on the screen.");
                    return;
                }

                out.printlnErr(
                    `Hide them all: ${toolCommand("recorder apply")} ${value} '{"op":"hidePrivate"}' (or "ids":[…] for some)`
                );
            } catch (error) {
                fail(error, "private-data");
            }
        });

    program
        .command("waits")
        .description(
            "List the typing and waiting stretches of a recording (only a small part of the picture changes, or nothing) with a proposed 4x to 8x speed-up; apply them with the speedUpWaits op"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--min-seconds <n>", "the shortest stretch", "4")
        .option("--max-area <share>", "the largest share of the picture that may change per quarter second", "0.06")
        .option("--json", "print JSON")
        .action(async (value: string, flags: { minSeconds?: string; maxArea?: string; json?: boolean }) => {
            try {
                const minSeconds = Number(flags.minSeconds ?? 4);
                const maxArea = Number(flags.maxArea ?? 0.06);

                if (!(minSeconds >= 1 && minSeconds <= 600) || !(maxArea >= 0 && maxArea <= 0.5)) {
                    throw new Error("--min-seconds takes 1 to 600 and --max-area 0 to 0.5");
                }

                const found = await waits((await openProject(value)).project, { minSeconds, maxArea });

                if (flags.json) {
                    out.result(found);
                    return;
                }

                for (const wait of found) {
                    out.println(
                        `${wait.id}  ${clock(wait.from)}-${clock(wait.to)}  ${wait.kind.padEnd(6)} ${String(wait.seconds).padStart(6)} s at ${wait.speed}x saves ${wait.saves} s`
                    );
                }

                if (found.length === 0) {
                    out.printlnErr("No typing or waiting stretch that long.");
                    return;
                }

                out.printlnErr(
                    `Speed them all up: ${toolCommand("recorder apply")} ${value} '{"op":"speedUpWaits","minSeconds":${minSeconds},"maxArea":${maxArea}}'`
                );
            } catch (error) {
                fail(error, "waits");
            }
        });
}
