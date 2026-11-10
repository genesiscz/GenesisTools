import { type DictionaryScope, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { applyConfigEdits, type ConfigEdit, configValueAt, parseConfigPath } from "../config-edit";
import { testPhrase } from "../dictionary-test";
import { matchPreview } from "../match-preview";
import { projectLabels } from "../meeting-fields";
import { removeProject, renameProject } from "../project-admin";
import { projectSuggestions, type SuggestionReads } from "../project-suggestions";
import { dictionaryShowRead } from "../window-reads";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { type MeetingsHandlerDeps, refusal } from "./handlers";

/**
 * The Meetings service's library methods (`projects.*`, `dictionary.*`, `config.edit`): the known projects, the
 * dictionary and the source rules the settings page reads and changes (decision 13). Each answers what its command
 * prints with `--json`, so `tools meetings projects`, `dictionary` and `config edit` print the same bytes through the
 * service and in their own process. Loaded by handlers.ts only when a call asks for one of them.
 */

/** The meetings config the library methods read and write: the config file unless a test passes a scratch one. */
function configOf(deps: MeetingsHandlerDeps): MeetingsConfigStore {
    return deps.configStore?.() ?? new MeetingsConfigStore();
}

function scopeOf(project: string | undefined): DictionaryScope {
    return project ? { kind: "project", project } : { kind: "global" };
}

/** The level a dictionary change names in its sentence: `global` or `project <name>`. */
function levelOf(project: string | undefined): string {
    return project ? `project ${project}` : "global";
}

export async function editConfig(
    params: MeetingsParsedParams<"config.edit">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"config.edit">> {
    const edits: ConfigEdit[] = params.edits.map((one) =>
        "unset" in one
            ? { path: one.path, unset: true, ...("expect" in one ? { expect: one.expect } : {}) }
            : { path: one.path, value: one.value, ...("expect" in one ? { expect: one.expect } : {}) }
    );
    const config = await applyConfigEdits(configOf(deps), edits);
    return edits.map((one) => {
        const segments = parseConfigPath(one.path);
        return { path: segments, value: configValueAt(config, segments) ?? null };
    });
}

export async function addProject(
    params: MeetingsParsedParams<"projects.add">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"projects.add">> {
    return { name: params.name, added: await configOf(deps).addProject(params.name) };
}

export async function renameKnownProject(
    params: MeetingsParsedParams<"projects.rename">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"projects.rename">> {
    return renameProject({ config: configOf(deps), store, from: params.from, to: params.to });
}

export async function removeKnownProject(
    params: MeetingsParsedParams<"projects.remove">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"projects.remove">> {
    return removeProject({
        config: configOf(deps),
        store,
        name: params.name,
        ...(params.unassign ? { unassign: true } : {}),
        ...(deps.now ? { now: deps.now() } : {}),
    });
}

export async function changeProjectLabels(
    params: MeetingsParsedParams<"projects.labels">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"projects.labels">> {
    const labels = await projectLabels({
        config: configOf(deps),
        project: params.project,
        ...(params.add ? { add: params.add } : {}),
        ...(params.remove ? { remove: params.remove } : {}),
    });
    return { project: params.project, labels };
}

export async function unpairProjects(
    params: MeetingsParsedParams<"projects.unpair">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"projects.unpair">> {
    const config = configOf(deps);

    if (params.entry) {
        return { removed: await config.unpairEntry(params.entry) };
    }

    if (!params.project || !params.person) {
        throw refusal("failed", "Name a calendar entry (entry), or a project and a person (project, person).");
    }

    const { project, person } = params;
    const removed = await config.unpairPerson(project, person);
    return {
        removed: removed
            ? [{ project, name: person.name, ...(person.email ? { email: person.email } : {}), left: true }]
            : [],
    };
}

export async function previewProjects(
    params: MeetingsParsedParams<"projects.preview">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"projects.preview">> {
    const limit = params.limit ?? 20;
    return matchPreview({
        records: store.listBounded({ limit }).records,
        config: await configOf(deps).read(),
        ...(params.draft ? { draft: params.draft } : {}),
        limit,
    });
}

/** The sources' own folder lists and the Calendar app's calendars, read without asking for a grant. */
function defaultSuggestionReads(): SuggestionReads {
    return {
        sourceFolders: async (source) => (await (await import("../sources")).meetingSource(source)).folders(),
        calendarNames: async () => {
            if (process.platform !== "darwin") {
                return { reason: "The Calendar app exists only on macOS" };
            }

            const { MacCalendar } = await import("@genesiscz/utils/macos/apple-calendar");
            const auth = await MacCalendar.authorizationStatus();

            if (auth.status !== "fullAccess") {
                return {
                    reason: `Calendar access is "${auth.status}", so only the calendars the meetings name are offered`,
                };
            }

            return { names: (await MacCalendar.listCalendarsUnguarded()).map((calendar) => calendar.title) };
        },
    };
}

export async function suggestProjectValues(
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"projects.suggestions">> {
    return projectSuggestions({
        records: store.listBounded({ limit: 300 }).records,
        config: await configOf(deps).read(),
        reads: deps.suggestionReads?.() ?? defaultSuggestionReads(),
    });
}

export async function showDictionary(
    params: MeetingsParsedParams<"dictionary.show">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"dictionary.show">> {
    return dictionaryShowRead(await configOf(deps).read(), params.project);
}

export async function addDictionaryEntry(
    params: MeetingsParsedParams<"dictionary.add">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"dictionary.add">> {
    const config = configOf(deps);
    const projectAdded = params.project ? await config.addProject(params.project) : false;
    const scope = scopeOf(params.project);
    const replaced = params.replace && params.replace !== params.entry.value ? params.replace : undefined;

    if (replaced) {
        await config.replaceDictionaryEntry(scope, replaced, params.entry);
    } else {
        await config.putDictionaryEntry(scope, params.entry, { ifAbsent: params.ifAbsent === true });
    }

    return { entry: params.entry, level: levelOf(params.project), projectAdded, ...(replaced ? { replaced } : {}) };
}

export async function removeDictionaryEntry(
    params: MeetingsParsedParams<"dictionary.remove">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"dictionary.remove">> {
    const removed = await configOf(deps).removeDictionaryEntry(scopeOf(params.project), params.value);
    return { value: params.value, level: levelOf(params.project), removed };
}

export async function testDictionaryPhrase(
    params: MeetingsParsedParams<"dictionary.test">,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"dictionary.test">> {
    return testPhrase(await configOf(deps).read(), {
        phrase: params.phrase,
        ...(params.project ? { project: params.project } : {}),
    });
}
