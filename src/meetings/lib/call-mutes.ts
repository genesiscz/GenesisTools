import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";

/** A muted participant can still be heard on a room microphone. Only a call line rules them out. */
export function callMutes(line: LineEvidence): readonly string[] {
    return (line.energyMic ?? line.micShare ?? 1) < 0.5 ? (line.muted ?? []) : [];
}

/** The same veto for a question, its proposed speaker range, and a sampled clip. */
export class MutedCallLines {
    private readonly muted = new Map<number, readonly string[]>();
    private readonly byLabel = new Map<string, LineEvidence[]>();

    constructor(lines: readonly LineEvidence[]) {
        if (!lines.some((line) => callMutes(line).length)) {
            return;
        }
        for (const line of lines) {
            const names = callMutes(line);
            if (names.length) {
                this.muted.set(line.index, names);
            }
            const group = this.byLabel.get(line.label) ?? [];
            group.push(line);
            this.byLabel.set(line.label, group);
        }
    }

    forIndices(indices: number[]): readonly string[] {
        const first = indices[0];
        const names = first === undefined ? [] : (this.muted.get(first) ?? []);
        if (indices.length < 2) {
            return names;
        }
        return names.filter((name) =>
            indices.every((index) => this.muted.get(index)?.some((other) => sameName(name, other)))
        );
    }

    forRange(range: {
        label: string;
        fromSec: number;
        toSec: number;
        evidence?: Record<string, unknown>;
    }): readonly string[] {
        if (!this.muted.size) {
            return [];
        }
        if (typeof range.evidence?.transcriptLine === "number") {
            return this.muted.get(range.evidence.transcriptLine) ?? [];
        }
        const lines = this.byLabel.get(range.label) ?? [];
        return this.forIndices(
            lines
                .filter((line) => line.startSec >= range.fromSec && line.startSec <= range.toSec)
                .map((line) => line.index)
        );
    }
}
