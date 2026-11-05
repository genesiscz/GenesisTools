import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { reasonText } from "@genesiscz/utils/meetings/proposals";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { Command } from "commander";
import pc from "picocolors";
import { applyAnswer, askMeeting, assignSweep, defaultAssignDeps, skipReason, viewProposals } from "../lib/assign";
import { errorText, fail, TOOL } from "../lib/shared";

const MEETING_REF = "meeting id, a unique prefix, last, or wisprflow:<id>";

function meetingOrFail(store: MeetingStore, ref: string): MeetingRecord | undefined {
    const record = store.resolve(ref);

    if (!record) {
        fail(`No meeting "${ref}". List them: ${TOOL} list`);
    }

    return record;
}

async function proposals(ref: string, opts: { json?: boolean }): Promise<void> {
    try {
        const store = new MeetingStore();
        const record = meetingOrFail(store, ref);

        if (!record) {
            return;
        }

        const deps = defaultAssignDeps();
        const view = await viewProposals(store, record, deps);
        const { assign } = (await deps.config.read()).global;
        const skipped = skipReason({ record, store, now: deps.now(), retryFailedMin: assign.retryFailedMin });

        if (opts.json) {
            out.result(SafeJSON.stringify({ meeting: record.id, skipped, ...view, record: undefined }, null, 2));
            return;
        }

        ui.header(`${record.title} (${record.id})${record.project ? `: project ${record.project}` : ""}`);

        if (view.proposals.projects.length === 0) {
            ui.info("No project rule, paired person or title word points to a known project.");
        }

        for (const [i, proposal] of view.proposals.projects.entries()) {
            ui.raw(`${i + 1}. ${pc.white(proposal.project)} ${pc.dim(`(${proposal.score})`)}`);

            for (const reason of proposal.reasons) {
                ui.dim(`     ${reasonText(reason)}`);
            }
        }

        if (view.proposals.calendars.length > 0) {
            ui.section("Calendar entries that overlap");

            for (const candidate of view.proposals.calendars) {
                const entry = candidate.entry;
                ui.raw(
                    `  ${entry.title} · ${entry.calendar ?? entry.from} · ${Math.round(candidate.share * 100)}% · ` +
                        `${entry.people.length} people · ${pc.dim(entry.entryId)}`
                );
            }
        }

        for (const label of view.proposals.labels) {
            ui.raw(`  label ${pc.white(label.label)} (${label.project}): ${label.reason}`);
        }

        if (view.proposals.folder) {
            ui.dim(`folder step: ${SafeJSON.stringify(view.proposals.folder)}`);
        }

        for (const note of view.calendarNotes) {
            ui.warn(note);
        }

        ui.dim(skipped ? `not asked: ${skipped}` : `asks on the next sweep (${TOOL} assign sweep)`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function ask(ref: string, opts: { force?: boolean }): Promise<void> {
    try {
        const store = new MeetingStore();
        const record = meetingOrFail(store, ref);

        if (!record) {
            return;
        }

        const result = await askMeeting(store, record, defaultAssignDeps(), { force: opts.force });

        if (result.formId) {
            ui.ok(`Asked in the decision inbox: ${result.formId}`);
            return;
        }

        ui.info(`Not asked: ${result.skipped}${opts.force ? "" : " (--force asks anyway)"}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function sweep(opts: { json?: boolean }): Promise<void> {
    try {
        const result = await assignSweep(new MeetingStore());

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            return;
        }

        ui.ok(`asked ${result.asked.length}, advanced ${result.advanced.length}`);

        for (const step of result.advanced) {
            ui.dim(`  ${step.meeting}: ${step.outcome}`);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

async function apply(
    ref: string,
    opts: { project?: string; none?: boolean; label?: string[]; entry?: string; pairFolder?: boolean }
): Promise<void> {
    try {
        const store = new MeetingStore();
        const record = meetingOrFail(store, ref);

        if (!record) {
            return;
        }

        if (!opts.project && !opts.none) {
            fail("Give --project <name> or --none.");
            return;
        }

        const deps = defaultAssignDeps();
        const entries =
            record.assign?.ask?.calendars ??
            (await viewProposals(store, record, deps)).proposals.calendars.map((candidate) => candidate.entry);
        const calendarIndex = opts.entry ? entries.findIndex((entry) => entry.entryId === opts.entry) : undefined;

        if (opts.entry && calendarIndex === -1) {
            fail(`No overlapping entry ${opts.entry} for this meeting. See: ${TOOL} assign proposals ${record.id}`);
            return;
        }

        const applied = await applyAnswer({
            store,
            record,
            deps,
            entries,
            answer: {
                project: opts.none ? null : opts.project,
                labels: opts.label ?? [],
                ...(calendarIndex !== undefined ? { calendarIndex } : {}),
                ...(opts.pairFolder !== undefined ? { pairFolder: opts.pairFolder } : {}),
            },
        });
        ui.ok(
            `${record.id}: ${applied.project ? `project ${applied.project}` : "no project"}` +
                (applied.labels.length > 0 ? `, labels ${applied.labels.join(", ")}` : "") +
                (applied.paired.length > 0 ? `, paired ${applied.paired.join(", ")}` : "") +
                (applied.folderPaired ? `, folder "${applied.folderPaired}" paired` : "")
        );

        if (applied.waitsForFolder) {
            ui.info("The meeting is in no source folder: move it there, and the next sweep asks to pair the folder.");
        }
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerAssignCommands(program: Command): void {
    const assign = program
        .command("assign")
        .description("How a meeting finds its project: proposals, the decision-inbox question and its answer");

    assign
        .command("proposals")
        .alias("explain")
        .argument("<meeting>", MEETING_REF)
        .description("The ranked project proposals of a meeting and why; reads only")
        .option("--json", "print JSON")
        .action(proposals);
    assign
        .command("ask")
        .argument("<meeting>", MEETING_REF)
        .description("Post the meeting's project question to the decision inbox now")
        .option("--force", "ask even when the meeting has a project or was asked before")
        .action(ask);
    assign
        .command("sweep")
        .description("One pass: read back answers, then ask about each recent ended meeting without a project")
        .option("--json", "print JSON")
        .action(sweep);
    assign
        .command("apply")
        .argument("<meeting>", MEETING_REF)
        .description("Apply an answer without the inbox: the project, labels, the calendar entry to pair, the folder")
        .option("--project <name>", "its project (a new name joins the known projects)")
        .option("--none", "no project for this meeting")
        .option("--label <text...>", "labels")
        .option("--entry <id>", "the overlapping calendar entry whose attendees are paired with the project")
        .option("--pair-folder", "pair the source folder the meeting is in with the project")
        .action(apply);
}
