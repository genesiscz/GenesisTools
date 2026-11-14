import type { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { DecisionActor, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
/** What `set` changes on a meeting; a field left out stays as it is. */
import type { MeetingSeats } from "@genesiscz/utils/meetings/seats";
import { callerActor, type Decided, DecisionJournal } from "./decision-journal";
import { resolveProject } from "./project";

export interface MeetingFieldsChange {
    title?: string;
    seats?: MeetingSeats;
    project?: string;
    /** Added to the meeting and to its project's labels. */
    labels?: string[];
    /** Removed from the meeting; each must be a label the meeting carries. */
    unlabel?: string[];
}

/**
 * The fields a `set` action or another caller's object changes, every one `setMeetingFields` takes and none it does
 * not. The service's set adapter copied project, title and labels by hand and dropped `seats`, so every native seating
 * save failed with "Nothing to set" while the service answered.
 */
export function meetingFieldsChange(source: MeetingFieldsChange): MeetingFieldsChange {
    return {
        ...(source.project ? { project: source.project } : {}),
        ...(source.title ? { title: source.title } : {}),
        ...(source.seats ? { seats: source.seats } : {}),
        ...(source.labels ? { labels: source.labels } : {}),
        ...(source.unlabel ? { unlabel: source.unlabel } : {}),
    };
}

/**
 * `set` for every door (the CLI and the node-repl toolset): the meeting's title, project and labels. A change that would
 * change nothing is refused before anything is written (no field, or a label to remove that the meeting does not carry,
 * MC13), so no history line and no project label says it did. The two doors had their own copies, and the refusal
 * reached only the CLI's (R2-MC7).
 */
export async function setMeetingFields(options: {
    store: MeetingStore;
    config: MeetingsConfigStore;
    record: MeetingRecord;
    change: MeetingFieldsChange;
    /** Never prompt for a near-miss project name (an agent, `--yes`). */
    quiet?: boolean;
    /** Who sets them; this process's caller (an agent, else a person at the command line) when absent. */
    actor?: DecisionActor;
    reason?: string;
    onApplied?: (snapshot: { before: MeetingRecord; after: MeetingRecord }) => void;
}): Promise<{ record: MeetingRecord; changes: string[]; decided: Decided }> {
    const { store, config, record, change } = options;
    const labels = change.labels ?? [];
    const unlabel = change.unlabel ?? [];

    if (!change.seats && !change.project && !change.title && labels.length === 0 && unlabel.length === 0) {
        throw new Error("Nothing to set: give a project, a title, labels to add or labels to remove.");
    }

    const absent = unlabel.filter((label) => !record.labels.some((has) => has.toLowerCase() === label.toLowerCase()));

    if (absent.length > 0) {
        throw new Error(
            `${record.id} has no label ${absent.map((one) => `"${one}"`).join(", ")}. Its labels: ${record.labels.join(", ") || "none"}`
        );
    }

    const project = change.project
        ? (await resolveProject({ config, flag: change.project, ...(options.quiet ? { quiet: true } : {}) })).project
        : undefined;
    const target = project ?? record.project;

    if (target && labels.length > 0) {
        await config.setProjectLabels(target, { add: labels });
    }

    const changes = [
        project ? `project ${project}` : "",
        change.title ? `title "${change.title}"` : "",
        change.seats ? "seats and microphone groups" : "",
        labels.length > 0 ? `labels + ${labels.join(", ")}` : "",
        unlabel.length > 0 ? `labels - ${unlabel.join(", ")}` : "",
    ].filter(Boolean);
    // Through the decision journal, so the history says who set them and an Undo puts the old values back (G42, G64).
    const decided = await new DecisionJournal({
        store,
        ...(options.onApplied ? { onApplied: options.onApplied } : {}),
    }).apply({
        meeting: record.id,
        action: {
            kind: "set",
            ...(change.seats ? { seats: change.seats } : {}),
            ...(project ? { project } : {}),
            ...(change.title ? { title: change.title } : {}),
            ...(labels.length > 0 ? { labels } : {}),
            ...(unlabel.length > 0 ? { unlabel } : {}),
        },
        actor: options.actor ?? callerActor(),
        ...(options.reason ? { reason: options.reason } : {}),
    });

    return { record: store.read(record.id) ?? record, changes, decided };
}

/**
 * A project's labels for every door: read them, or add and remove some. Reading or removing needs a known project, so a
 * typo never reads as "no labels"; adding may add the project, as `projects add` would.
 */
export async function projectLabels(options: {
    config: MeetingsConfigStore;
    project: string;
    add?: string[];
    remove?: string[];
}): Promise<string[]> {
    const { config, project } = options;
    const projects = (await config.read()).projects;
    const adds = (options.add?.length ?? 0) > 0;

    if (!projects[project] && !adds) {
        throw new Error(`No project ${project}. The known ones: ${Object.keys(projects).join(", ") || "none"}`);
    }

    if (!adds && (options.remove?.length ?? 0) === 0) {
        return projects[project]?.labels ?? [];
    }

    return config.setProjectLabels(project, { add: options.add ?? [], remove: options.remove ?? [] });
}
