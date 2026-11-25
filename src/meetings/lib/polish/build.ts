import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { linkGate } from "@genesiscz/utils/browser-router/link-gate";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    checkGenerated,
    type DocumentCheck,
    portablePath,
    type WriteOutcome,
    writeGenerated,
} from "@genesiscz/utils/json2md/document-file";
import { type CheckResult, hashData, stampMarkdown } from "@genesiscz/utils/json2md/integrity";
import { localTimestamp } from "@genesiscz/utils/json2md/value";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfig, MeetingsConfigStore, polishedPhrasesOf } from "@genesiscz/utils/meetings/config";
import {
    type DefinedMeetingsPolished,
    isDefinedMeetingsPolished,
    type MeetingsPolishedConfig,
} from "@genesiscz/utils/meetings/polished";
import { type MeetingRecord, MeetingStore, meetingAddress } from "@genesiscz/utils/meetings/record";
import { packageImporterDirs, packageResolvesFrom } from "@genesiscz/utils/package-link";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { playLinksFor } from "../link";
import { OpenedMeeting } from "../opened-meeting";
import type { LinkedSource } from "../sources";
import { correctedTranscriptRead } from "../window-reads";
import { type LoadedPart, renderPolished } from "./render";
import { questionRows, speakerRows, termRows } from "./rows";
import type { PartTimes } from "./tokens";

const { log } = logger.scoped("meetings-polish");

/**
 * The polished module imports `@genesiscz/utils`, which does not resolve from its folder: `tools link install` has not
 * run for it (a vault, a folder outside the home directory). `dir` is the first folder it fails from.
 */
export class PolishedModuleUnlinkedError extends Error {
    constructor(readonly dir: string) {
        super(`@genesiscz/utils does not resolve from ${dir}: run ${toolCommand("link", "install")} once`);
        this.name = "PolishedModuleUnlinkedError";
    }
}

/** The first folder of the module's import graph that cannot resolve `@genesiscz/utils`, or null. */
export async function unlinkedPolishedDir(modulePath: string): Promise<string | null> {
    return (await packageImporterDirs(modulePath)).find((dir) => !packageResolvesFrom(dir)) ?? null;
}

/**
 * Loads a `.polished.ts` and returns its `defineMeetingsPolished` export. The import names the file's modification
 * time, so a long-lived process (the node REPL) reads the file again after an agent edits it.
 */
export async function loadPolishedModule(modulePath: string): Promise<DefinedMeetingsPolished> {
    const unlinked = await unlinkedPolishedDir(modulePath);

    if (unlinked) {
        throw new PolishedModuleUnlinkedError(unlinked);
    }

    const loaded: unknown = await import(`${modulePath}?mtime=${statSync(modulePath).mtimeMs}`);
    const candidate = typeof loaded === "object" && loaded !== null && "default" in loaded ? loaded.default : undefined;

    if (isDefinedMeetingsPolished(candidate)) {
        return candidate;
    }

    throw new Error(
        `${modulePath} has no default export from defineMeetingsPolished(). Write: export default defineMeetingsPolished({ … });`
    );
}

/** The markdown a polished module writes: its `out`, else its own path with `.md`. */
export function polishedOutPath(modulePath: string, config: Pick<MeetingsPolishedConfig, "out">): string {
    if (config.out) {
        return isAbsolute(config.out) ? config.out : resolve(dirname(modulePath), config.out);
    }

    return `${modulePath.replace(/\.[cm]?tsx?$/, "")}.md`;
}

/** `write` writes; `dry-run` renders and compares only; `check` reports the verdict (`--check`). */
export type PolishMode = "write" | "dry-run" | "check";

export interface PolishBuildResult {
    file: string;
    outPath: string;
    mode: PolishMode;
    /** What `write` or `dry-run` did; absent for `check`. */
    outcome?: WriteOutcome;
    /** The verdict against the existing file: clean, stale, hand-edited, unstamped or unsupported; null for a new file. */
    check: (CheckResult & Partial<Pick<DocumentCheck, "exists" | "diff">>) | null;
    /** Front matter keys kept from the file this build replaced (the vault's `sessions:` list). */
    carried: string[];
    warnings: string[];
    parts: Array<{ record: string; lines: number; terms: number; questions: number }>;
}

/** Reads one part's record, its corrected transcript and its rows. */
async function loadPart(input: {
    store: MeetingStore;
    config: MeetingsPolishedConfig;
    index: number;
    /** The speaker diff's reason for a confirmed line that records none, in the meeting's language. */
    confirmed: string;
    linked?: (record: MeetingRecord) => LinkedSource;
}): Promise<{ part: LoadedPart; source: unknown }> {
    const { config, index } = input;
    const part = config.parts[index]!;
    const address = meetingAddress(input.store, part.record);

    if (!address) {
        throw new Error(`Part ${index + 1}: no meeting "${part.record}" (${toolCommand("meetings", "list")})`);
    }

    // A file written before a join names each recording: such a part reads its own recording, on its own clock.
    const named = new Set(config.parts.map((one) => one.record));
    const ownRecording =
        address.record.join &&
        address.record.join.parts.some((one) => one.record !== part.record && named.has(one.record))
            ? OpenedMeeting.of(input.store, address.record).recordingReading(part.record)
            : undefined;
    const store = ownRecording?.opened.store ?? input.store;
    const record = ownRecording?.opened.record ?? address.record;
    const opened = ownRecording?.opened ?? OpenedMeeting.of(store, record, input.linked?.(record));
    const [read, meeting, linked] = await Promise.all([
        correctedTranscriptRead({
            store,
            record,
            format: "md",
            opened,
            flags: {
                withSuggested: config.transcript.withSuggested,
                applyAbove: config.transcript.applyAbove / 100,
                playLinks: true,
                frontmatter: false,
                ...(config.transcript.dictionary === undefined ? {} : { dictionary: config.transcript.dictionary }),
            },
        }),
        opened.meeting(),
        opened.linked(),
    ]);
    const transcriptMd = (read.markdown?.markdown ?? "").replace(/^\s*# [^\n]*\n/, "").trim();
    const start = part.start ?? localTime(record.start);
    log.debug({ record: record.id, lines: meeting.transcript.length }, "polish: part read");

    return {
        part: {
            config: part,
            number: index + 1,
            record,
            transcriptMd,
            speakers: speakerRows(record, meeting.transcript, { confirmed: input.confirmed }),
            terms: termRows(record),
            questions: questionRows(record),
            sourceLabel: linked.source.label,
            start,
            end: part.end ?? (record.end ? localTime(record.end) : start),
        },
        // The input the stamp hashes: what the records say now, so a changed record reads as changed data.
        source: { record: record.id, items: record.items, speakers: record.speakers, transcript: meeting.transcript },
    };
}

/**
 * Builds a meeting's polished markdown from its `.polished.ts` and the live records (`tools meetings polish build`):
 * the corrected transcript of each part, the speaker and term diffs, lines per person by confidence band and the open
 * questions with their `Q<n>` numbers, around the authored sections. The markdown is stamped; a later build refuses to
 * overwrite it once someone edited it by hand (`force` overrides). Never writes the module or a record.
 */
export async function buildPolished(options: {
    file: string;
    mode?: PolishMode;
    force?: boolean;
    store?: MeetingStore;
    /** Each record's source, when the caller holds it already (a test's fake one); else its linked source. */
    linked?: (record: MeetingRecord) => LinkedSource;
    /** The meetings config whose language block gives the phrases; default the saved one. */
    meetingsConfig?: Pick<MeetingsConfig, "global" | "languages">;
}): Promise<PolishBuildResult> {
    const modulePath = isAbsolute(options.file) ? options.file : resolve(process.cwd(), options.file);
    const mode = options.mode ?? "write";
    const config = await loadPolishedModule(modulePath);
    const outPath = polishedOutPath(modulePath, config);
    const store = options.store ?? new MeetingStore();
    const language = polishedPhrasesOf(
        options.meetingsConfig ?? (await new MeetingsConfigStore().read()),
        config.language
    );
    const confirmed = config.phrases?.confirmed ?? language.phrases.confirmed;
    const loaded = await Promise.all(
        config.parts.map((_part, index) => loadPart({ store, config, index, confirmed, linked: options.linked }))
    );
    const parts = loaded.map((one) => one.part);
    const gate = linkGate();
    const times = new Map<string, PartTimes>(
        parts.map((part) => [
            part.config.token,
            {
                record: part.record.id,
                ...(part.config.marker ? { marker: part.config.marker } : {}),
                link: playLinksFor(part.record.id, gate).link,
            },
        ])
    );
    const rendered = renderPolished({
        config,
        parts,
        times,
        phrases: language.phrases,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    if (language.from === "english" && config.language !== undefined) {
        rendered.warnings.push(
            `The meetings config has no block languages.${language.code}: the phrases this file leaves out are the English ones.`
        );
    }

    const { extras: _extras, ...authored } = config;
    const sourceHash = hashData({
        config: authored,
        phrases: language.phrases,
        records: loaded.map((one) => one.source),
    });
    const build = async (generatedAt?: string) => ({
        markdown: stampMarkdown(rendered.markdown, {
            source: sourceHash,
            generator: relative(dirname(outPath), modulePath) || modulePath,
            generated: generatedAt ?? localTimestamp(),
            command: toolCommand("meetings polish build", portablePath(modulePath)),
        }),
        body: rendered.markdown,
        sourceHash,
    });
    const summary = parts.map((part) => ({
        record: part.record.id,
        lines: part.speakers.length,
        terms: part.terms.length,
        questions: part.questions.length,
    }));
    const base = { file: modulePath, outPath, mode, warnings: rendered.warnings, parts: summary };

    if (mode === "check") {
        const check = await checkGenerated({ outPath, build });
        log.debug({ file: modulePath, verdict: check.verdict }, "polish: check");
        return { ...base, check, carried: [] };
    }

    const written = await writeGenerated({ outPath, build, force: options.force, dryRun: mode === "dry-run" });
    log.debug({ file: modulePath, out: outPath, outcome: written.outcome }, "polish: build");
    return { ...base, outcome: written.outcome, check: written.check, carried: written.carried };
}
