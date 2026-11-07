import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { openProject } from "../lib/edit";
import { findText, type PrivateHitOut, privateData, verifyHidden, waits } from "../lib/fx-analysis";

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
        .option("--names <list>", "people or company names to find as well, comma-separated")
        .option("--exclude-fixed", "leave out what stays still while the content scrolls (a toast, a tab bar)")
        .option("--json", "print JSON")
        .action(async (value: string, flags: { names?: string; excludeFixed?: boolean; json?: boolean }) => {
            try {
                const hits = await privateData((await openProject(value)).project, {
                    names: flags.names?.split(",").map((name) => name.trim()),
                    excludeFixed: flags.excludeFixed,
                });

                if (flags.json) {
                    out.result(hits);
                    return;
                }

                for (const hit of hits) {
                    out.println(hitLine(hit));
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

/** One hit as a line: id, source span, label, the masked value and what it is now. */
function hitLine(hit: PrivateHitOut): string {
    const notes = [hit.moves ? "moves" : "", hit.hidden ? "hidden" : "", hit.plays === null ? "cut" : ""].filter(
        Boolean
    );
    return `${hit.id}  ${clock(hit.from)}-${clock(hit.to)}  ${hit.label.padEnd(13)} ${hit.masked}${notes.length ? `  (${notes.join(", ")})` : ""}`;
}

/** `tools recorder find-text` and `verify-hidden`: find a text by OCR, and check that the output hides it. */
export function registerHideTextCommands(program: Command): void {
    program
        .command("find-text")
        .description(
            "Every place a text (or --pattern, a regular expression) shows on a recording's screen, tracked through scrolls; hide them with the hideText op"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .argument("[text]", "the words to find, without case")
        .option("--pattern <regex>", "a regular expression instead of the text")
        .option("--exclude-fixed", "leave out what stays still while the content scrolls")
        .option("--json", "print JSON")
        .action(
            async (
                value: string,
                text: string | undefined,
                flags: { pattern?: string; excludeFixed?: boolean; json?: boolean }
            ) => {
                try {
                    const hits = await findText((await openProject(value)).project, {
                        text,
                        pattern: flags.pattern,
                        excludeFixed: flags.excludeFixed,
                    });

                    if (flags.json) {
                        out.result(hits);
                        return;
                    }

                    for (const hit of hits) {
                        out.println(hitLine(hit));
                    }

                    if (hits.length === 0) {
                        out.printlnErr("The screen never shows it.");
                    }
                } catch (error) {
                    fail(error, "find-text");
                }
            }
        );

    program
        .command("verify-hidden")
        .description(
            "Export the edit (or read --movie), OCR its frames and list every output moment where a text, a pattern or the private data is still readable; exit 1 on a leak"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--text <text>", "the words that must not be readable")
        .option("--pattern <regex>", "a regular expression that must not match")
        .option("--private", "the private data (the default without --text or --pattern)")
        .option("--names <list>", "with --private: names too, comma-separated")
        .option("--every <seconds>", "seconds between the frames read", "0.25")
        .option("--movie <file>", "an export already made, instead of exporting again")
        .option("--json", "print JSON")
        .action(
            async (
                value: string,
                flags: {
                    text?: string;
                    pattern?: string;
                    private?: boolean;
                    names?: string;
                    every?: string;
                    movie?: string;
                    json?: boolean;
                }
            ) => {
                try {
                    const answer = await verifyHidden(value, {
                        text: flags.text,
                        pattern: flags.pattern,
                        private: flags.private,
                        names: flags.names?.split(",").map((name) => name.trim()),
                        everySeconds: Number(flags.every ?? 0.25),
                        movie: flags.movie,
                    });

                    if (flags.json) {
                        out.result(answer);
                    } else {
                        for (const leak of answer.leaks) {
                            out.println(
                                `leak  ${clock(leak.at)}-${clock(leak.until)}  ${leak.label.padEnd(13)} ${leak.masked}`
                            );
                        }

                        out.printlnErr(
                            answer.ok
                                ? `Nothing readable in ${answer.frames} frames of ${answer.movie}.`
                                : `${answer.leaks.length} leak(s) in ${answer.movie}.`
                        );
                    }

                    if (!answer.ok) {
                        process.exitCode = 1;
                    }
                } catch (error) {
                    fail(error, "verify-hidden");
                }
            }
        );
}
