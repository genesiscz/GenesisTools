import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";

export type LabelItem = Extract<MeetingItem, { kind: "label" }>;

/** The label items a rule run honours: every one a person has not rejected. */
export function unlabeledStretches(items: MeetingItem[]): LabelItem[] {
    return items.filter((item): item is LabelItem => item.kind === "label" && item.status !== "rejected");
}

/** Whether a line of `label` starting at `sec` lies in one of the stretches. */
export function inStretch(stretches: LabelItem[], label: string, sec: number | undefined): LabelItem | undefined {
    return sec === undefined
        ? undefined
        : stretches.find((stretch) => stretch.label === label && sec >= stretch.fromSec && sec <= stretch.toSec);
}

/**
 * The meeting as the speaker rules see it when some labels track no one person in a stretch: each such stretch's
 * lines carry a label of their own that names nobody (`Unlabeled 1`), so no rule takes the label as a hint of who
 * speaks. `restore` gives an item found on such a label its source label back, so corrections and questions anchor it.
 */
export function unlabeledView(
    meeting: SourceMeeting,
    stretches: LabelItem[]
): { meeting: SourceMeeting; restore: <T extends { kind: string }>(item: T) => T } {
    if (stretches.length === 0) {
        return { meeting, restore: (item) => item };
    }

    const sourceOf = new Map<string, string>();
    const syntheticOf = new Map<LabelItem, string>();
    const transcript = meeting.transcript.map((entry) => {
        const stretch = inStretch(stretches, entry.speaker, entry.startSec);

        if (!stretch) {
            return entry;
        }

        let synthetic = syntheticOf.get(stretch);

        if (!synthetic) {
            synthetic = `Unlabeled ${syntheticOf.size + 1}`;
            syntheticOf.set(stretch, synthetic);
            sourceOf.set(synthetic, stretch.label);
        }

        return { ...entry, speaker: synthetic };
    });

    return {
        meeting: { ...meeting, transcript },
        restore: (item) => {
            const label = "label" in item && typeof item.label === "string" ? sourceOf.get(item.label) : undefined;
            const restored = label ? { ...item, label } : item;

            // A join's voice that is the synthetic unlabeled speaker is no voice at all: the join keeps the line's own.
            if (
                restored.kind === "join" &&
                "speaker" in restored &&
                typeof restored.speaker === "string" &&
                sourceOf.has(restored.speaker)
            ) {
                return { ...restored, speaker: undefined };
            }

            return restored;
        },
    };
}
