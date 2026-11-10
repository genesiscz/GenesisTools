import { type MeetingsConfig, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { PeopleBook } from "@genesiscz/utils/meetings/people-book";
import { ContactsPeopleSource } from "@genesiscz/utils/meetings/people-contacts";
import { type PeopleDirectory, PeopleError, peopleDirectory } from "@genesiscz/utils/meetings/people-directory";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { type MeetingsHandlerDeps, recordOf, refusal } from "./handlers";

/**
 * The Meetings service's people methods (`people.known`, `people.add`, `people.hide`, `people.planMerge`,
 * `people.merge`, `people.unmerge`): the people directory behind the service (WaveB-Plan "Candidate 6"). Loaded by
 * handlers.ts only when a call asks for people, so Contacts (darwinkit) loads only then. The service runs under
 * GenesisTools.app's identity, so its Contacts reads keep the app's grant.
 */

/** The directory as the settings say now: a setting changed while the service runs counts from the next call. */
export async function directoryOf(store: MeetingStore, deps: MeetingsHandlerDeps): Promise<PeopleDirectory> {
    const config: MeetingsConfig = await (deps.config ?? (() => new MeetingsConfigStore().read()))();
    return peopleDirectory({
        store,
        config,
        book: new PeopleBook({ storage: store.storage, ...(deps.now ? { now: deps.now } : {}) }),
        contacts: deps.contacts ? deps.contacts() : new ContactsPeopleSource(),
    });
}

/** A people refusal with its own code (an ambiguous person carries the candidates); anything else as it is. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof PeopleError) {
            throw refusal(
                error.code,
                error.message,
                error.candidates.length > 0 ? { candidates: error.candidates } : {}
            );
        }

        throw error;
    }
}

export async function knownPeople(
    params: MeetingsParsedParams<"people.known">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"people.known">> {
    const meeting = params.meeting ? recordOf(store, params.meeting).id : undefined;
    const directory = await directoryOf(store, deps);
    return directory.known(params.query, {
        ...(meeting ? { meeting } : {}),
        ...(params.atSec !== undefined ? { atSec: params.atSec } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.includeHidden ? { includeHidden: true } : {}),
    });
}

export async function addPerson(
    params: MeetingsParsedParams<"people.add">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"people.add">> {
    const directory = await directoryOf(store, deps);
    return refusing(() =>
        directory.add({
            name: params.name,
            ...(params.email ? { email: params.email } : {}),
            ...(params.note?.trim() ? { note: params.note } : {}),
        })
    );
}

export async function hidePerson(
    params: MeetingsParsedParams<"people.hide">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"people.hide">> {
    const directory = await directoryOf(store, deps);
    return refusing(() => directory.hide(params.person, params.hidden ?? true));
}

export async function planPeopleMerge(
    params: MeetingsParsedParams<"people.planMerge">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"people.planMerge">> {
    const directory = await directoryOf(store, deps);
    return refusing(() => directory.planMerge(params.a, params.b, params.name));
}

export async function mergePeople(
    params: MeetingsParsedParams<"people.merge">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"people.merge">> {
    const directory = await directoryOf(store, deps);
    return refusing(() => directory.merge(params.a, params.b, params.name));
}

export async function unmergePeople(
    params: MeetingsParsedParams<"people.unmerge">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"people.unmerge">> {
    const directory = await directoryOf(store, deps);
    return refusing(async () => ({ merge: await directory.unmerge(params.token) }));
}
