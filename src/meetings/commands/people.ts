import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { KnownPerson } from "@genesiscz/utils/meetings/people-directory";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { localTime, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import pc from "picocolors";
import type { MeetingsParams, MeetingsResult } from "../lib/service/api";
import { withMeetingsClient } from "../lib/service/client";
import { errorText, fail, TOOL } from "../lib/shared";
import { assignmentText } from "../lib/speaker-assign";

const MEETING_REF = "meeting id, a unique prefix, last, or wisprflow:<id>";
const PERSON_REF = "a name (case and accents do not matter), an email, or an id from --json (email:…, name:…)";

/** Why a person is where they are in the list, in words. */
const RANK_TEXT: Record<KnownPerson["rank"], string> = {
    present: "in the call then",
    meeting: "in this meeting",
    meetings: "in other meetings",
    contacts: "in Contacts",
    own: "added by hand",
};

function personText(person: Pick<KnownPerson, "name" | "email">): string {
    return person.email ? `${person.name} <${person.email}>` : person.name;
}

function printJson(value: unknown): void {
    out.result(SafeJSON.stringify(value, null, 2));
}

interface ListOptions {
    meeting?: string;
    at?: string;
    limit?: string;
    hidden?: boolean;
    json?: boolean;
}

async function list(query: string | undefined, opts: ListOptions): Promise<void> {
    const atSec = opts.at === undefined ? undefined : parseClock(opts.at);
    const limit = opts.limit === undefined ? undefined : Number(opts.limit);

    if (opts.at !== undefined && atSec === undefined) {
        fail(`--at takes a transcript time: 1:23:50, 23:50 or seconds (got "${opts.at}").`);
        return;
    }

    if (atSec !== undefined && !opts.meeting) {
        fail("--at ranks for a moment of a meeting: add --meeting <meeting>.");
        return;
    }

    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 500)) {
        fail(`--limit takes a whole number from 1 to 500 (got "${opts.limit}").`);
        return;
    }

    const params: MeetingsParams<"people.known"> = {
        query: query ?? "",
        ...(opts.meeting ? { meeting: opts.meeting } : {}),
        ...(atSec !== undefined ? { atSec } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(opts.hidden ? { includeHidden: true } : {}),
    };
    let known: MeetingsResult<"people.known">;

    try {
        known = await withMeetingsClient((client) => client.call("people.known", params));
    } catch (err) {
        fail(errorText(err));
        return;
    }

    if (opts.json) {
        printJson(known);
        return;
    }

    if (known.people.length === 0) {
        ui.info(query ? `Nobody known matches "${query}".` : "Nobody known yet: no meeting names a person.");
    } else {
        const table = createBoxTable(["NAME", "EMAIL", "WHY HERE", "MEETINGS", "LAST SEEN", "FROM"]);

        for (const person of known.people) {
            const name = `${person.name}${person.self ? " (you)" : ""}${person.hidden ? pc.dim(" (hidden)") : ""}`;
            table.push([
                pc.white(truncateDisplay(name, 40)),
                truncateDisplay(person.email, 36),
                person.rank === "meetings" && !opts.meeting ? "in meetings" : RANK_TEXT[person.rank],
                String(person.meetings),
                person.lastSeen ? localTime(person.lastSeen).slice(0, 10) : "—",
                person.sources.join(", "),
            ]);
        }

        out.println(table.toString());
    }

    if (known.total > known.people.length) {
        ui.dim(`${known.total - known.people.length} more match: narrow the query or raise --limit.`);
    }

    for (const source of known.sources) {
        if (source.state !== "ok") {
            ui.warn(`${source.kind}: ${source.state}${source.reason ? `, ${source.reason}` : ""}`);
        }
    }
}

async function add(name: string, opts: { email?: string; note?: string; json?: boolean }): Promise<void> {
    try {
        const added = await withMeetingsClient((client) =>
            client.call("people.add", {
                name,
                ...(opts.email ? { email: opts.email } : {}),
                ...(opts.note ? { note: opts.note } : {}),
            })
        );

        if (opts.json) {
            printJson(added);
            return;
        }

        const shown = added.shown ? " (shown again)" : "";
        ui.ok(
            added.added
                ? `Added ${personText(added.person)} to the people book${shown}.`
                : `${personText(added.person)} was in the people book: updated${shown}.`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

async function hide(person: string, opts: { show?: boolean; json?: boolean }): Promise<void> {
    try {
        const hidden = await withMeetingsClient((client) =>
            client.call("people.hide", { person, ...(opts.show ? { hidden: false } : {}) })
        );

        if (opts.json) {
            printJson(hidden);
            return;
        }

        const what = opts.show ? "shown again" : "hidden from the lists";
        ui.ok(
            hidden.changed
                ? `${personText(hidden.person)}: ${what}.`
                : `${personText(hidden.person)} was ${opts.show ? "not hidden" : "hidden already"}.`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

function printPlan(plan: MeetingsResult<"people.planMerge">): void {
    const [a, b] = plan.people;
    out.println(
        `${pc.bold("Merge")} ${personText(a)} ${pc.dim("and")} ${personText(b)} ${pc.dim("into")} ${plan.name}`
    );

    if (plan.meetings.length === 0) {
        out.println(pc.dim("  No meeting names either of them."));
    }

    for (const meeting of plan.meetings) {
        const who = meeting.people.map((index) => plan.people[index]?.name).join(" and ");
        out.println(`  ${pc.dim(localTime(meeting.start))}  ${meeting.title}  ${pc.dim(`(${meeting.id}: ${who})`)}`);
    }

    for (const label of plan.labels) {
        out.println(`  ${pc.dim("label")} ${label.label} in ${label.meeting} (renamed ${label.name})`);
    }

    ui.dim("No meeting record changes: the people directory shows the two as one person.");
}

async function merge(a: string, b: string, opts: { name?: string; yes?: boolean; json?: boolean }): Promise<void> {
    const params = { a, b, ...(opts.name ? { name: opts.name } : {}) };

    try {
        if (!opts.yes) {
            const plan = await withMeetingsClient((client) => client.call("people.planMerge", params));

            if (opts.json) {
                printJson(plan);
                return;
            }

            printPlan(plan);
            ui.info(`Merge them: ${TOOL} people merge "${a}" "${b}"${opts.name ? ` --name "${opts.name}"` : ""} --yes`);
            return;
        }

        const merged = await withMeetingsClient((client) => client.call("people.merge", params));

        if (opts.json) {
            printJson(merged);
            return;
        }

        printPlan(merged.plan);
        ui.ok(`Merged into ${merged.merge.name}. Undo: ${TOOL} people unmerge ${merged.merge.token}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function unmerge(token: string, opts: { json?: boolean }): Promise<void> {
    try {
        const { merge: removed } = await withMeetingsClient((client) => client.call("people.unmerge", { token }));

        if (opts.json) {
            printJson({ merge: removed });
            return;
        }

        ui.ok(`${removed.people.map(personText).join(" and ")} are two people again.`);
    } catch (err) {
        fail(errorText(err));
    }
}

interface AssignOptions {
    email?: string;
    label?: string;
    from?: string;
    to?: string;
    line?: string[];
    plan?: boolean;
    reason?: string;
    json?: boolean;
}

/** The action `people assign` asks the journal for, or the sentence that says what is missing. */
function assignAction(person: string, opts: AssignOptions): MeetingsParams<"decision.plan">["action"] | string {
    const fromSec = opts.from === undefined ? undefined : parseClock(opts.from);
    const toSec = opts.to === undefined ? fromSec : parseClock(opts.to);
    const lines = (opts.line ?? []).map((value) => ({ value, atSec: parseClock(value) }));
    const badLine = lines.find((line) => line.atSec === undefined);

    if ((opts.from !== undefined && fromSec === undefined) || (opts.to !== undefined && toSec === undefined)) {
        return "--from and --to take transcript times: 1:23:50, 23:50 or seconds.";
    }

    if (badLine) {
        return `--line takes the line's start time (got "${badLine.value}").`;
    }

    if (fromSec === undefined && lines.length === 0) {
        return "Name the lines: --from <time> [--to <time>] [--label <label>], or --line <time> (repeat it).";
    }

    return {
        kind: "assign",
        person,
        ...(opts.email ? { email: opts.email } : {}),
        ...(fromSec !== undefined && toSec !== undefined
            ? { stretches: [{ ...(opts.label ? { label: opts.label } : {}), fromSec, toSec }] }
            : {}),
        ...(lines.length > 0
            ? { lines: lines.flatMap((line) => (line.atSec === undefined ? [] : [{ atSec: line.atSec }])) }
            : {}),
    };
}

async function assign(meeting: string, person: string, opts: AssignOptions): Promise<void> {
    const action = assignAction(person, opts);

    if (typeof action === "string") {
        fail(action);
        return;
    }

    const params = { meeting, action, ...(opts.reason ? { reason: opts.reason } : {}) };

    try {
        if (opts.plan) {
            const planned = await withMeetingsClient((client) => client.call("decision.plan", params));

            if (opts.json) {
                printJson(planned);
                return;
            }

            for (const change of planned.entry?.assignments ?? []) {
                out.println(change.after ? `${assignmentText(change.after)} → ${change.after.person}` : change.id);
            }

            for (const stretch of planned.reach.stretches ?? []) {
                const why = stretch.why === "hint-range" ? "the same hint range" : "the same people present";
                out.println(pc.dim(`  also: ${assignmentText(stretch)}, ${stretch.lines} lines (${why})`));
            }

            for (const skip of planned.skipped) {
                ui.warn(`${skip.id}: ${skip.reason}`);
            }

            return;
        }

        const decided = await withMeetingsClient((client) => client.call("decision.apply", params));

        if (opts.json) {
            printJson(decided);
            return;
        }

        for (const skip of decided.skipped) {
            ui.warn(`${skip.id}: ${skip.reason}`);
        }

        if (!decided.entry) {
            ui.info("Nothing changed: those lines are that person's already.");
            return;
        }

        const given = (decided.entry.assignments ?? []).flatMap((change) => (change.after ? [change.after] : []));
        ui.ok(`${given.map(assignmentText).join(", ")} → ${person.trim()}`);
        ui.dim(`Undo: ${TOOL} people unassign ${meeting} ${decided.entry.token}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function unassign(meeting: string, token: string, opts: { reason?: string; json?: boolean }): Promise<void> {
    try {
        const reverted = await withMeetingsClient((client) =>
            client.call("decision.revert", { meeting, token, ...(opts.reason ? { reason: opts.reason } : {}) })
        );

        if (opts.json) {
            printJson(reverted);
            return;
        }

        const back = reverted.entry?.assignments?.length ?? 0;
        ui.ok(back > 0 ? `Undone: ${back} assignment${back === 1 ? "" : "s"} put back.` : "Nothing to undo.");
    } catch (err) {
        fail(errorText(err));
    }
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

export function registerPeopleCommand(program: Command): void {
    const people = program
        .command("people")
        .description(
            "The people directory: everyone the meetings, projects, Contacts and your own entries name, with merges and assignments"
        );

    people
        .command("list", { isDefault: true })
        .argument("[query]", "what to look for: case and accents do not matter; nothing lists everyone")
        .description("The people that match, ranked (for --meeting and --at: the people in that meeting first)")
        .option("--meeting <meeting>", `rank for this meeting (${MEETING_REF})`)
        .option("--at <time>", "and for this transcript time of it: the people in the call then first")
        .option("--limit <n>", "at most this many people (20)")
        .option("--hidden", "list hidden people too")
        .option("--json", "print { query, people, total, sources } as JSON")
        .action(list);

    people
        .command("add")
        .argument("<name>", "the person's name")
        .description("Add a person to the people book (or give one it has an email or a note)")
        .option("--email <address>", "their email")
        .option("--note <text>", "a note to tell them apart")
        .option("--json", "print { person, entry, added, shown } as JSON")
        .action(add);

    people
        .command("hide")
        .argument("<person>", PERSON_REF)
        .description("Leave a person out of every list (--show brings them back)")
        .option("--show", "show a hidden person again")
        .option("--json", "print { person, changed } as JSON")
        .action(hide);

    people
        .command("merge")
        .argument("<a>", PERSON_REF)
        .argument("<b>", PERSON_REF)
        .description("Show two people as one: without --yes it only prints the meetings it links")
        .option("--name <name>", "the name the merged person shows (the first one's by default)")
        .option("--yes", "make the merge")
        .option("--json", "print the plan, or with --yes { merge, plan }, as JSON")
        .action(merge);

    people
        .command("unmerge")
        .argument("<token>", "the merge's token (merge --yes prints it; --json lists it as merge)")
        .description("Split a merge again")
        .option("--json", "print { merge } as JSON")
        .action(unmerge);

    people
        .command("assign")
        .argument("<meeting>", MEETING_REF)
        .argument("<person>", "who said them: a name (a new one is fine)")
        .description("Give lines of one meeting to a person, without renaming the whole label")
        .option("--from <time>", "the stretch's start (transcript time)")
        .option("--to <time>", "the stretch's end (the start by default)")
        .option("--label <label>", "only this source label's lines in the stretch (every voice by default)")
        .option("--line <time>", "one line, by its start time (repeat it)", collect)
        .option("--email <address>", "the person's email")
        .option("--plan", "print what it would give, and the other stretches it may reach, without saving")
        .option("--reason <text>", "why: kept in the decision journal")
        .option("--json", "print the decision as JSON")
        .action(assign);

    people
        .command("unassign")
        .argument("<meeting>", MEETING_REF)
        .argument(
            "<token>",
            `the assignment's token (assign prints it; ${toolCommand("meetings", "journal")} lists it)`
        )
        .description("Undo an assignment")
        .option("--reason <text>", "why: kept in the decision journal")
        .option("--json", "print the revert as JSON")
        .action(unassign);
}
