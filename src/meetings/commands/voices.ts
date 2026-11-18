import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable } from "@genesiscz/utils/table";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { callerActor } from "../lib/decision-journal";
import { fail } from "../lib/shared";
import { backfillVoices } from "../lib/voice-backfill";
import {
    addVoiceSample,
    applyVoices,
    listProjectVoices,
    planVoiceRemoval,
    previewVoices,
    removeVoice,
    voiceSample,
} from "../lib/voices";
import { registerLegacyVoiceCommands } from "./acoustic";
import { playSoundSlice } from "./play";

interface VoiceOptions {
    project?: string;
    json?: boolean;
    sample?: string;
    player?: string;
    start?: boolean;
}

function sampleNumber(value?: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const sample = Number(value);
    if (!Number.isInteger(sample) || sample < 1) {
        throw new Error("--sample needs a positive sample number from voices --json.");
    }
    return sample;
}

async function projectFor(options: VoiceOptions, person: string): Promise<string> {
    if (options.project) {
        return options.project;
    }
    const projects = [
        ...new Set(
            (await listProjectVoices({ store: new MeetingStore() })).people
                .filter((row) => row.person === person && row.samples.length)
                .map((row) => row.project)
        ),
    ];
    if (projects.length !== 1) {
        throw new Error("Give --project <name> to choose this person's voice store.");
    }
    return projects[0]!;
}

function guarded(work: () => Promise<void>): Promise<void> {
    return work().catch((error: unknown) => fail(error));
}

export function registerVoicesCommand(program: Command): void {
    const voices = program
        .command("voices")
        .alias("voice")
        .description("Project voice samples and suggested speaker names, kept on this Mac")
        .option("--project <name>", "project voice store; absent lists every project")
        .option("--json", "print structured people, samples and meetings")
        .action((opts: VoiceOptions) =>
            guarded(async () => {
                const result = await listProjectVoices({ store: new MeetingStore(), project: opts.project });
                if (opts.json) {
                    out.result(SafeJSON.stringify(result));
                    return;
                }
                const table = createBoxTable([
                    "PROJECT",
                    "PERSON",
                    "SAMPLE",
                    "MEETING",
                    "SEAT / TRACK",
                    "TIME",
                    "WORDS",
                ]);
                for (const person of result.people) {
                    if (!person.samples.length) {
                        table.push([
                            person.project,
                            person.person,
                            "No sample yet",
                            person.meetings.length,
                            "",
                            "",
                            "",
                        ]);
                    }
                    for (const sample of person.samples) {
                        table.push([
                            person.project,
                            person.person,
                            sample.sample,
                            sample.meeting,
                            `${sample.seat} / ${sample.track}`,
                            `${formatClock(sample.fromSec)}–${formatClock(sample.toSec)}`,
                            sample.words || (sample.available ? "" : "Source unavailable"),
                        ]);
                    }
                }
                out.println(table.toString());
            })
        );

    voices
        .command("backfill [meetings...]")
        .description("Recover project samples from the meeting journal's human speaker decisions")
        .option("--project <name>", "process all meetings in this project")
        .option("--dry-run", "count recoverable samples without writing")
        .option("--json", "print per-meeting and per-person counts")
        .action((meetings: string[], opts: VoiceOptions & { dryRun?: boolean }) =>
            guarded(async () => {
                const flags = { ...voices.opts<VoiceOptions>(), ...opts };
                const result = await backfillVoices({
                    store: new MeetingStore(),
                    meetings,
                    project: flags.project,
                    dryRun: flags.dryRun,
                });
                if (flags.json) {
                    out.result(SafeJSON.stringify(result));
                    return;
                }
                const table = createBoxTable([
                    "MEETING",
                    "PERSON",
                    result.dryRun ? "WOULD ADD" : "SAMPLES ADDED",
                    "SKIPPED AS PRESENT",
                    "SKIPPED (WHY)",
                ]);
                for (const row of result.rows) {
                    table.push([
                        row.meeting,
                        row.person ?? "—",
                        row.added,
                        row.present,
                        Object.entries(row.skipped)
                            .map(([why, count]) => `${count} × ${why}`)
                            .join(", "),
                    ]);
                }
                out.println(table.toString());
                ui.info(
                    `${result.dryRun ? "Would add" : "Added"} ${result.added} samples. ${result.present} already present.`
                );
            })
        );

    for (const name of ["preview", "apply"] as const) {
        voices
            .command(`${name} <meeting>`)
            .description(
                name === "preview"
                    ? "Read voice proposals, scores, current names and refusal reasons; saves nothing"
                    : "Run the meeting's speaker suggestion pass; confirms no name"
            )
            .option("--json", "print the structured result")
            .action((meeting: string, opts: VoiceOptions) =>
                guarded(async () => {
                    const result = await (name === "preview" ? previewVoices : applyVoices)({
                        store: new MeetingStore(),
                        meeting,
                    });
                    if (opts.json || voices.opts<VoiceOptions>().json) {
                        out.result(SafeJSON.stringify(result));
                        return;
                    }
                    if ("lines" in result) {
                        for (const line of result.lines) {
                            const score =
                                line.score === undefined
                                    ? ""
                                    : ` ${line.reason === "exclusion" ? "confidence" : "by voice"} ${line.score.toFixed(2)}`;
                            const margin = line.margin === undefined ? "" : `, margin ${line.margin.toFixed(2)}`;
                            out.println(
                                `${formatClock(line.fromSec)}–${formatClock(line.toSec)} ${line.current} → ${line.person ?? "unnamed"}${score} [${line.reason}${margin}]${line.next ? `; next ${line.next.person} ${line.next.score.toFixed(2)}` : ""}: ${line.text}`
                            );
                        }
                        ui.info(`${result.lines.length} voice proposals; nothing saved.`);
                    } else {
                        ui.ok(`${result.added} speaker suggestions added.`);
                        for (const warning of result.warnings) {
                            ui.warn(warning);
                        }
                    }
                })
            );
    }

    voices
        .command("play <person>")
        .description("Listen to a confirmed sample at its original rate; saves nothing")
        .option("--sample <number>", "sample number from voices; default 1")
        .option("--player [id]", "Moment player: afplay, vlc, ffplay")
        .option("--no-start", "resolve the sample without starting a player")
        .option("--json", "print the resolved track and file seconds")
        .action((person: string, opts: VoiceOptions) =>
            guarded(async () => {
                const project = await projectFor({ ...voices.opts(), ...opts }, person);
                const slice = await voiceSample({
                    store: new MeetingStore(),
                    project,
                    person,
                    sample: sampleNumber(opts.sample),
                });
                if (opts.start !== false) {
                    await playSoundSlice({ slice, player: opts.player });
                }
                opts.json || voices.opts<VoiceOptions>().json
                    ? out.result(SafeJSON.stringify(slice))
                    : ui.ok(
                          `${opts.start === false ? "Would play" : "Played"} sample on ${slice.track}, ${formatClock(slice.fromSec)}–${formatClock(slice.toSec)} at source rate.`
                      );
            })
        );

    voices
        .command("remove <person>")
        .description("Show which suggested lines lose this voice name, then remove samples")
        .option("--sample <number>", "remove this sample only; absent removes all of the person's samples")
        .option("--json", "print the removal and affected items")
        .action((person: string, opts: VoiceOptions) =>
            guarded(async () => {
                const project = await projectFor({ ...voices.opts(), ...opts }, person);
                const request = { store: new MeetingStore(), project, person, sample: sampleNumber(opts.sample) };
                const plan = planVoiceRemoval(request);
                for (const row of plan.affected) {
                    ui.info(
                        `${row.meeting} ${row.item} ${formatClock(row.fromSec)}–${formatClock(row.toSec)} loses its voice suggestion.`
                    );
                }
                const result = await removeVoice(request);
                opts.json || voices.opts<VoiceOptions>().json
                    ? out.result(SafeJSON.stringify(result))
                    : ui.ok(`Removed ${result.removed} samples; retired ${result.affected.length} voice suggestions.`);
            })
        );

    voices
        .command("add <meeting>")
        .description("Add complete lines as samples after confirming this speaker by ear")
        .requiredOption("--from <time>", "first transcript second or clock")
        .requiredOption("--to <time>", "last transcript second or clock")
        .requiredOption("--person <name>", "speaker confirmed by ear")
        .requiredOption("--confirmed", "assert this interval is the named speaker alone")
        .option("--json", "print the number of samples saved")
        .action(
            (meeting: string, opts: VoiceOptions & { from: string; to: string; person: string; confirmed: boolean }) =>
                guarded(async () => {
                    if (callerActor().kind === "agent") {
                        throw new Error("Only a person who listened can confirm a new voice sample.");
                    }
                    const result = await addVoiceSample({
                        store: new MeetingStore(),
                        meeting,
                        fromSec: parseClock(opts.from) ?? NaN,
                        toSec: parseClock(opts.to) ?? NaN,
                        person: opts.person,
                        confirmed: opts.confirmed,
                    });
                    opts.json || voices.opts<VoiceOptions>().json
                        ? out.result(SafeJSON.stringify(result))
                        : ui.ok(`Saved ${result.samples} confirmed voice samples.`);
                })
        );
    registerLegacyVoiceCommands(voices);
}
