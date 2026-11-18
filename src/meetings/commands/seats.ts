import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { nameKey } from "@genesiscz/utils/meetings/people";
import { type MeetingSeats, type RemoteSeat, roomSeatNames, seatSpan } from "@genesiscz/utils/meetings/seats";
import { shellWord } from "@genesiscz/utils/shell/quote";
import { createBoxTable } from "@genesiscz/utils/table";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { withMeetingsClient } from "../lib/service/client";
import { fail, TOOL } from "../lib/shared";
import { windowJson } from "../lib/window-reads";

interface Options {
    apply?: boolean;
    replace?: boolean;
    room?: string[];
    remote?: string[];
    json?: boolean;
}

function seatLabels(seats: MeetingSeats | null): Map<string, string> {
    const labels = new Map<string, string>();
    for (const side of ["room", "remote"] as const) {
        for (const row of seats?.[side] ?? []) {
            const seat: RemoteSeat = seatSpan(row);
            const bounds =
                seat.fromSec !== undefined || seat.toSec !== undefined
                    ? ` ${formatClock(seat.fromSec ?? 0)}–${seat.toSec === undefined ? "end" : formatClock(seat.toSec)}`
                    : "";
            const key = nameKey(seat.name);
            const label = `${side}${bounds}${seat.label ? ` (${seat.label})` : ""}`;
            labels.set(key, [labels.get(key), label].filter(Boolean).join(", "));
        }
    }

    return new Map([...labels].map(([key, list]) => [key, list.join(", ")]));
}

function handChoice(options: { command: string; opts: Options; name: string; seat: "room" | "remote" }): string {
    const args = [options.command];
    for (const seat of ["room", "remote"] as const) {
        const names = [...(options.opts[seat] ?? [])];
        if (seat === options.seat) {
            names.push(options.name);
        }
        if (names.length) {
            args.push(`--${seat}`, ...names.map(shellWord));
        }
    }
    return args.join(" ");
}

async function seats(ref: string, opts: Options): Promise<void> {
    try {
        const report = await withMeetingsClient(async (client) => {
            const view = await client.call("meeting.seats.suggest", {
                meeting: ref,
                room: opts.room,
                remote: opts.remote,
            });
            const { suggestion, current, meeting } = view;
            let saved = false;
            const write = opts.apply || opts.replace || opts.room || opts.remote;
            const hasSeats = suggestion.seats.room.length > 0 || suggestion.seats.remote.length > 0;
            if (write && hasSeats && (!current || opts.replace)) {
                await client.call("decision.apply", {
                    meeting,
                    action: { kind: "set", seats: suggestion.seats, ...(opts.replace ? {} : { seatsIfAbsent: true }) },
                });
                saved = true;
            }
            const command = `${TOOL} seats ${shellWord(meeting)} ${current || saved ? "--replace" : "--apply"}`;
            const unresolved = suggestion.people
                .filter((p) => p.seat === "unsure")
                .map(({ name }) => ({
                    name,
                    room: handChoice({ command, opts, name, seat: "room" }),
                    remote: handChoice({ command, opts, name, seat: "remote" }),
                }));
            return { ...view, saved, unresolved };
        });
        if (opts.json) {
            out.result(windowJson(report));
            return;
        }
        const current = seatLabels(report.current);
        const suggested = seatLabels(report.suggestion.seats);
        const table = createBoxTable(["PERSON", "CURRENT", "SUGGESTED", "REASON"]);
        const listed = new Set<string>();
        for (const person of report.suggestion.people) {
            const key = nameKey(person.name);
            listed.add(key);
            table.push([person.name, current.get(key) ?? "—", suggested.get(key) ?? person.seat, person.reason]);
        }
        for (const name of [
            ...roomSeatNames(report.current ?? undefined),
            ...(report.current?.remote.map((seat) => seat.name) ?? []),
        ]) {
            if (!listed.has(nameKey(name))) {
                listed.add(nameKey(name));
                table.push([name, current.get(nameKey(name)) ?? "—", "—", "Only in the saved seats."]);
            }
        }
        if (!report.current) {
            out.println("Current seats: not set");
        }
        out.println(table.toString());
        for (const mic of report.current?.microphones ?? []) {
            out.println(`Current microphone ${mic.label ?? mic.id}: ${mic.people.join(", ")}`);
        }
        for (const person of report.unresolved) {
            out.println(`${person.name}: ${person.room}\n  or: ${person.remote}`);
        }
        if (report.saved) {
            ui.ok("Saved seats.");
        } else if (report.current && (opts.apply || opts.room || opts.remote)) {
            ui.info(`Kept saved seats. To replace them, add --replace.`);
        } else if (!report.suggestion.seats.room.length && !report.suggestion.seats.remote.length) {
            ui.info("No seats to apply. Choose a person with --room or --remote.");
        }
    } catch (error) {
        fail(error);
    }
}

export function registerSeatsCommand(program: Command): void {
    program
        .command("seats <meeting>")
        .description("Suggest room and remote seats and explain each choice")
        .option("--apply", "save when seats have not been set")
        .option("--replace", "save even when seats are already set")
        .option("--room <names...>", "seat these people in the room and apply")
        .option("--remote <names...>", "seat these people on the call and apply")
        .option("--json", "print the preview and save result as JSON")
        .action(seats);
}
