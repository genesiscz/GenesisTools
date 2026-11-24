import type { LineVoice } from "@genesiscz/utils/meetings/voice-features";
import { localSpeechDuring } from "./local-speech";
import type { OpenedMeeting } from "./opened-meeting";
import { rawMeeting } from "./raw";
import { DEFAULT_SCREEN_LINES, openScreenRecord, screenRecordFacts, withScreenLines } from "./screen-leads";
import { rawTerms } from "./suggest-terms";
import { lineDeviceCandidates } from "./voice";
import { voiceReadiness } from "./voice-readiness";
import type { WordCheckChoice } from "./word-check";

export interface RawEvidenceOptions {
    /** Who was in the call and when: a platform or its export file (`--attendance`). */
    attendance?: string;
    /** The word check of the term part (`--word-check`); absent, each language uses its own. */
    wordCheck?: WordCheckChoice;
    /** Screen lines per term lead (`--screen-lines`); 0 names the screen record and gives no lines. */
    screenLines?: number;
    /** Each line's measured voice, by line index (`--voices`, `--voice-features`). */
    voice?: Map<number, LineVoice>;
}

/** A line with its voice features and the people its device can name, as both JSON outputs of `evidence` give it. */
export function withDeviceFacts<L extends { index: number }>(options: {
    line: L;
    device: Parameters<typeof lineDeviceCandidates>[0];
    voice?: Map<number, LineVoice>;
}) {
    return {
        ...options.line,
        ...(options.voice ? { voiceFeatures: options.voice.get(options.line.index) } : {}),
        deviceCandidates: lineDeviceCandidates(options.device),
    };
}

/**
 * `evidence --raw`: the facts of a meeting for an agent to reason over (decision 33 a), with the term leads, the
 * screen lines near each, the screen record they come from, and the voice readiness.
 */
export async function rawEvidence(opened: OpenedMeeting, options: RawEvidenceOptions = {}) {
    // A meeting without a transcript source fails in linked() with [no-transcript-source], as every command does.
    await opened.linked();
    const meeting = await opened.meeting();
    const found = await opened.evidence();
    const presence = await opened.presence(options.attendance);
    const energy = await opened.energy();
    const current = opened.record;
    const check = await opened.wordCheck(options.wordCheck);

    try {
        const linesPerLead = options.screenLines ?? DEFAULT_SCREEN_LINES;
        const read = await openScreenRecord(opened.store, current);
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
            terms: read && linesPerLead > 0 ? withScreenLines(terms, { read, linesPerLead }) : terms,
            screen: screenRecordFacts({ id: current.id, read, linesPerLead }),
            people: (await opened.config()).projects[current.project ?? ""]?.match?.people,
        });
        return {
            ...raw,
            voice: voiceReadiness(current),
            lines: raw.lines.map((line) =>
                withDeviceFacts({
                    line,
                    device: {
                        record: current,
                        atSec: line.fromSec,
                        micShare: Math.max(line.energyMicShare ?? 0, line.channel.micShare ?? 0),
                        liveName: line.liveName,
                    },
                    voice: options.voice,
                })
            ),
        };
    } finally {
        check.check?.dispose();
    }
}
