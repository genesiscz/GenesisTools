import { readFileSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { eventAnchorSchema, MOVIE_EVENT_KINDS, type Tap, tapSchema } from "@genesiscz/utils/recording-editor/events";
import type { Command } from "commander";
import { z } from "zod";
import { openProject } from "../lib/edit";
import {
    eventsOf,
    eventsOut,
    findText,
    type PrivateHitOut,
    privateData,
    snapOf,
    verifyHidden,
    waits,
} from "../lib/fx-analysis";

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

    program
        .command("events")
        .description(
            "List what happens on a recording's screen at source seconds: scene changes, scrolls, still stretches, clicks, and taps from --taps; place effects on them with snap"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--kinds <list>", `only these kinds, comma-separated: ${MOVIE_EVENT_KINDS.join(", ")}`)
        .option("--taps <file>", "a JSON file of taps [{ at, x?, y? }] for a movie without a cursor track")
        .option("--json", "print JSON")
        .action(async (value: string, flags: { kinds?: string; taps?: string; json?: boolean }) => {
            try {
                const { project } = await openProject(value);
                const kinds = flags.kinds
                    ? z.array(z.enum(MOVIE_EVENT_KINDS)).parse(flags.kinds.split(","))
                    : undefined;
                const all = eventsOut(project, await eventsOf(project, { taps: readTaps(flags.taps) }));
                const events = kinds ? all.filter((event) => kinds.includes(event.kind)) : all;

                if (flags.json) {
                    out.result(events);
                    return;
                }

                for (const event of events) {
                    const span = event.to === undefined ? clock(event.at) : `${clock(event.at)}-${clock(event.to)}`;
                    const detail = event.shift === undefined ? "" : ` shift ${event.shift}`;
                    out.println(`${event.kind.padEnd(6)} ${String(event.index).padStart(3)}  ${span}${detail}`);
                }
            } catch (error) {
                fail(error, "events");
            }
        });

    program
        .command("snap")
        .description(
            "A source time on screen: --at <s> moves to the nearest event, --event <kind> --index <n> [--lead <s>] [--end] names one"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--at <seconds>", "a guessed source second")
        .option("--event <kind>", MOVIE_EVENT_KINDS.join(" | "))
        .option("--index <n>", "1 is the first, -1 the last", "1")
        .option("--lead <seconds>", "move the time by this much (-0.2: before it)")
        .option("--end", "a stretch's end instead of its start")
        .option("--kinds <list>", "with --at: only these kinds")
        .option("--taps <file>", "a JSON file of taps [{ at, x?, y? }]")
        .action(
            async (
                value: string,
                flags: {
                    at?: string;
                    event?: string;
                    index?: string;
                    lead?: string;
                    end?: boolean;
                    kinds?: string;
                    taps?: string;
                }
            ) => {
                try {
                    const { project } = await openProject(value);
                    const anchor = flags.event
                        ? eventAnchorSchema.parse({
                              event: flags.event,
                              index: Number(flags.index ?? 1),
                              ...(flags.lead === undefined ? {} : { lead: Number(flags.lead) }),
                              ...(flags.end ? { end: true } : {}),
                          })
                        : undefined;
                    const kinds = flags.kinds
                        ? z.array(z.enum(MOVIE_EVENT_KINDS)).parse(flags.kinds.split(","))
                        : undefined;
                    out.result(
                        await snapOf(project, {
                            at: flags.at === undefined ? undefined : Number(flags.at),
                            anchor,
                            kinds,
                            taps: readTaps(flags.taps),
                        })
                    );
                } catch (error) {
                    fail(error, "snap");
                }
            }
        );
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
        .argument("[texts...]", "the words to find, without case (several: one scan finds them all)")
        .option("--pattern <regex>", "a regular expression instead of the text (repeat it for several)", collect, [])
        .option("--exclude-fixed", "leave out what stays still while the content scrolls")
        .option("--line", "each place covers the whole OCR line of the match (a name and the number beside it)")
        .option("--json", "print JSON")
        .action(
            async (
                value: string,
                texts: string[],
                flags: { pattern: string[]; excludeFixed?: boolean; line?: boolean; json?: boolean }
            ) => {
                try {
                    const hits = await findText((await openProject(value)).project, {
                        texts,
                        patterns: flags.pattern,
                        excludeFixed: flags.excludeFixed,
                        unit: flags.line ? "line" : "match",
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
        .option("--text <text>", "the words that must not be readable (repeat it for several)", collect, [])
        .option("--pattern <regex>", "a regular expression that must not match (repeat it for several)", collect, [])
        .option("--private", "the private data (the default without --text or --pattern)")
        .option("--names <list>", "with --private: names too, comma-separated")
        .option("--every <seconds>", "seconds between the frames read", "0.25")
        .option("--movie <file>", "an export already made, instead of exporting again")
        .option("--json", "print JSON")
        .action(
            async (
                value: string,
                flags: {
                    text: string[];
                    pattern: string[];
                    private?: boolean;
                    names?: string;
                    every?: string;
                    movie?: string;
                    json?: boolean;
                }
            ) => {
                try {
                    const answer = await verifyHidden(value, {
                        texts: flags.text,
                        patterns: flags.pattern,
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

/** A repeatable option's values, in the order given. */
function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/** A taps file: `[{ at, x?, y? }]` in source seconds and picture fractions. */
function readTaps(path: string | undefined): Tap[] | undefined {
    return path ? z.array(tapSchema).parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true })) : undefined;
}
