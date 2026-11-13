import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";

export interface IndicatorAssessment {
    ignored: Set<number>;
    candidates: Array<{ name: string; fromSec: number }>;
    reasons: Map<number, "meeting-dominance" | "stretch-stuck">;
    dominant?: { name: string; share: number };
}

/** One assessment for E3 consumers. Unknown reads never count as a repeatedly lit indicator. */
export function assessIndicator(options: {
    lines: LineEvidence[];
    selfName: string;
    roomPeople?: readonly string[];
}): IndicatorAssessment {
    const { lines, selfName } = options;
    const remote = (name: string) =>
        !sameName(name, selfName) && !options.roomPeople?.some((person) => sameName(name, person));
    const ignored = new Set<number>();
    const reasons: IndicatorAssessment["reasons"] = new Map();
    const countsAll = new Map<string, number>();
    for (const line of lines) {
        for (const name of Object.keys(line.speaking)) {
            countsAll.set(name, (countsAll.get(name) ?? 0) + 1);
        }
    }
    const top = [...countsAll].sort((a, b) => b[1] - a[1])[0];
    const dominant =
        top && lines.length >= 20 && top[1] / lines.length > 0.8
            ? { name: top[0], share: top[1] / lines.length }
            : undefined;
    if (dominant) {
        for (const line of lines) {
            ignored.add(line.index);
            reasons.set(line.index, "meeting-dominance");
        }
    }
    const firstSeen = new Map<string, number>();
    for (const line of lines) {
        for (const name of [...Object.keys(line.speaking), ...(line.present ?? [])]) {
            if (remote(name)) {
                firstSeen.set(name, Math.min(firstSeen.get(name) ?? Infinity, line.startSec));
            }
        }
    }
    const candidates = [...firstSeen].map(([name, fromSec]) => ({ name, fromSec }));
    const boundaries = [
        ...new Set([
            0,
            ...candidates.map((person) => person.fromSec),
            ...lines.flatMap((line, i) => {
                const previous = lines[i - 1];
                return previous && (previous.present ?? []).join("|") !== (line.present ?? []).join("|")
                    ? [line.startSec]
                    : [];
            }),
            Infinity,
        ]),
    ].sort((a, b) => a - b);
    for (let i = 0; i + 1 < boundaries.length; i += 1) {
        const stretch = lines.filter((line) => line.startSec >= boundaries[i]! && line.startSec < boundaries[i + 1]!);
        if (stretch.length < 20 || stretch.at(-1)!.endSec - stretch[0]!.startSec < 360) {
            continue;
        }
        const call = stretch.filter((line) => (line.energyMic ?? line.micShare ?? 1) <= 0.35);
        const counts = new Map<string, number>();
        for (const line of call) {
            for (const name of Object.keys(line.speaking)) {
                if (remote(name)) {
                    counts.set(name, (counts.get(name) ?? 0) + 1);
                }
            }
        }
        const dominant = [...counts].sort((a, b) => b[1] - a[1])[0];
        const activeRemotes =
            stretch[0]!.present?.filter(remote) ??
            candidates.filter((person) => person.fromSec <= stretch[0]!.startSec).map((person) => person.name);
        const mic = stretch.filter((line) => (line.energyMic ?? line.micShare ?? 0) >= 0.9).length;
        if (
            dominant &&
            call.length >= 5 &&
            dominant[1] / call.length >= 0.9 &&
            (activeRemotes.length >= 2 || mic / stretch.length >= 0.35)
        ) {
            for (const line of stretch) {
                ignored.add(line.index);
                if (!reasons.has(line.index)) {
                    reasons.set(line.index, "stretch-stuck");
                }
            }
        }
    }
    return { ignored, candidates, reasons, ...(dominant ? { dominant } : {}) };
}
