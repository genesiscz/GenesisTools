import type { RpcHandlers } from "@genesiscz/utils/api-descriptor";
import { type MeetingsConfig, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { PeopleBook } from "@genesiscz/utils/meetings/people-book";
import { ContactsPeopleSource } from "@genesiscz/utils/meetings/people-contacts";
import { type PeopleDirectory, PeopleError, peopleDirectory } from "@genesiscz/utils/meetings/people-directory";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { autoVoiceWorkers } from "../speaker-labels/voice";
import { backfillVoices } from "../voice-backfill";
import {
    applyVoices,
    editVoice,
    listProjectVoices,
    planVoiceRemoval,
    previewVoices,
    removeVoice,
    voiceQuality,
    voiceSample,
} from "../voices";
import type { MeetingsParsedParams, MeetingsResult, VOICES_METHODS } from "./api";
import { type MeetingsHandlerDeps, recordOf, refusal, voicePassProgress } from "./handlers";

/** Project voice operations shared with the CLI. */
export function voicesHandlers(
    store: MeetingStore,
    deps: MeetingsHandlerDeps = {}
): RpcHandlers<{ methods: typeof VOICES_METHODS }, import("./handlers").MeetingsCallContext> {
    const access = { store, linkedSource: deps.linkedSource, config: deps.config };
    // A missing or ambiguous meeting answers with the typed refusal `meeting.show` gives (`meeting-not-found`,
    // `meeting-ref`), not with the voice library's plain error.
    const knownMeetings = (refs: readonly string[] | undefined) => {
        for (const ref of refs ?? []) {
            recordOf(store, ref);
        }
    };
    async function correction(
        action: Parameters<typeof editVoice>[0]["action"],
        params: { person?: string; preview?: boolean; planToken?: string },
        context: import("./handlers").MeetingsCallContext
    ) {
        const result = await editVoice({
            ...access,
            action,
            person: params.person,
            preview: params.preview,
            planToken: params.planToken,
        });
        if (result.status === "applied") {
            context.emit?.("people.changed", {});
            for (const meeting of new Set(result.affected.map((row) => row.meeting))) {
                context.emit?.("meeting.changed", { meeting, parts: ["show", "speakers", "transcript"] });
            }
        }
        return result;
    }
    return {
        "voices.jobs": ({ project }) => deps.voiceJobs?.list(project) ?? [],
        "voices.jobs.cancel": ({ id }) => deps.voiceJobs?.cancel(id) ?? null,
        "voices.move": (p, context) =>
            correction(
                { kind: "move", id: p.id, to: p.to, token: p.token, expectedRevision: p.expectedRevision },
                p,
                context
            ),
        "voices.reject": (p, context) =>
            correction(
                { kind: "reject", id: p.id, reason: p.reason, token: p.token, expectedRevision: p.expectedRevision },
                p,
                context
            ),
        "voices.undo": (p, context) =>
            correction(
                { kind: "revert", correction: p.token, token: p.requestToken, expectedRevision: p.expectedRevision },
                p,
                context
            ),
        "voices.quality": (p) => voiceQuality({ ...access, ...p }),
        "voices.list": (params) => listProjectVoices({ ...access, ...params }),
        "voice.backfill": async (params, context) => {
            const result =
                deps.voiceJobs && !params.dryRun
                    ? await deps.voiceJobs.backfill(params)
                    : await backfillVoices({ ...access, ...params });
            if (!deps.voiceJobs && !result.dryRun && result.added) {
                context.emit?.("people.changed", {});
            }
            return result;
        },
        "voices.preview": (params, context) => {
            knownMeetings([params.meeting]);
            return previewVoices({
                ...access,
                ...params,
                onProgress: voicePassProgress(context),
                signal: context.signal,
            });
        },
        "voices.sample": (params) => voiceSample({ ...access, ...params }),
        "voices.workers": () => autoVoiceWorkers(deps.freeCores),
        "voices.apply": async (params, context) => {
            knownMeetings([params.meeting]);
            const result = await applyVoices({
                ...access,
                ...params,
                onProgress: voicePassProgress(context),
                signal: context.signal,
            });
            context.emit?.("meeting.changed", { meeting: result.meeting, parts: ["show", "speakers", "transcript"] });
            return result;
        },
        "voices.remove": async (params, context) => {
            const predictionScope = (await (deps.config?.() ?? new MeetingsConfigStore().read())).global.speakerLabels
                .voice.sampleScope;
            const request = { ...access, ...params, predictionScope };
            const result = params.preview ? planVoiceRemoval(request) : await removeVoice(request);
            if (!params.preview) {
                context.emit?.("people.changed", {});
                for (const meeting of new Set(result.affected.map((row) => row.meeting))) {
                    context.emit?.("meeting.changed", { meeting, parts: ["show", "speakers", "transcript"] });
                }
            }
            return result;
        },
    };
}

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

export async function personMeetings(
    params: MeetingsParsedParams<"people.meetings">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"people.meetings">> {
    const directory = await directoryOf(store, deps);
    return refusing(() => directory.meetings(params.person));
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
