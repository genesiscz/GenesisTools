import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { escapeTerminalControls } from "@genesiscz/utils/string";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { lookMeeting } from "../lib/look";
import { fail } from "../lib/shared";

export function renderLook(answer: Awaited<ReturnType<typeof lookMeeting>>): string {
    const safe = escapeTerminalControls;
    const span = (from: number, to: number) => `${formatClock(from)}–${formatClock(to)}`;
    const rows = [`${safe(answer.meeting)}  ${span(answer.fromSec, answer.toSec)}`, "", "Transcript"];
    for (const line of answer.lines) {
        const mic = typeof line.micShare === "number" ? `${Math.round(100 * line.micShare)}%` : line.micShare;
        const details = [`mic ${mic ?? "unmeasured"}`];
        if (line.suggestedName) {
            details.push(`suggested ${line.suggestedName}`);
        }

        if (line.confirmedName || line.confirmedVoices?.length) {
            details.push(`confirmed ${line.confirmedName ?? line.confirmedVoices?.join(" + ")}`);
        }

        if (line.voice) {
            details.push(
                `voice ${line.voice.person ?? line.voice.candidate ?? "unknown"} (${line.voice.quality}, score ${line.voice.score ?? "unknown"})`
            );
        }

        if (line.echoPair) {
            details.push(`echo of line ${line.echoPair.micLineIndex}, ${line.echoPair.lagMs} ms later`);
        }

        rows.push(
            `#${line.index}  ${span(line.fromSec, line.toSec)}  ${safe(line.label)} [${safe(details.join(", "))}]  ${safe(line.text)}`
        );
    }

    rows.push("", "Attendance");
    if (answer.attendance === null) {
        rows.push("Attendance unavailable");
    } else {
        for (const stay of answer.attendance) {
            rows.push(`${span(stay.fromSec, stay.toSec)}  ${safe(stay.name)}`);
        }
    }
    rows.push("", "Open questions");
    for (const question of answer.questions) {
        rows.push(`${safe(question.id)}  ${safe(question.what)}`);
    }
    rows.push("", "Items");
    for (const item of answer.items) {
        rows.push(`${formatClock(item.atSec)}  ${safe(item.id)}  ${item.status}  ${safe(item.what)}`);
    }
    rows.push("", "Screen text");
    if (answer.screen === null) {
        rows.push("Screen text unavailable");
    } else {
        for (const frame of answer.screen) {
            rows.push(
                `${formatClock(frame.atSec)}${frame.displayId === undefined ? "" : `  display ${frame.displayId}`}`
            );
            for (const line of frame.added) {
                rows.push(`+ ${safe(line)}`);
            }
            for (const line of frame.removed) {
                rows.push(`- ${safe(line)}`);
            }
        }
    }
    return rows.join("\n");
}

export function registerLookCommand(program: Command): void {
    program
        .command("look <meeting>")
        .description("Read transcript, speaker evidence, attendance, review items and screen text in one time range")
        .requiredOption("--from <time>", "first time, inclusive (seconds, MM:SS or H:MM:SS)")
        .requiredOption("--to <time>", "last time, inclusive (seconds, MM:SS or H:MM:SS)")
        .option("--json", "print JSON")
        .action(async (meeting: string, opts: { from: string; to: string; json?: boolean }) => {
            try {
                const result = await lookMeeting(new MeetingStore(), { meeting, from: opts.from, to: opts.to });
                if (opts.json) {
                    out.result(SafeJSON.stringify(result, null, 2));
                } else {
                    out.print(`${renderLook(result)}\n`);
                }
            } catch (error) {
                fail(error);
            }
        });
}
