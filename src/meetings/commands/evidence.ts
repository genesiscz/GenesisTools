import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable } from "@genesiscz/utils/table";
import { labelIdentityTable, lineEvidence, SELF } from "@genesiscz/utils/transcribe/evidence";
import { parseClock } from "@genesiscz/utils/transcribe/render";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { Command } from "commander";
import pc from "picocolors";
import { channelEvidence } from "../lib/channel-operation";
import { localSpeechDuring } from "../lib/local-speech";
import { OpenedMeeting } from "../lib/opened-meeting";
import { compactEvidence, rawMeeting } from "../lib/raw";
import { fail, formatFlag, resolveEnum, TOOL } from "../lib/shared";
import { rawTerms } from "../lib/suggest";
import { lineDeviceCandidates, meetingVoices } from "../lib/voice";
import { DEFAULT_WORD_CHECK, WORD_CHECKS } from "../lib/word-check";

const FORMATS = ["table", "json", "lines"] as const;
/** The user's microphone recognized this many times more words than their own label holds: they are spread over others. */
const VOLUME_RATIO = 2;
/** A line this sure on the microphone is the user's (the energy rule). */
const SURE_MIC = 0.9;
/** With the energy: the user is spread when this share of their label's words, and this many at least, sit elsewhere. */
const SPREAD_SHARE = 0.25;
const SPREAD_MIN_WORDS = 30;

async function evidence(
    ref: string,
    opts: {
        attendance?: string;
        format?: string | boolean;
        json?: boolean;
        files?: boolean;
        raw?: boolean;
        table?: boolean;
        from?: string;
        to?: string;
        wordCheck?: string;
        voices?: string;
        voiceFeatures?: boolean;
        channel?: string;
    }
): Promise<void> {
    const flag = formatFlag(opts);

    if (!flag) {
        return;
    }

    const format = await resolveEnum({
        value: flag.format,
        fallback: "table",
        values: FORMATS,
        flag: "--format",
        subcommand: ["evidence"],
    });
    const store = new MeetingStore();

    if (!format) {
        return;
    }

    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        // A meeting without a transcript source fails in linked() with [no-transcript-source], as every command does.
        const opened = OpenedMeeting.of(store, record);
        // The voice measurement decodes the whole recording: only when asked for, and only into an output that shows it.
        const wantsVoice = opts.voiceFeatures === true || opts.voices !== undefined;
        if (wantsVoice && (opts.table || (format === "table" && !opts.raw))) {
            throw new Error("--voices and --voice-features print with --format json, --format lines or --raw");
        }

        if (opts.table) {
            const from = opts.from === undefined ? 0 : (parseClock(opts.from) ?? NaN);
            const to = opts.to === undefined ? Infinity : (parseClock(opts.to) ?? NaN);
            if (!Number.isFinite(from) || Number.isNaN(to) || from < 0 || to < from) {
                throw new Error("--from/--to need ordered, nonnegative seconds");
            }
            const raw = await channelEvidence(opened, { fromSec: from, toSec: to });
            out.print(`${compactEvidence(raw)}\n`);
            return;
        }
        const { source } = await opened.linked();
        const meeting = await opened.meeting();
        const found = await opened.evidence();

        const presence = await opened.presence(opts.attendance);
        const energy = await opened.energy();
        const voice = wantsVoice
            ? new Map(
                  (
                      await meetingVoices({
                          opened,
                          voices: opts.voices === undefined ? undefined : Number(opts.voices),
                          channel: opts.channel === undefined ? undefined : Number(opts.channel),
                      })
                  ).map((measured) => [measured.index, measured])
              )
            : undefined;

        // The facts only, for an agent to reason over (decision 33 a): JSON whatever --format says.
        if (opts.raw || format === "lines") {
            // Without --word-check each language uses its own provider (`languages.<code>.wordCheck`).
            const choice =
                opts.wordCheck === undefined
                    ? undefined
                    : await resolveEnum({
                          value: opts.wordCheck,
                          values: WORD_CHECKS,
                          flag: "--word-check",
                          subcommand: ["evidence"],
                      });

            if (opts.wordCheck !== undefined && !choice) {
                return;
            }

            const current = opened.record;
            const check = await opened.wordCheck(choice);

            try {
                const terms = rawTerms({
                    meeting,
                    record: current,
                    dictionary: await opened.dictionary(),
                    sourceWords: await opened.sourceWords(),
                    ...(check.check ? { wordCheck: check.check } : { unavailable: check.reason }),
                });
                const raw = rawMeeting({
                    localSpeech: localSpeechDuring({ start: meeting.start, end: meeting.end }),
                    record: current,
                    meeting,
                    evidence: found,
                    presence,
                    energyMicShare: energy.share,
                    callSilent: await opened.silentCallSpans(),
                    points: await opened.summaryPoints(),
                    terms,
                    people: (await opened.config()).projects[current.project ?? ""]?.match?.people,
                });
                const enriched = {
                    ...raw,
                    lines: raw.lines.map((line) => ({
                        ...line,
                        ...(voice ? { voiceFeatures: voice.get(line.index) } : {}),
                        deviceCandidates: lineDeviceCandidates({
                            record: current,
                            atSec: line.fromSec,
                            micShare: Math.max(line.energyMicShare ?? 0, line.channel.micShare ?? 0),
                            liveName: line.liveName,
                        }),
                    })),
                };
                out.result(format === "lines" ? compactEvidence(enriched) : SafeJSON.stringify(enriched, null, 2));
            } finally {
                check.check?.dispose();
            }

            return;
        }

        if (!found) {
            fail(`${source.label} keeps no speaker evidence for this meeting on this Mac.`);
            return;
        }

        const lines = lineEvidence(meeting.transcript, found, presence, energy.share);
        const selfLabelWords = meeting.transcript
            .filter((entry) => found.selfName && sameName(entry.speaker, found.selfName))
            .reduce((sum, entry) => sum + entry.text.split(/\s+/).filter(Boolean).length, 0);
        // With a calibrated channel layout the energy says where the user is: the microphone channel's own word count
        // also holds the call heard through the room, so it called a label right on 52 of 55 clear lines "spread" (MC12).
        const calibrated = energy.calibration !== undefined && energy.calibration.layout !== "unknown";
        const sureMicElsewhere = calibrated
            ? lines
                  .filter(
                      (line) =>
                          !(found.selfName && sameName(line.label, found.selfName)) && (line.energyMic ?? 0) >= SURE_MIC
                  )
                  .reduce((sum, line) => sum + line.text.split(/\s+/).filter(Boolean).length, 0)
            : undefined;
        const volume = found.tokens
            ? {
                  micTokens: found.tokens.mic,
                  selfLabelWords,
                  ...(sureMicElsewhere !== undefined ? { sureMicWordsElsewhere: sureMicElsewhere } : {}),
                  spread:
                      sureMicElsewhere !== undefined
                          ? sureMicElsewhere >= Math.max(SPREAD_MIN_WORDS, SPREAD_SHARE * selfLabelWords)
                          : found.tokens.mic >= VOLUME_RATIO * Math.max(1, selfLabelWords),
              }
            : undefined;

        if (format === "json") {
            out.result(
                SafeJSON.stringify(
                    {
                        meeting: record.id,
                        selfName: found.selfName,
                        indicator: {
                            knownLines: lines.filter((line) => !line.speakingUnknown).length,
                            unknownLines: lines.filter((line) => line.speakingUnknown).length,
                        },
                        volume:
                            record.seats && record.seats.room.length > 1
                                ? { ...volume, spread: false, sharedMic: true }
                                : volume,
                        channels: energy.calibration ?? null,
                        files: found.files,
                        devices: found.devices,
                        lines: lines.map((line) => {
                            const deviceCandidates = lineDeviceCandidates({
                                record,
                                atSec: line.startSec,
                                micShare: Math.max(line.energyMic ?? 0, line.micShare ?? 0),
                                liveName: line.liveName,
                            });
                            // A shared device names no winner: several people speak into it, whatever the share.
                            const shared =
                                deviceCandidates.length > 1 || (line.winner === SELF && sharedOwnMicrophone(record));
                            return {
                                ...line,
                                ...(voice ? { voiceFeatures: voice.get(line.index) } : {}),
                                deviceCandidates,
                                winner: shared ? undefined : line.winner,
                            };
                        }),
                    },
                    null,
                    2
                )
            );
            return;
        }

        const table = labelIdentityTable(lines);
        const identities = [...new Set([...table.values()].flatMap((row) => [...row.keys()]))].sort((a, b) =>
            a === SELF ? -1 : b === SELF ? 1 : a.localeCompare(b)
        );
        const view = createBoxTable([
            "LABEL \\ VOICE",
            ...identities.map((name) =>
                name === SELF
                    ? record.seats && record.seats.room.length > 1
                        ? `microphone group (${record.seats.room.join(", ")})`
                        : `you (${found.selfName ?? "mic"})`
                    : name
            ),
        ]);

        for (const [label, row] of table) {
            view.push([pc.white(label), ...identities.map((name) => String(row.get(name) ?? ""))]);
        }

        out.println(view.toString());
        ui.dim(
            `${lines.length} lines · ${found.segments.length} channel segments · ${found.speaking.length} speaking readings · ${lines.filter((line) => line.speakingUnknown).length} lines with unknown indicator · ${lines.filter((line) => line.tie).length} ties (two voices equal) · "?" = no channel segment overlaps the line`
        );

        const channels = energy.calibration;

        if (!channels) {
            ui.dim("audio energy: not checked (no audio on this Mac, or ffmpeg is missing)");
        } else if (channels.layout === "unknown") {
            ui.warn(`audio energy: not used, the microphone channel is unknown: ${channels.reason}`);
        } else {
            ui.dim(
                `audio energy: ${channels.layout} (mic segments median left share ${channels.micMedian}, call ${channels.systemMedian}; ${channels.segments.mic} + ${channels.segments.system} segments)`
            );
        }

        if (record.seats && record.seats.room.length > 1) {
            ui.dim("A shared microphone identifies its active people as candidates, not its owner as speaker.");
        } else if (volume) {
            const say =
                volume.sureMicWordsElsewhere !== undefined
                    ? `${volume.sureMicWordsElsewhere} words are sure on your microphone under other labels; your label "${found.selfName}" holds ${volume.selfLabelWords}`
                    : `your microphone recognized ${volume.micTokens} words; your label "${found.selfName}" holds ${volume.selfLabelWords}`;
            volume.spread
                ? ui.warn(
                      `${say}: you are spread over other labels (${toolCommand("meetings", "suggest", record.id, "--rules", "evidence")})`
                  )
                : ui.dim(say);
        }

        if (opts.files) {
            for (const file of found.files) {
                ui.dim(`  ${file.name} ${formatBytes(file.bytes)}`);
            }
        }
    } catch (err) {
        fail(err);
    }
}

/** More than one person speaks into the owner's microphone: its microphone group, else the room seats. */
function sharedOwnMicrophone(record: MeetingRecord): boolean {
    const group = record.seats?.microphones?.find((one) => one.id === "self");
    return (group?.people.length ?? record.seats?.room.length ?? 0) > 1;
}

export function registerEvidenceCommand(program: Command): void {
    program
        .command("evidence")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description("Which voice each label's lines are, by audio channel and the platform's speaking indicator")
        .option(
            "--attendance <platform|file>",
            "who was in the call and when: a platform (teams) or its export file (teams:<file>)"
        )
        .option("--voice-features", "measure RMS, low-band share, tilt and pitch for both physical audio channels")
        .option("--voices <n>", "cluster lines into 1..16 voices, anchored by confirmed assignments")
        .option("--channel <0|1>", "physical clustering channel, default calibrated mic channel or left when unknown")
        .option("--files", "also list the evidence files and their sizes")
        .option("--table", "compact per-line evidence table")
        .option("--from <seconds>", "table start time")
        .option("--to <seconds>", "table end time")
        .option(
            "--raw",
            "the facts per line as JSON, with no rule or confidence: who, channel, platform, present, terms, summary"
        )
        .option(
            "--word-check <provider>",
            `--raw: ${WORD_CHECKS.join(" | ")} for the term part (default: each language's languages.<code>.wordCheck, else ${DEFAULT_WORD_CHECK})`
        )
        .option("--format [format]", "table | json | lines (compact per-line facts with a name legend)")
        .option("--json", "the same as --format json")
        .action(evidence);
}
