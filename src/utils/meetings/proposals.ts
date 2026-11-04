import type { CalendarEntry } from "./calendar-entry";
import type { MeetingsConfig } from "./config";
import { type PersonRef, pairedAmong, withoutSelf } from "./people";
import type { MeetingSourceId } from "./sources";

/** One calendar entry that overlaps the meeting, with how much of the meeting it covers. */
export interface CalendarCandidate {
    entry: CalendarEntry;
    /** Seconds of the meeting the entry covers. */
    overlapSec: number;
    /** That share of the meeting, 0 to 1. */
    share: number;
}

/** An earlier meeting, for the title words its project used. */
export interface MeetingHistoryRow {
    id: string;
    title: string;
    project?: string;
    labels: string[];
}

/** What a meeting offers to find its project by. */
export interface MeetingFacts {
    title: string;
    /** The source the meeting came from, with the folders the source keeps it in. */
    source?: { id: MeetingSourceId; folders: string[] };
    /** The overlapping calendar entries, best first (`calendarCandidates`). */
    calendars: CalendarCandidate[];
    /** The people the record names (the source's speakers). */
    participants: PersonRef[];
    /** Earlier meetings, newest first. */
    history: MeetingHistoryRow[];
}

/** Why a project is proposed. Each kind is one signal with its own weight (`REASON_WEIGHT`). */
export type ProposalReason =
    | { kind: "folder"; source: MeetingSourceId; folder: string }
    | { kind: "calendar-name"; calendar: string }
    | { kind: "title-rule"; word: string }
    | { kind: "people"; people: string[]; of: number; entry?: { title: string; entryId: string } }
    | { kind: "title-history"; words: string[]; meetings: number };

export interface ProjectProposal {
    project: string;
    score: number;
    reasons: ProposalReason[];
}

export interface LabelProposal {
    project: string;
    label: string;
    reason: string;
}

/**
 * The Wispr folder step (the folder ladder). `pair`: the meeting sits in a folder no project has, so the answer can
 * pair it. `move`: the meeting sits in no folder, and the proposed projects name the folders to move it to.
 */
export type FolderAdvice =
    | { kind: "pair"; source: MeetingSourceId; folder: string }
    | { kind: "move"; source: MeetingSourceId; folders: Array<{ project: string; folders: string[] }> };

export interface Proposals {
    projects: ProjectProposal[];
    labels: LabelProposal[];
    calendars: CalendarCandidate[];
    folder?: FolderAdvice;
}

/** Points per signal. A rule the owner wrote outranks what the tool learned; a person counts per head, capped. */
const REASON_WEIGHT = {
    folder: 100,
    calendarName: 60,
    titleRule: 40,
    person: 15,
    peopleCap: 60,
    historyWord: 8,
    historyCap: 24,
} as const;

/** Words that say nothing about a project, in the meeting languages (cs, en). */
const STOP_WORDS = new Set([
    "meeting",
    "sync",
    "call",
    "update",
    "with",
    "and",
    "the",
    "for",
    "from",
    "nad",
    "pro",
    "schuzka",
    "porada",
]);

function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a title that can name a project: four letters or more, not a stop word. */
export function titleWords(title: string): string[] {
    const words = fold(title)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
    return [...new Set(words)];
}

/**
 * The entries that overlap the meeting, or start within `slackMin` of its start, best cover first. A meeting with no
 * end yet is taken as 30 minutes long.
 */
export function calendarCandidates(options: {
    entries: CalendarEntry[];
    start: string;
    end?: string;
    slackMin: number;
}): CalendarCandidate[] {
    const start = Date.parse(options.start);
    const end = options.end ? Date.parse(options.end) : start + 30 * 60_000;
    const length = Math.max(end - start, 60_000);
    const slack = options.slackMin * 60_000;

    return options.entries
        .map((entry) => {
            const from = Math.max(start, Date.parse(entry.start));
            const to = Math.min(end, Date.parse(entry.end));
            const overlap = Math.max(0, to - from);
            return { entry, overlapSec: Math.round(overlap / 1000), share: Math.min(1, overlap / length) };
        })
        .filter((candidate) => candidate.overlapSec > 0 || Math.abs(Date.parse(candidate.entry.start) - start) <= slack)
        .sort((a, b) => b.share - a.share || Date.parse(a.entry.start) - Date.parse(b.entry.start));
}

/**
 * One list of entries from several calendars: an entry with the same title and start (within a minute) as one
 * already listed joins it in `alsoIn`, and its people and calendar name fill what the first one lacks.
 */
export function mergeCalendarEntries(lists: CalendarEntry[][]): CalendarEntry[] {
    const merged: CalendarEntry[] = [];

    for (const entry of lists.flat()) {
        const same = merged.find(
            (known) =>
                fold(known.title).trim() === fold(entry.title).trim() &&
                Math.abs(Date.parse(known.start) - Date.parse(entry.start)) <= 60_000
        );

        if (!same) {
            merged.push({ ...entry, people: [...entry.people] });
            continue;
        }

        same.alsoIn = [
            ...(same.alsoIn ?? []),
            { from: entry.from, entryId: entry.entryId, ...(entry.calendar ? { calendar: entry.calendar } : {}) },
        ];
        same.calendar ??= entry.calendar;
        same.conferenceUrl ??= entry.conferenceUrl;

        if (same.people.length === 0) {
            same.people = [...entry.people];
        }
    }

    return merged;
}

function add(scores: Map<string, ProjectProposal>, project: string, points: number, reason: ProposalReason): void {
    const current = scores.get(project) ?? { project, score: 0, reasons: [] };
    current.score += points;
    current.reasons.push(reason);
    scores.set(project, current);
}

/** The best people match of one project: over each overlapping entry's attendees, then the record's own people. */
function peopleReason(
    config: MeetingsConfig,
    project: string,
    facts: MeetingFacts
): Extract<ProposalReason, { kind: "people" }> | undefined {
    const list = config.projects[project]?.match?.people ?? [];

    if (list.length === 0) {
        return undefined;
    }

    const groups: Array<{ people: PersonRef[]; entry?: CalendarEntry }> = [
        ...facts.calendars.map((candidate) => ({ people: candidate.entry.people, entry: candidate.entry })),
        { people: facts.participants },
    ];
    let best: Extract<ProposalReason, { kind: "people" }> | undefined;

    for (const group of groups) {
        const matched = pairedAmong(list, group.people);

        if (matched.length > (best?.people.length ?? 0)) {
            best = {
                kind: "people",
                people: matched.map((person) => person.name),
                of: withoutSelf(group.people).length,
                ...(group.entry ? { entry: { title: group.entry.title, entryId: group.entry.entryId } } : {}),
            };
        }
    }

    return best;
}

/**
 * The known projects this meeting may belong to, ranked, each with its reasons: the source's folder rule, the
 * calendar name rule, the title rules, the paired people among the attendees, and words the project's earlier
 * meetings shared with this title. Plus the labels to propose, the overlapping calendar entries and the folder step.
 */
export function proposeProjects(config: MeetingsConfig, facts: MeetingFacts): Proposals {
    const scores = new Map<string, ProjectProposal>();
    const title = fold(facts.title);
    const folders = new Set((facts.source?.folders ?? []).map((folder) => folder.toLowerCase()));
    const sourceMatch = facts.source ? config.sources[facts.source.id].match : {};
    const calendarNames = new Set(
        facts.calendars.flatMap((candidate) =>
            [candidate.entry.calendar, ...(candidate.entry.alsoIn ?? []).map((other) => other.calendar)]
                .filter((name): name is string => typeof name === "string")
                .map((name) => name.toLowerCase())
        )
    );
    const words = titleWords(facts.title);

    for (const [project, settings] of Object.entries(config.projects)) {
        for (const folder of sourceMatch[project]?.folders ?? []) {
            if (facts.source && folders.has(folder.toLowerCase())) {
                add(scores, project, REASON_WEIGHT.folder, { kind: "folder", source: facts.source.id, folder });
            }
        }

        for (const calendar of settings.match?.calendar?.calendars ?? []) {
            if (calendarNames.has(calendar.toLowerCase())) {
                add(scores, project, REASON_WEIGHT.calendarName, { kind: "calendar-name", calendar });
            }
        }

        for (const word of settings.match?.title?.words ?? []) {
            if (title !== "" && title.includes(fold(word))) {
                add(scores, project, REASON_WEIGHT.titleRule, { kind: "title-rule", word });
            }
        }

        const people = peopleReason(config, project, facts);

        if (people) {
            add(
                scores,
                project,
                Math.min(REASON_WEIGHT.peopleCap, people.people.length * REASON_WEIGHT.person),
                people
            );
        }

        const earlier = facts.history.filter((row) => row.project === project);
        const shared = words.filter((word) => earlier.some((row) => titleWords(row.title).includes(word)));

        if (shared.length > 0) {
            const meetings = earlier.filter((row) => titleWords(row.title).some((word) => shared.includes(word)));
            add(scores, project, Math.min(REASON_WEIGHT.historyCap, shared.length * REASON_WEIGHT.historyWord), {
                kind: "title-history",
                words: shared,
                meetings: meetings.length,
            });
        }
    }

    const projects = [...scores.values()]
        .sort((a, b) => b.score - a.score || a.project.localeCompare(b.project))
        .slice(0, config.global.assign.maxProposals);

    return {
        projects,
        labels: proposeLabels(config, facts, projects),
        calendars: facts.calendars,
        folder: folderAdvice(config, facts, projects),
    };
}

/** A project's label is proposed when its words are in the title or an entry's title, or an earlier meeting with the
 * same title words carried it. */
function proposeLabels(config: MeetingsConfig, facts: MeetingFacts, projects: ProjectProposal[]): LabelProposal[] {
    const texts = [facts.title, ...facts.calendars.map((candidate) => candidate.entry.title)].map(fold);
    const words = titleWords(facts.title);
    const labels: LabelProposal[] = [];

    for (const { project } of projects) {
        for (const label of config.projects[project]?.labels ?? []) {
            const inText = texts.some((text) => text.includes(fold(label)));
            const earlier = facts.history.find(
                (row) =>
                    row.project === project &&
                    row.labels.some((known) => known.toLowerCase() === label.toLowerCase()) &&
                    titleWords(row.title).some((word) => words.includes(word))
            );

            if (inText) {
                labels.push({ project, label, reason: `"${label}" is in the title` });
            } else if (earlier) {
                labels.push({ project, label, reason: `earlier meeting "${earlier.title}" had it` });
            }
        }
    }

    return labels;
}

function folderAdvice(
    config: MeetingsConfig,
    facts: MeetingFacts,
    projects: ProjectProposal[]
): FolderAdvice | undefined {
    if (!facts.source) {
        return undefined;
    }

    const match = config.sources[facts.source.id].match;
    const paired = new Set(Object.values(match).flatMap((rule) => rule.folders.map((folder) => folder.toLowerCase())));
    const unpaired = facts.source.folders.find((folder) => !paired.has(folder.toLowerCase()));

    if (unpaired) {
        return { kind: "pair", source: facts.source.id, folder: unpaired };
    }

    if (facts.source.folders.length > 0) {
        return undefined;
    }

    return {
        kind: "move",
        source: facts.source.id,
        folders: projects.map(({ project }) => ({ project, folders: match[project]?.folders ?? [] })),
    };
}

/** One line for a reason, as the question and `assign proposals` show it. */
export function reasonText(reason: ProposalReason): string {
    switch (reason.kind) {
        case "folder":
            return `in ${reason.source} folder "${reason.folder}"`;
        case "calendar-name":
            return `calendar "${reason.calendar}"`;
        case "title-rule":
            return `title has "${reason.word}"`;
        case "people": {
            const where = reason.entry ? ` of "${reason.entry.title}"` : " of the transcript";
            return `${reason.people.length} of ${reason.of} people${where} paired: ${reason.people.join(", ")}`;
        }
        case "title-history":
            return `title words ${reason.words.map((word) => `"${word}"`).join(", ")} as in ${reason.meetings} earlier meeting(s)`;
        default: {
            const never: never = reason;
            return String(never);
        }
    }
}

/** A key for a person on the question, so an answer can find them again. */
export function personLabel(person: PersonRef): string {
    return person.email ? `${person.name} <${person.email}>` : person.name;
}
