import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { lookMeeting } from "../lib/look";
import { fail } from "../lib/shared";

function renderLook(answer: Awaited<ReturnType<typeof lookMeeting>>): string {
    const span = (from: number, to: number) => `${formatClock(from)}–${formatClock(to)}`;
    const rows = [`${answer.meeting}  ${span(answer.fromSec, answer.toSec)}`, "", "Transcript"];
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
            `#${line.index}  ${span(line.fromSec, line.toSec)}  ${line.label} [${details.join(", ")}]  ${line.text}`
        );
    }

    rows.push(
        "",
        "Attendance",
        ...(answer.attendance?.map((stay) => `${span(stay.fromSec, stay.toSec)}  ${stay.name}`) ?? [
            "Attendance unavailable",
        ])
    );
    rows.push("", "Open questions", ...answer.questions.map((question) => `${question.id}  ${question.what}`));
    rows.push(
        "",
        "Items",
        ...answer.items.map((item) => `${formatClock(item.atSec)}  ${item.id}  ${item.status}  ${item.what}`)
    );
    rows.push(
        "",
        "Screen text",
        ...(answer.screen?.map((frame) =>
            [
                `${formatClock(frame.atSec)}${frame.displayId === undefined ? "" : `  display ${frame.displayId}`}`,
                ...frame.added.map((line) => `+ ${line}`),
                ...frame.removed.map((line) => `- ${line}`),
            ].join("\n")
        ) ?? ["Screen text unavailable"])
    );
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
