#!/usr/bin/env bun
/**
 * What the `ai-usage-poll` daemon costs, read back out of the day logs.
 *
 * WHY A LOG READER AND NOT A HARNESS. The daemon is registered with the task
 * scheduler and every tick is its own short-lived process (886 distinct pids
 * for 890 polls on 2026-09-15), so there is no resident thing to sample and a
 * synthetic run would measure a poll that nobody scheduled. The evidence that
 * exists is `[ai-usage] daemon poll starting` / `daemon poll completed`, which
 * carries `duration_ms`, in `~/.genesis-tools/logs/<day>.log`.
 *
 * WHY POLLS PER DAY IS THE WRONG METRIC HERE, AND THE TRAP THIS SCRIPT EXISTS
 * TO STOP. A day file counts polls only for the hours the laptop was awake.
 * 2026-09-15 holds 890 polls and 2026-09-17 was on pace for 1423, and the tick
 * was 60 s in both: the difference is 9.67 h of sleep across 33 gaps. So the
 * script prints the gap median and the time lost to long gaps beside every
 * count, and the per-hour rate is the number to compare.
 *
 * DUTY CYCLE IS NOT CPU. `duration_ms` is wall time, so `duty` is the share of
 * wall time spent inside a poll. It is an upper bound on one core's worth of
 * work and it is what the 2026-09-16 campaign row quotes; do not relabel it.
 *
 *   bun scripts/benchmarks/ai-usage/poll-duty.ts 2026-09-15 2026-09-18
 *
 * With no arguments it reads every `<day>.log` that has poll lines. Each day is
 * one row; pass `--split <ISO>` to cut the range at a commit's timestamp and
 * get a before/after pair instead (the three arms in docs/benchmarks-cpu.md
 * were produced with the two landing times of cfc1dc0b7 and bb07e6fa9).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";

interface Poll {
    started: number;
    durationMs: number | null;
    pid: number;
}

const START_MSG = "[ai-usage] daemon poll starting";
const DONE_MSG = "[ai-usage] daemon poll completed";

/** A gap longer than this is the machine asleep, not the daemon ticking slowly. */
const SLEEP_GAP_SECONDS = 120;

/**
 * The daemon's registered tick. A sleep gap still contains ONE tick's worth of
 * legitimate wait, so only the excess above this counts as time the daemon was
 * not running.
 */
const NOMINAL_TICK_SECONDS = 60;

async function readDay(logDir: string, day: string): Promise<Poll[]> {
    const polls: Poll[] = [];
    const file = Bun.file(join(logDir, `${day}.log`));

    if (!(await file.exists())) {
        return polls;
    }

    const text = await file.text();

    for (const line of text.split("\n")) {
        if (!line.includes("[ai-usage] daemon poll")) {
            continue;
        }

        // strict: the daemon writes machine JSON through pino. Without it,
        // comment-json would accept a line carrying `//` or a trailing comma and
        // fold it into the counts.
        const row = SafeJSON.parse(line, { strict: true }) as {
            msg?: string;
            time?: string;
            pid?: number;
            duration_ms?: number;
        } | null;
        if (!row?.time) {
            continue;
        }

        const at = Date.parse(row.time);
        if (row.msg === START_MSG) {
            polls.push({ started: at, durationMs: null, pid: row.pid ?? 0 });
        } else if (row.msg === DONE_MSG) {
            // Match on pid, not on "the newest start". Every tick is its own
            // process and two runs can overlap (a manual `bun run` beside the
            // daemon), which interleaves their lines; pairing by position then
            // hands one poll's duration to the other and leaves one unmatched.
            const own = polls.findLast((poll) => poll.durationMs === null && poll.pid === (row.pid ?? -1));
            if (own) {
                own.durationMs = row.duration_ms ?? null;
            }
        }
    }

    return polls;
}

function quantile(sorted: number[], q: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

interface Summary {
    label: string;
    polls: number;
    spanHours: number;
    awakeHours: number;
    perHour: number;
    medianMs: number;
    p90Ms: number;
    dutyPercent: number;
    gapMedianSeconds: number;
    sleepHours: number;
    pids: number;
}

function summarize(label: string, polls: Poll[]): Summary | null {
    if (polls.length < 2) {
        return null;
    }

    const starts = polls.map((p) => p.started).sort((a, b) => a - b);
    const spanHours = (starts[starts.length - 1]! - starts[0]!) / 3_600_000;
    const durations = polls
        .map((p) => p.durationMs)
        .filter((d): d is number => typeof d === "number")
        .sort((a, b) => a - b);

    const gaps: number[] = [];
    for (let i = 1; i < starts.length; i++) {
        gaps.push((starts[i]! - starts[i - 1]!) / 1000);
    }
    gaps.sort((a, b) => a - b);

    // Only the EXCESS above one nominal tick is time the daemon was not running;
    // the first 60 s of any gap is an ordinary wait.
    const sleptSeconds = gaps
        .filter((g) => g > SLEEP_GAP_SECONDS)
        .reduce((sum, g) => sum + (g - NOMINAL_TICK_SECONDS), 0);
    const busyMs = durations.reduce((sum, d) => sum + d, 0);
    // Rates are per hour the daemon was AWAKE. Dividing by the raw span made a
    // day with 9.7 h of sleep report 37 polls/h for a 60 s tick, which reads as
    // a rate change when the machine was simply off.
    const awakeHours = Math.max(spanHours - sleptSeconds / 3600, 0);

    return {
        label,
        polls: polls.length,
        spanHours,
        awakeHours,
        perHour: awakeHours > 0 ? polls.length / awakeHours : 0,
        medianMs: quantile(durations, 0.5),
        p90Ms: quantile(durations, 0.9),
        dutyPercent: awakeHours > 0 ? (busyMs / 1000 / (awakeHours * 3600)) * 100 : 0,
        gapMedianSeconds: quantile(gaps, 0.5),
        sleepHours: sleptSeconds / 3600,
        pids: new Set(polls.map((p) => p.pid)).size,
    };
}

function discoverDays(logDir: string): string[] {
    return readdirSync(logDir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .map((name) => name.replace(/\.log$/, ""))
        .sort();
}

/** Every day file from `from` to `to`, inclusive, whether or not each exists. */
function expandRange(from: string, to: string): string[] {
    const days: string[] = [];
    const end = Date.parse(`${to}T00:00:00Z`);

    for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86_400_000) {
        days.push(new Date(at).toISOString().slice(0, 10));
    }

    return days;
}

const argv = process.argv.slice(2);

/** Repeatable: N cut points produce N+1 arms, which is what the doc's table needs. */
const splitAts: number[] = [];
const flagValueIndexes = new Set<number>();
let badSplit: string | null = null;
let rangeFrom: string | undefined;
let rangeTo: string | undefined;

argv.forEach((arg, index) => {
    if (arg !== "--split" && arg !== "--from" && arg !== "--to") {
        return;
    }

    const value = argv[index + 1] ?? "";
    flagValueIndexes.add(index + 1);

    if (arg === "--from") {
        rangeFrom = value;
        return;
    }

    if (arg === "--to") {
        rangeTo = value;
        return;
    }

    const at = Date.parse(value);

    if (Number.isNaN(at)) {
        badSplit = value;
        return;
    }

    splitAts.push(at);
});

splitAts.sort((a, b) => a - b);

if (badSplit !== null) {
    out.log.error(`--split needs an ISO timestamp, got "${badSplit}" (example: --split 2026-09-16T20:10:04Z)`);
    process.exitCode = 1;
} else if ((rangeFrom === undefined) !== (rangeTo === undefined)) {
    out.log.error("--from and --to go together");
    process.exitCode = 1;
} else {
    const positional = argv.filter((a, i) => !a.startsWith("--") && !flagValueIndexes.has(i));
    const days = rangeFrom && rangeTo ? expandRange(rangeFrom, rangeTo) : positional;
    // Same construction as `createLogger` in src/utils/logger.ts:196. `env.tools.getHome()`
    // is the USER home, not the tool home, so the `.genesis-tools` segment is not optional.
    const logDir = join(env.tools.getHome(), ".genesis-tools", "logs");
    const wanted = days.length > 0 ? days : discoverDays(logDir);
    const summaries: Summary[] = [];

    if (splitAts.length === 0) {
        for (const day of wanted) {
            const summary = summarize(day, await readDay(logDir, day));
            if (summary) {
                summaries.push(summary);
            }
        }
    } else {
        const all = (await Promise.all(wanted.map((day) => readDay(logDir, day)))).flat();
        const bounds = [Number.NEGATIVE_INFINITY, ...splitAts, Number.POSITIVE_INFINITY];

        for (let arm = 0; arm < bounds.length - 1; arm++) {
            const lo = bounds[arm] as number;
            const hi = bounds[arm + 1] as number;
            const label =
                arm === 0
                    ? `before ${new Date(hi).toISOString()}`
                    : arm === bounds.length - 2
                      ? `after ${new Date(lo).toISOString()}`
                      : `${new Date(lo).toISOString()} to ${new Date(hi).toISOString()}`;
            const summary = summarize(
                label,
                all.filter((p) => p.started >= lo && p.started < hi)
            );

            if (summary) {
                summaries.push(summary);
            }
        }
    }

    renderCliHeader("ai-usage-poll daemon", "duty cycle is wall time inside a poll, not CPU");
    const table = createBoxTable([
        "ARM",
        "POLLS",
        "SPAN h",
        "AWAKE h",
        "PER h",
        "MEDIAN ms",
        "P90 ms",
        "DUTY %",
        "GAP med s",
        "ASLEEP h",
    ]);

    for (const s of summaries) {
        table.push([
            s.label,
            String(s.polls),
            s.spanHours.toFixed(2),
            s.awakeHours.toFixed(2),
            s.perHour.toFixed(1),
            String(s.medianMs),
            String(s.p90Ms),
            s.dutyPercent.toFixed(1),
            s.gapMedianSeconds.toFixed(0),
            s.sleepHours.toFixed(2),
        ]);
    }

    out.println(table.toString());
    out.println("");
    out.println("Compare PER h, never POLLS: a day with hours of sleep holds fewer polls at the same tick.");
    out.result(summaries);
}
