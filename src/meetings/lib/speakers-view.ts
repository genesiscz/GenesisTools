import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { PresenceRange, SpeakerHint, SpeakerStats } from "@genesiscz/utils/transcribe/speakers";
import pc from "picocolors";

const ORIGIN_NOTE: Record<SpeakerHint["strength"], string> = {
    weak: " (a named label: weak)",
    normal: "",
    strong: " (a language model guessed this label: strong)",
};

function rangesText(ranges: PresenceRange[]): string {
    return ranges
        .map((range) => {
            const span =
                range.fromSec === range.toSec
                    ? formatClock(range.fromSec)
                    : `${formatClock(range.fromSec)}–${formatClock(range.toSec)}`;
            const present = range.present ? `, present: ${range.present.join(", ") || "nobody"}` : "";
            return `${span} (${range.lines} ${range.lines === 1 ? "line" : "lines"}${present})`;
        })
        .join("; ");
}

function hintText(hint: SpeakerHint, attendance: string): string {
    if (hint.kind === "label-drift") {
        return `${hint.person}: in the call but silent under their own label from ${formatClock(Math.max(0, hint.fromSec))} to ${formatClock(hint.toSec)} (${MeetingRule.LabelDrift}), so their voice is probably under other labels`;
    }

    if (hint.kind === "absent-speaker") {
        return `${hint.label}: speaks while ${hint.label} was not in the call (${attendance}), so these lines are someone else: ${rangesText(hint.ranges)}`;
    }

    if (hint.kind === "sole-attendee") {
        const person = hint.self ? `you (${hint.person})` : hint.person;
        return `${hint.label}: only ${person} was in the call (${attendance}), so these lines are ${person}: ${rangesText(hint.ranges)}`;
    }

    const note = ORIGIN_NOTE[hint.strength];

    if (hint.kind === "several-people") {
        return `${hint.label}: ${hint.spans} spans far apart and ${Math.round(hint.share * 100)} % of the speech, maybe several people${note}`;
    }

    if (hint.kind === "leave-then-continues") {
        const leaves = hint.leaves.map((leave) => {
            const said = `${formatClock(leave.atSec)} "${truncateDisplay(leave.text, 60)}" (speaks again at ${formatClock(leave.continuesAtSec)}`;

            if (leave.echoOf) {
                return `${said}; echoes ${leave.echoOf.label} at ${formatClock(leave.echoOf.atSec)}, so not that person)`;
            }

            return leave.confirmedBy
                ? `${said}; ${leave.confirmedBy} answered the goodbye)`
                : `${said}; nobody answered, maybe only an intention)`;
        });
        const joined = leaves.join("; ");
        return `${hint.label}: says goodbye and keeps speaking, so another voice follows each of: ${joined}${note}`;
    }

    const at = hint.atSec === undefined ? "" : ` at ${formatClock(hint.atSec)}`;
    const spoken = hint.spokenSec > 0 ? `, ${Math.round(hint.spokenSec)} s` : "";
    const join = hint.join ? `; "${hint.join.left}" + "${hint.join.right}" = "${hint.join.joined}"` : "";
    return `${hint.label}: one turn${spoken}${at} next to ${hint.neighbour}, maybe a split voice${join}`;
}

/** The speaker table and its hints, for any source: `tools meetings speakers` and `tools wisprflow meetings speakers`. */
export function printSpeakerStats(
    stats: SpeakerStats,
    options: {
        untimedHint?: string;
        /** Where the stays came from, as the hints name it: `Microsoft Teams attendance`. */
        attendance?: string;
        /** The meeting's renames (`speakers rename`): a renamed label reads `Speaker 2 → Tester A`. */
        renames?: Record<string, string>;
    } = {}
): void {
    const attendance = options.attendance ?? "attendance";
    const table = createBoxTable([
        "SPEAKER",
        "#",
        "ORIGIN",
        "TURNS",
        "LINES",
        "WORDS",
        "SPOKEN",
        "FIRST–LAST",
        "SPANS",
    ]);

    for (const stat of stats.speakers) {
        const range =
            stat.firstSec === undefined || stat.lastSec === undefined
                ? "—"
                : `${formatClock(stat.firstSec)}–${formatClock(stat.lastSec)}`;
        table.push([
            pc.white(options.renames?.[stat.label] ? `${stat.label} → ${options.renames[stat.label]}` : stat.label),
            stat.speakerId === undefined ? "—" : String(stat.speakerId),
            stat.origin === "unknown" ? "—" : stat.origin,
            String(stat.turns),
            String(stat.lines),
            String(stat.words),
            stats.timed ? formatClock(stat.spokenSec) : "—",
            range,
            stat.spans.map((span) => `${formatClock(span.fromSec)}–${formatClock(span.toSec)}`).join(", ") || "—",
        ]);
    }

    out.println(table.toString());

    if (!stats.timed) {
        ui.dim(
            `This source gives no time per line, so only counts are shown${options.untimedHint ? ` (${options.untimedHint})` : ""}.`
        );
    }

    for (const hint of stats.hints) {
        if (hint.strength === "weak") {
            ui.dim(hintText(hint, attendance));
        } else {
            ui.warn(hintText(hint, attendance));
        }
    }
}
