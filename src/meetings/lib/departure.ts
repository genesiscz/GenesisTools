import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { isLeavePhrase, type Presence, type SpeakerHint, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { LineLabel } from "./speaker-labels/types";

export interface IdentifiedDeparture {
    name: string;
    atSec: number;
    label?: string;
    reason: "indicator" | "attendance" | "sole-remote" | "voice";
}

/** Named call-channel matches from this pass, or saved proposals that still address the same source line. */
export function matchedCallVoices(
    record: MeetingRecord,
    lines: readonly LineEvidence[],
    labels?: readonly LineLabel[]
): Map<number, string> {
    if (labels) {
        return new Map(
            labels.flatMap((label) =>
                label.seat === "call" && label.labeler === "voice" && label.reason === "named" && label.person
                    ? [[label.index, label.person] as const]
                    : []
            )
        );
    }
    const byIndex = new Map(lines.map((line) => [line.index, line]));
    const names = new Map<number, string>();
    for (const item of record.items) {
        if (
            item.kind !== "speaker-range" ||
            item.status === "rejected" ||
            !item.speaker ||
            item.evidence?.labeler !== "voice" ||
            item.evidence.reason !== "named" ||
            item.evidence.seat !== "call"
        ) {
            continue;
        }
        const index = item.evidence.transcriptLine;
        const line = typeof index === "number" ? byIndex.get(index) : undefined;
        if (line && line.startSec === item.fromSec && line.label === item.label) {
            names.set(line.index, item.speaker);
        }
    }
    return names;
}

/** Resolve a goodbye independently of the diarizer label. Ambiguous identity remains unresolved. */
export function identifiedDepartures(options: {
    hints: SpeakerHint[];
    lines: LineEvidence[];
    selfName: string;
    presence?: Presence[];
    ignoredIndicator?: Set<number>;
    labels?: readonly LineLabel[];
    matchedVoices?: ReadonlyMap<number, string>;
    roomPeople?: readonly string[];
}): IdentifiedDeparture[] {
    const departures: IdentifiedDeparture[] = [];
    const hinted = new Map(
        options.hints.flatMap((hint) =>
            hint.kind === "leave-then-continues" ? hint.leaves.map((leave) => [leave.atSec, hint.label] as const) : []
        )
    );
    const remote = (name: string) =>
        !sameName(name, options.selfName) && !options.roomPeople?.some((person) => sameName(name, person));
    for (const line of options.lines) {
        const atSec = line.startSec;
        const label = hinted.get(atSec);
        if ((!label && !isLeavePhrase(line.text)) || (line.energyMic ?? line.micShare ?? 1) >= 0.35) {
            continue;
        }
        const present = options.presence?.filter(
            (stay) => !stay.self && remote(stay.name) && stay.fromSec <= atSec && stay.toSec >= atSec - 5
        );
        // An indicator assessed as stuck names nobody: not as the one shown speaking, and without attendance not as
        // the only candidate either, since then the candidates would come from that same indicator.
        const ignored = options.ignoredIndicator?.has(line.index) ?? false;
        const candidates = [
            ...new Set(present?.map((stay) => stay.name) ?? (ignored ? [] : Object.keys(line.speaking).filter(remote))),
        ];
        const shown = ignored
            ? []
            : candidates.filter((name) => Object.keys(line.speaking).some((other) => sameName(name, other)));
        const leaving =
            present
                ?.filter((stay) => stay.leftAtExact !== false && Math.abs(stay.toSec - atSec) <= 15)
                .map((stay) => stay.name) ?? [];
        const voice = options.labels?.find(
            (label) => label.labeler === "voice" && label.index === line.index && label.reason === "named"
        );
        const matched =
            voice?.person ??
            options.matchedVoices?.get(line.index) ??
            (line.voice?.quality === "matched" ? line.voice.person : undefined);
        const voiceName =
            matched && remote(matched) && (!options.presence || candidates.some((name) => sameName(name, matched)))
                ? matched
                : undefined;
        const name =
            leaving.length === 1
                ? leaving[0]
                : shown.length === 1
                  ? shown[0]
                  : candidates.length === 1
                    ? candidates[0]
                    : voiceName;
        if (!name || sameName(name, options.selfName)) {
            continue;
        }
        departures.push({
            name,
            atSec,
            ...(sameName(name, label ?? line.label) ? { label: label ?? line.label } : {}),
            reason:
                leaving.length === 1
                    ? "attendance"
                    : shown.length === 1
                      ? "indicator"
                      : candidates.length === 1
                        ? "sole-remote"
                        : "voice",
        });
    }
    return departures;
}
