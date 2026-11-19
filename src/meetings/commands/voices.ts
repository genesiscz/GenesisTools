import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { idSchema, ownerKey, readVoiceLibrary, voicesIn } from "@genesiscz/utils/meetings/voice-library";
import { createBoxTable } from "@genesiscz/utils/table";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { Command } from "commander";
import { callerActor } from "../lib/decision-journal";
import { type MeetingsParams, type MeetingsResult, voicesReject } from "../lib/service/api";
import { withMeetingsClient } from "../lib/service/client";
import { fail, resolveEnum } from "../lib/shared";
import { playSoundSlice } from "../lib/sound-playback";
import { addVoiceSample, applyVoices, previewVoices } from "../lib/voices";
import { registerLegacyVoiceCommands } from "./acoustic";
import { parsePerson } from "./projects";

interface VoiceOptions {
    project?: string;
    meeting?: string;
    all?: boolean;
    person?: string;
    json?: boolean;
    sample?: string;
    player?: string;
    start?: boolean;
    preview?: boolean;
    planToken?: string;
}

function oneSelection(value: string, previous?: string): string {
    if (previous !== undefined && previous !== value) {
        throw new Error("Conflicting voice selectors. Choose one value for each option.");
    }
    return value;
}

function scoped(command: Command): Command {
    return command
        .option("--project <name>", "samples from this project", oneSelection)
        .option("--meeting <id>", "samples from this meeting", oneSelection)
        .option("--all", "samples from all projects");
}

function browseScope(opts: VoiceOptions): MeetingsParams<"voices.list"> {
    const scopes = [opts.project, opts.meeting, opts.all].filter((value) => value !== undefined);
    if (scopes.length > 1) {
        throw new Error("Choose one voice scope: --project, --meeting or --all.");
    }
    if (opts.project !== undefined) {
        return { project: opts.project };
    }
    if (opts.meeting !== undefined) {
        return { scope: { kind: "meeting", meeting: opts.meeting } };
    }
    return opts.all ? { scope: { kind: "all" } } : {};
}

function stableId(value: string) {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error("--sample needs a vs_ sample ID from voices samples.");
    }
    return parsed.data;
}

function selection(person: string, opts: VoiceOptions): MeetingsParams<"voices.sample"> {
    const scope = browseScope(opts);
    if (opts.sample?.startsWith("vs_")) {
        return { ...scope, person, id: stableId(opts.sample) };
    }
    let sample: number | undefined;
    if (opts.sample !== undefined) {
        sample = Number(opts.sample);
        if (!/^\d+$/.test(opts.sample) || !Number.isSafeInteger(sample) || sample < 1) {
            throw new Error("--sample needs a vs_ ID or a positive decimal sample number.");
        }
    }
    if (scope.scope || scope.project !== undefined) {
        return { ...scope, person, sample };
    }
    // An old command may omit its project only when its samples identify a single project.
    const groups = voicesIn(readVoiceLibrary(), { kind: "all" }).filter(
        (row) => sameName(row.owner.name, person) || row.samples.some((s) => sameName(s.owner.name, person))
    );
    const projects = new Set(groups.flatMap((row) => row.projects));
    if (groups.length !== 1 || projects.size !== 1) {
        throw new Error("Give --project <name> or a stable sample ID to choose this person's samples.");
    }
    return { project: [...projects][0]!, person, sample };
}

function moveDestination(text: string) {
    const owner = parsePerson(text);
    if (owner.email) {
        return { name: owner.name, email: owner.email };
    }
    const view = readVoiceLibrary();
    const matches = new Map(
        [...view.knownOwners, ...view.library.samples.map((s) => s.owner)]
            .filter((ref) => sameName(ref.name, owner.name))
            .map((ref) => [ownerKey(ref), ref] as const)
    );
    if (matches.size > 1) {
        throw new Error('Ambiguous destination. Use --to "Name <email>" to choose the person.');
    }
    return matches.values().next().value ?? { name: owner.name };
}

async function listPeople(opts: VoiceOptions) {
    const result = await withMeetingsClient((client) =>
        client.call("voices.list", { ...browseScope(opts), person: opts.person })
    );
    if (opts.json) {
        out.result(SafeJSON.stringify(result));
        return;
    }
    const quality = new Map(result.learnt.flatMap((group) => group.samples.map((s) => [s.id, s] as const)));
    const table = createBoxTable(["PERSON / PROJECT", "SAMPLE / SOURCE", "RECORDING", "QUALITY"]);
    for (const row of result.people) {
        const owner = row.owner.email ? `${row.person} <${row.owner.email}>` : row.person;
        if (!row.samples.length) {
            table.push([[owner, ...row.projects].join("\n"), "No sample yet", row.meetings.join("\n"), ""]);
        }
        for (const sample of row.samples) {
            const score = quality.get(sample.id);
            table.push([
                `${owner}\n${sample.project}`,
                [
                    opts.project ? `#${sample.sample}  ${sample.id}` : sample.id,
                    `${sample.origin} / ${sample.acquiredBy}${sample.transferred ? " (moved)" : ""}`,
                    sample.meeting,
                    sample.title,
                    sample.words,
                ]
                    .filter(Boolean)
                    .join("\n"),
                [
                    `${sample.seat} / ${sample.track}`,
                    `${formatClock(sample.fromSec)}–${formatClock(sample.toSec)}`,
                    `Source: ${sample.source.rootMeeting}`,
                    sample.available ? "Available" : "Unavailable",
                ].join("\n"),
                score?.score == null
                    ? (score?.reason ?? "Unavailable")
                    : `${score.score.toFixed(2)}${score.outlier ? " (outlier)" : ""}`,
            ]);
        }
    }
    out.println(table.toString());
    for (const conflict of result.conflicts) {
        ui.warn(`${conflict.project}: ${conflict.message}`);
    }
}

function printCorrection(result: MeetingsResult<"voices.move">, json?: boolean) {
    if (json) {
        out.result(SafeJSON.stringify(result));
    }
    if ("reason" in result) {
        ui.err(result.reason);
        process.exitCode = 1;
    } else if (!json) {
        out.println(`${result.status}: ${result.ids.join(", ")}\nCorrection token: ${result.token}`);
    }
}

function guarded(work: () => Promise<void>): Promise<void> {
    return work().catch((error: unknown) => fail(error));
}

export function registerVoicesCommand(program: Command): void {
    const voices = scoped(program.command("voices").alias("voice").enablePositionalOptions())
        .description("Browse confirmed voice samples and correct the library kept on this Mac")
        .option("--person <name>", "show this person's samples")
        .option("--json", "print structured people, samples and meetings")
        .action((opts: VoiceOptions) => guarded(() => listPeople(opts)));

    const flags = (opts: VoiceOptions) => ({ ...voices.opts<VoiceOptions>(), ...opts });
    voices.hook("preAction", (_parent, action) => {
        if (action === voices) {
            return;
        }
        for (const key of ["all", "meeting", "project", "person"] as const) {
            const value = voices.opts<VoiceOptions>()[key];
            if (value === undefined) {
                continue;
            }
            if (!action.options.some((option) => option.attributeName() === key)) {
                throw new Error(`--${key} does not select the target of voices ${action.name()}.`);
            }
            if (action.opts()[key] !== undefined && action.opts()[key] !== value) {
                throw new Error(`Conflicting --${key} values.`);
            }
        }
    });

    scoped(voices.command("samples <person>"))
        .description("Show the person's confirmed samples and their stable IDs")
        .option("--json", "print people, samples and learnt voices")
        .action((person: string, opts: VoiceOptions) => guarded(() => listPeople({ ...flags(opts), person })));

    scoped(voices.command("quality"))
        .description("Show independent sample counts, similarity and possible outliers")
        .option("--person <name>", "show this person's learnt voices")
        .option("--json", "print the quality groups and individual sample scores")
        .action((opts: VoiceOptions) =>
            guarded(async () => {
                const options = flags(opts);
                const result = await withMeetingsClient((c) =>
                    c.call("voices.quality", { ...browseScope(options), person: options.person })
                );
                if (options.json) {
                    out.result(SafeJSON.stringify(result));
                    return;
                }
                const table = createBoxTable([
                    "PERSON / TRACK",
                    "MODEL",
                    "INDEPENDENT / TOTAL",
                    "MEAN COSINE",
                    "SAMPLE QUALITY",
                ]);
                for (const group of result.learnt) {
                    table.push([
                        [group.owner.name, group.owner.email, group.seat, group.track].filter(Boolean).join("\n"),
                        `${group.model} (${group.dimension})`,
                        `${group.independent} / ${group.count}`,
                        group.meanCosine?.toFixed(2) ?? "Insufficient evidence",
                        group.samples
                            .map((s) => `${s.id}: ${s.score?.toFixed(2) ?? s.reason}${s.outlier ? " (outlier)" : ""}`)
                            .join("\n"),
                    ]);
                }
                out.println(table.toString());
            })
        );

    const jobs = voices
        .command("jobs")
        .description("List current and recent voice learning jobs")
        .option("--project <name>", "show jobs for one project")
        .option("--json", "print all job fields")
        .action((opts: VoiceOptions) =>
            guarded(async () => {
                const options = flags(opts);
                const rows = await withMeetingsClient((c) => c.call("voices.jobs", { project: options.project }));
                if (options.json) {
                    out.result(SafeJSON.stringify(rows));
                    return;
                }
                const table = createBoxTable(["ID", "PROJECT / MEETING", "STATE", "PROGRESS", "ADDED", "SKIPPED"]);
                for (const row of rows) {
                    table.push([
                        row.id,
                        [row.project, row.meeting].filter(Boolean).join("\n"),
                        row.state,
                        `${row.progress.done}/${row.progress.total} ${row.error ?? row.progress.step}`,
                        row.added,
                        row.skipped,
                    ]);
                }
                out.println(rows.length ? table.toString() : "No voice jobs.");
            })
        );
    jobs.command("cancel <id>")
        .description("Cancel a queued or running voice job")
        .option("--json", "print the job or null for an unknown id")
        .action((id: string, opts: VoiceOptions) =>
            guarded(async () => {
                const row = await withMeetingsClient((c) => c.call("voices.jobs.cancel", { id }));
                if (opts.json || jobs.opts<VoiceOptions>().json || voices.opts<VoiceOptions>().json) {
                    out.result(SafeJSON.stringify(row));
                } else {
                    out.println(row ? `${row.id}: ${row.state}` : `No voice job "${id}".`);
                }
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
                const result = await withMeetingsClient((client) =>
                    client.call(
                        "voice.backfill",
                        {
                            meetings: meetings.length ? meetings : undefined,
                            project: flags.project,
                            dryRun: flags.dryRun,
                        },
                        { timeoutMs: 3_600_000 }
                    )
                );
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
        .option("--project <name>", "project for a numbered sample or to narrow an ID", oneSelection)
        .option("--sample <id|number>", "stable sample ID or project sample number; default 1", oneSelection)
        .option("--player [id]", "Moment player: afplay, vlc, ffplay")
        .option("--no-start", "resolve the sample without starting a player")
        .option("--json", "print the resolved track and file seconds")
        .action((person: string, opts: VoiceOptions) =>
            guarded(async () => {
                const request = selection(person, flags(opts));
                const slice = await withMeetingsClient((c) => c.call("voices.sample", request));
                if (opts.start !== false) {
                    await playSoundSlice({ slice, player: opts.player });
                }
                if (flags(opts).json) {
                    out.result(SafeJSON.stringify(slice));
                    return;
                }
                out.println(
                    `${opts.start === false ? "Would play" : "Played"} ${slice.meeting} ${slice.track} ${formatClock(slice.fromSec)}–${formatClock(slice.toSec)}\n${slice.path} (${slice.fileFromSec}–${slice.fileToSec}s${slice.channel === undefined ? "" : `, channel ${slice.channel}`})`
                );
            })
        );

    voices
        .command("remove <person>")
        .description("Forget selected samples and retire the affected suggestions")
        .option("--project <name>", "project for the removal", oneSelection)
        .option("--all", "preview and confirm a bulk removal across projects")
        .option("--sample <id|number>", "remove one stable ID or project sample number", oneSelection)
        .option("--preview", "show the affected sample IDs, suggestions and plan token without saving")
        .option("--plan-token <token>", "apply exactly the removal shown by this preview")
        .option("--json", "print the removal and affected items")
        .action((person: string, opts: VoiceOptions) =>
            guarded(async () => {
                const options = flags(opts);
                const request = selection(person, options);
                if (opts.planToken !== undefined && (!opts.planToken.trim() || opts.preview)) {
                    throw new Error("Use --preview to get a plan, then --plan-token <token> to apply it.");
                }
                const result = await withMeetingsClient(async (client) => {
                    if (opts.preview || opts.planToken) {
                        return client.call("voices.remove", {
                            ...request,
                            preview: opts.preview,
                            planToken: opts.planToken,
                        });
                    }
                    if (request.scope?.kind === "all" && !request.id) {
                        throw new Error("Use --preview, then --plan-token to remove samples across all projects.");
                    }
                    const plan = await client.call("voices.remove", { ...request, preview: true });
                    if (!plan.removed) {
                        return plan;
                    }
                    if (!plan.planToken) {
                        throw new Error("The removal preview did not return a plan token.");
                    }
                    return client.call("voices.remove", { ...request, planToken: plan.planToken });
                });
                if (options.json) {
                    out.result(SafeJSON.stringify(result));
                    return;
                }
                for (const row of result.affected) {
                    out.println(
                        `${row.meeting} ${row.item} ${formatClock(row.fromSec)}–${formatClock(row.toSec)} loses its voice suggestion.`
                    );
                }
                out.println(
                    `${opts.preview ? "Would remove" : "Removed"} ${result.removed} samples: ${result.ids?.join(", ") ?? ""}`
                );
                if (opts.preview && result.planToken) {
                    out.println(`Plan token: ${result.planToken}`);
                } else if (result.token) {
                    out.println(`Correction token: ${result.token}`);
                }
            })
        );

    voices
        .command("move <person>")
        .description("Move a confirmed sample to another person and refuse its old owner")
        .requiredOption("--sample <id>", "stable ID from voices samples", oneSelection)
        .requiredOption("--to <person>", 'new owner, optionally "Name <email>"')
        .option("--json", "print the correction receipt or refusal")
        .action((person: string, opts: VoiceOptions & { sample: string; to: string }) =>
            guarded(async () => {
                const params = { person, id: stableId(opts.sample), to: moveDestination(opts.to) };
                printCorrection(await withMeetingsClient((c) => c.call("voices.move", params)), flags(opts).json);
            })
        );

    voices
        .command("reject <person>")
        .description("Refuse this person's binding or reject the recording for every owner")
        .requiredOption("--sample <id>", "stable ID from voices samples", oneSelection)
        .option("--reason [reason]", "wrong-person, bad-audio or several-voices")
        .option("--json", "print the correction receipt or refusal")
        .action((person: string, opts: VoiceOptions & { sample: string; reason?: string | boolean }) =>
            guarded(async () => {
                const reason = await resolveEnum({
                    value: opts.reason,
                    values: voicesReject.params.shape.reason.options,
                    flag: "--reason",
                    subcommand: ["voices", "reject", person],
                });
                if (!reason) {
                    return;
                }
                const params = { person, id: stableId(opts.sample), reason };
                printCorrection(await withMeetingsClient((c) => c.call("voices.reject", params)), flags(opts).json);
            })
        );

    voices
        .command("undo <correction-token>")
        .description("Undo a voice-library correction by its receipt token")
        .option("--json", "print the correction receipt or refusal")
        .action((token: string, opts: VoiceOptions) =>
            guarded(async () => {
                printCorrection(await withMeetingsClient((c) => c.call("voices.undo", { token })), flags(opts).json);
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
    // These four commands have always returned JSON and accepted the parent's --json after their name.
    for (const command of voices.commands.filter((c) => ["collect", "prepare", "enroll", "score"].includes(c.name()))) {
        command.option("--json", "print the structured result");
    }
}
