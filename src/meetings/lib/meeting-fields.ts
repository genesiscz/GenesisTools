import { type MeetingsConfigStore, mergeLabels } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { resolveProject } from "./project";

/** What `set` changes on a meeting; a field left out stays as it is. */
export interface MeetingFieldsChange {
    title?: string;
    project?: string;
    /** Added to the meeting and to its project's labels. */
    labels?: string[];
    /** Removed from the meeting; each must be a label the meeting carries. */
    unlabel?: string[];
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
}): Promise<{ record: MeetingRecord; changes: string[] }> {
    const { store, config, record, change } = options;
    const labels = change.labels ?? [];
    const unlabel = change.unlabel ?? [];

    if (!change.project && !change.title && labels.length === 0 && unlabel.length === 0) {
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
        labels.length > 0 ? `labels + ${labels.join(", ")}` : "",
        unlabel.length > 0 ? `labels - ${unlabel.join(", ")}` : "",
    ].filter(Boolean);
    const removed = new Set(unlabel.map((label) => label.toLowerCase()));
    const updated = await store.update(record.id, { command: "set", change: changes.join(", ") }, (current) => {
        current.project = project ?? current.project;
        current.title = change.title ?? current.title;
        current.labels = mergeLabels(current.labels, labels).filter((label) => !removed.has(label.toLowerCase()));
    });

    return { record: updated, changes };
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
