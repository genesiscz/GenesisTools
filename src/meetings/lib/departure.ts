import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, type SpeakerHint, sameName } from "@genesiscz/utils/transcribe/speakers";

export interface IdentifiedDeparture {
    name: string;
    atSec: number;
    label?: string;
    reason: "indicator" | "attendance" | "sole-remote";
}

/** Resolve a goodbye independently of the diarizer label. Ambiguous identity remains unresolved. */
export function identifiedDepartures(options: {
    hints: SpeakerHint[];
    lines: LineEvidence[];
    selfName: string;
    presence?: Presence[];
    ignoredIndicator?: Set<number>;
}): IdentifiedDeparture[] {
    const departures: IdentifiedDeparture[] = [];
    for (const hint of options.hints) {
        if (hint.kind !== "leave-then-continues") {
            continue;
        }
        for (const leave of hint.leaves) {
            const line = options.lines.find((value) => value.startSec === leave.atSec);
            if (!line || (line.energyMic ?? line.micShare ?? 1) >= 0.35) {
                continue;
            }
            const present = options.presence?.filter(
                (stay) =>
                    !stay.self &&
                    !sameName(stay.name, options.selfName) &&
                    stay.fromSec <= leave.atSec &&
                    stay.toSec >= leave.atSec - 5
            );
            const candidates = [
                ...new Set(
                    present?.map((stay) => stay.name) ??
                        Object.keys(line.speaking).filter((name) => !sameName(name, options.selfName))
                ),
            ];
            const shown = options.ignoredIndicator?.has(line.index)
                ? []
                : candidates.filter((name) => Object.keys(line.speaking).some((other) => sameName(name, other)));
            const leaving =
                present
                    ?.filter((stay) => stay.leftAtExact !== false && Math.abs(stay.toSec - leave.atSec) <= 15)
                    .map((stay) => stay.name) ?? [];
            const name =
                leaving.length === 1
                    ? leaving[0]
                    : shown.length === 1
                      ? shown[0]
                      : candidates.length === 1
                        ? candidates[0]
                        : undefined;
            if (!name || sameName(name, options.selfName)) {
                continue;
            }
            departures.push({
                name,
                atSec: leave.atSec,
                ...(sameName(name, hint.label) ? { label: hint.label } : {}),
                reason: leaving.length === 1 ? "attendance" : shown.length === 1 ? "indicator" : "sole-remote",
            });
        }
    }
    return departures;
}
