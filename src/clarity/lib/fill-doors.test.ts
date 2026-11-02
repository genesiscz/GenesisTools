import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { TimeLogQueryEntry } from "@app/azure-devops/types";
import type { ClarityConfig, ClarityMapping } from "@app/clarity/config";
import {
    type ApiDebugInfo,
    type ClarityApi,
    ClarityApiError,
    type TimeSegment,
    type UpdateTimeEntryRequest,
} from "@genesiscz/utils/clarity";
import { addDay } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";

// Characterization of the two fill doors: the CLI `clarity fill` command and the dashboard's
// preview + execute. Every Clarity and TimeLog client is a recording fake, the config is in memory.
// Each mock falls through to the real module while no world is active, so other test files that
// share this process keep the real behaviour.

interface Period {
    timePeriodId: number;
    start: string;
    /** Last day of the period, as Clarity's `timePeriodFinish` names it. */
    end: string;
    timesheetId?: number;
    numberOfNotes?: number;
    rows: Row[];
}

interface Row {
    timeEntryId: number;
    taskId: number;
    taskCode: string;
    taskName: string;
    /** date -> seconds */
    actuals?: Record<string, number>;
}

interface RecordedWrite {
    timesheetId: number;
    timeEntryId: number;
    taskId: number;
    start: string;
    finish: string;
    total: number;
    days: string[];
}

class FakeClarity {
    readonly writes: RecordedWrite[] = [];
    readonly notes: Array<{ timesheetId: number; text: string; userId: number }> = [];
    readonly getTimesheetCalls: number[] = [];
    failWrite: (timesheetId: number, timeEntryId: number) => boolean = () => false;

    constructor(
        private readonly periods: Period[],
        private readonly userId = 900001
    ) {}

    private carouselEntry(period: Period) {
        return {
            id: period.timePeriodId,
            is_active: period.timePeriodId === 400004,
            start_date: `${period.start}T00:00:00`,
            finish_date: `${addDay(period.end)}T00:00:00`,
            tpTimesheet: {
                _results:
                    period.timesheetId === undefined
                        ? []
                        : [
                              {
                                  timesheet_id: period.timesheetId,
                                  total: "0,00",
                                  prstatus: { _results: [{ displayValue: "Open" }] },
                              },
                          ],
            },
        };
    }

    private record(period: Period) {
        return {
            _internalId: period.timesheetId,
            timePeriodStart: `${period.start}T00:00:00`,
            timePeriodFinish: `${period.end}T00:00:00`,
            numberOfNotes: period.numberOfNotes ?? 0,
            hasNotes: (period.numberOfNotes ?? 0) > 0,
            numberOfEntries: period.rows.length,
            // Clarity leaves the section out of a timesheet that has no rows at all.
            timeentries:
                period.rows.length === 0
                    ? undefined
                    : {
                          _results: period.rows.map((row) => {
                              const segments = Object.entries(row.actuals ?? {}).map(([date, value]) => ({
                                  start: `${date}T00:00:00`,
                                  finish: `${date}T00:00:00`,
                                  value,
                              }));

                              return {
                                  _internalId: row.timeEntryId,
                                  taskId: row.taskId,
                                  taskCode: row.taskCode,
                                  taskName: row.taskName,
                                  actuals: row.actuals
                                      ? { segmentList: { total: segments.reduce((s, g) => s + g.value, 0), segments } }
                                      : undefined,
                              };
                          }),
                      },
        };
    }

    async getTimesheetApp(_timePeriodId?: number) {
        return {
            resource: { _results: [{ user_id: this.userId }] },
            timesheets: { _results: [{ _internalId: 555004, numberOfEntries: 2, timePeriodId: 400004 }] },
            tscarousel: { _results: this.periods.map((period) => this.carouselEntry(period)) },
        };
    }

    async getTimesheet(timesheetId: number) {
        this.getTimesheetCalls.push(timesheetId);
        const period = this.periods.find((p) => p.timesheetId === timesheetId);

        return { timesheets: { _results: period ? [this.record(period)] : [] } };
    }

    async updateTimeEntryVerbose(timesheetId: number, timeEntryId: number, body: UpdateTimeEntryRequest) {
        const actuals = body.actuals!;
        this.writes.push({
            timesheetId,
            timeEntryId,
            taskId: body.taskId!,
            start: actuals.start,
            finish: actuals.finish,
            total: actuals.segmentList.total,
            days: actuals.segmentList.segments.map((s: TimeSegment) => `${s.start.slice(0, 10)}=${s.value}`),
        });
        const debug: ApiDebugInfo = {
            url: `https://clarity.example.com/timesheets/${timesheetId}/timeEntries/${timeEntryId}`,
            method: "PUT",
            requestBody: { taskId: body.taskId },
            responseStatus: 200,
            responseBody: {},
        };

        if (this.failWrite(timesheetId, timeEntryId)) {
            throw new ClarityApiError("Clarity API error 500: boom", 500, {
                ...debug,
                responseStatus: 500,
                responseBody: "boom",
            });
        }

        return { data: {}, debug };
    }

    async createTimesheetNote(timesheetId: number, text: string, userId: number) {
        this.notes.push({ timesheetId, text, userId });
    }
}

function mapping(adoWorkItemId: number, clarityTaskId: number, name: string, code: string): ClarityMapping {
    return {
        clarityTaskId,
        clarityTaskName: name,
        clarityTaskCode: code,
        clarityInvestmentName: "Sample investment",
        clarityInvestmentCode: "P100001",
        adoWorkItemId,
        adoWorkItemTitle: `Work item ${adoWorkItemId}`,
    };
}

const Alpha = { taskId: 700001, taskCode: "T-ALPHA", taskName: "Task Alpha" };
const Beta = { taskId: 700002, taskCode: "T-BETA", taskName: "Task Beta" };
const Mappings = [
    mapping(510001, Alpha.taskId, Alpha.taskName, Alpha.taskCode),
    mapping(510002, Beta.taskId, Beta.taskName, Beta.taskCode),
];

function adoEntry(workItemId: number, date: string, minutes: number, comment: string | null = null): TimeLogQueryEntry {
    return {
        timeLogId: `log-${workItemId}-${date}`,
        comment,
        week: "2026-W32",
        timeTypeId: "tt-1",
        timeTypeDescription: "Development",
        minutes,
        date: `${date}T00:00:00`,
        userId: "user-1",
        userName: "Sample User",
        userEmail: null,
        projectId: "proj-1",
        workItemId,
        createdOn: `${date}T10:00:00`,
        createdBy: "user-1",
        updatedOn: null,
        updatedBy: null,
        deletedOn: null,
        deletedBy: null,
    };
}

/**
 * August 2026. P0 straddles the month start, P5 the month end, P1 lies fully inside, P2 holds Beta
 * hours equal to the replacement, P3 holds Alpha hours ADO no longer has, P4 is empty everywhere.
 */
function augustPeriods(
    options: { p1Notes?: number; p2Unopened?: boolean; p1WithoutBeta?: boolean; p1WithoutRows?: boolean } = {}
): Period[] {
    const rows = (index: number, alpha?: Record<string, number>, beta?: Record<string, number>): Row[] => [
        { timeEntryId: 10_001 + index * 10, ...Alpha, actuals: alpha },
        { timeEntryId: 10_002 + index * 10, ...Beta, actuals: beta },
    ];

    return [
        {
            timePeriodId: 400000,
            start: "2026-07-27",
            end: "2026-08-02",
            timesheetId: 555000,
            rows: rows(0, { "2026-07-28": 3600 }),
        },
        {
            timePeriodId: 400001,
            start: "2026-08-03",
            end: "2026-08-09",
            timesheetId: 555001,
            numberOfNotes: options.p1Notes,
            rows: options.p1WithoutRows ? [] : options.p1WithoutBeta ? rows(1).slice(0, 1) : rows(1),
        },
        {
            timePeriodId: 400002,
            start: "2026-08-10",
            end: "2026-08-16",
            timesheetId: options.p2Unopened ? undefined : 555002,
            rows: rows(2, undefined, { "2026-08-11": 3600 }),
        },
        {
            timePeriodId: 400003,
            start: "2026-08-17",
            end: "2026-08-23",
            timesheetId: 555003,
            rows: rows(3, { "2026-08-18": 7200 }),
        },
        { timePeriodId: 400004, start: "2026-08-24", end: "2026-08-30", timesheetId: 555004, rows: rows(4) },
        {
            timePeriodId: 400005,
            start: "2026-08-31",
            end: "2026-09-06",
            timesheetId: 555005,
            rows: rows(5, undefined, { "2026-09-01": 3600 }),
        },
    ];
}

const AugustEntries = [
    adoEntry(510001, "2026-08-01", 60, "weekend release"),
    adoEntry(510001, "2026-08-04", 120, "alpha work"),
    adoEntry(510001, "2026-08-05", 60),
    adoEntry(510002, "2026-08-06", 90, "beta review"),
    adoEntry(510002, "2026-08-11", 60),
    adoEntry(510002, "2026-08-31", 30, "month end"),
];

interface World {
    clarity: FakeClarity;
    entries: TimeLogQueryEntry[];
    mappings: ClarityMapping[];
    timelogQueries: unknown[];
}

let world: World | null = null;

function useWorld(
    options: { periods?: Period[]; entries?: TimeLogQueryEntry[]; mappings?: ClarityMapping[] } = {}
): World {
    world = {
        clarity: new FakeClarity(options.periods ?? augustPeriods()),
        entries: options.entries ?? AugustEntries,
        mappings: options.mappings ?? Mappings,
        timelogQueries: [],
    };

    return world;
}

function fakeTimeLogApi(active: World): TimeLogApi {
    const fake = {
        user: { userId: "user-1", userName: "Sample User", userEmail: "sample@example.com" },
        queryTimeLogs: async (query: unknown) => {
            active.timelogQueries.push(query);
            return active.entries;
        },
    };

    return fake as unknown as TimeLogApi;
}

function activeConfig(active: World): ClarityConfig {
    return { baseUrl: "https://clarity.example.com", mappings: active.mappings };
}

const AdoConfig = {
    org: "https://dev.azure.com/sample-org",
    project: "Sample Project",
    orgId: "org-1",
    projectId: "proj-1",
    timelog: { functionsKey: "test-key", defaultUser: { userId: "user-1", userName: "Sample User" } },
};

const realClarityApi = { ...(await import("@app/clarity/lib/api")) };
const realTimeLogClient = { ...(await import("@app/azure-devops/lib/timelog-client")) };
const realAdoConfig = { ...(await import("@app/azure-devops/config")) };
const realEnrichment = { ...(await import("@app/azure-devops/lib/work-item-enrichment")) };
const realClarityConfig = { ...(await import("@app/clarity/config")) };

mock.module("@app/clarity/lib/api", () => ({
    ...realClarityApi,
    getClarityApi: (...args: Parameters<typeof realClarityApi.getClarityApi>) =>
        world ? (world.clarity as unknown as ClarityApi) : realClarityApi.getClarityApi(...args),
}));
mock.module("@app/azure-devops/lib/timelog-client", () => ({
    ...realTimeLogClient,
    getTimeLogApi: (...args: Parameters<typeof realTimeLogClient.getTimeLogApi>) =>
        world ? fakeTimeLogApi(world) : realTimeLogClient.getTimeLogApi(...args),
}));
mock.module("@app/azure-devops/config", () => ({
    ...realAdoConfig,
    loadConfig: (...args: Parameters<typeof realAdoConfig.loadConfig>) =>
        world ? AdoConfig : realAdoConfig.loadConfig(...args),
}));
mock.module("@app/azure-devops/lib/work-item-enrichment", () => ({
    ...realEnrichment,
    enrichWorkItems: async (...args: Parameters<typeof realEnrichment.enrichWorkItems>) => {
        if (!world) {
            return realEnrichment.enrichWorkItems(...args);
        }

        return new Map(args[1].map((id) => [id, { id, title: `Title ${id}`, type: "Task" }]));
    },
}));
mock.module("@app/clarity/config", () => ({
    ...realClarityConfig,
    getConfig: async () => (world ? activeConfig(world) : realClarityConfig.getConfig()),
    requireConfig: async () => (world ? activeConfig(world) : realClarityConfig.requireConfig()),
}));

const { registerFillCommand } = await import("@app/clarity/commands/fill");
const { executeFill, getFillPreview, postTimesheetNote } = await import("@app/clarity/ui/src/server/fill");

class ExitSignal extends Error {
    constructor(readonly code: number) {
        super(`process.exit(${code})`);
    }
}

interface CliRun {
    lines: string[];
    exitCode: number | undefined;
}

async function runCli(args: string[]): Promise<CliRun> {
    const lines: string[] = [];
    const capture = (...parts: unknown[]) => {
        lines.push(Bun.stripANSI(parts.map(String).join(" ")));
    };
    const spies = [
        spyOn(out, "println").mockImplementation(capture),
        spyOn(out, "error").mockImplementation(capture),
        spyOn(out, "warn").mockImplementation(capture),
        spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
            throw new ExitSignal(typeof code === "number" ? code : 0);
        }),
    ];
    const program = new Command().exitOverride();
    registerFillCommand(program);
    let exitCode: number | undefined;

    try {
        await program.parseAsync(["fill", "--month", "8", "--year", "2026", ...args], { from: "user" });
    } catch (err) {
        if (!(err instanceof ExitSignal)) {
            throw err;
        }

        exitCode = err.code;
    } finally {
        for (const spy of spies) {
            spy.mockRestore();
        }
    }

    return { lines, exitCode };
}

function resultsLine(run: CliRun): string | undefined {
    return run.lines.find((line) => line.includes("Results:"))?.trim();
}

function writeSummary(writes: RecordedWrite[]): string[] {
    return writes.map((w) => `${w.timesheetId}/${w.timeEntryId} task ${w.taskId} total ${w.total}`);
}

function nonZeroDays(write: RecordedWrite): string[] {
    return write.days.filter((day) => !day.endsWith("=0"));
}

beforeEach(() => {
    world = null;
});

afterEach(() => {
    world = null;
});

afterAll(() => {
    world = null;
});

// Writes the whole August month books, in the order the CLI sends them: weeks carrying ADO dates
// first, then the clearing-only weeks of the month.
const CliAugustWrites = [
    "555000/10001 task 700001 total 7200",
    "555001/10011 task 700001 total 10800",
    "555001/10012 task 700002 total 5400",
    "555005/10052 task 700002 total 5400",
    "555003/10031 task 700001 total 0",
];

describe("CLI clarity fill", () => {
    test("books a month: straddling weeks keep adjacent-month hours, equal weeks are not written, deleted hours are cleared", async () => {
        const active = useWorld({ periods: augustPeriods({ p1Notes: 1 }) });

        const run = await runCli(["--confirm"]);

        expect(run.exitCode).toBeUndefined();
        expect(writeSummary(active.clarity.writes)).toEqual(CliAugustWrites);

        const [p0Alpha, p1Alpha, p1Beta, p5Beta, p3Alpha] = active.clarity.writes;
        expect(p0Alpha.start).toBe("2026-07-27T00:00:00");
        expect(p0Alpha.finish).toBe("2026-08-02T00:00:00");
        expect(p0Alpha.days).toEqual([
            "2026-07-27=0",
            "2026-07-28=3600",
            "2026-07-29=0",
            "2026-07-30=0",
            "2026-07-31=0",
            "2026-08-01=3600",
            "2026-08-02=0",
        ]);
        expect(nonZeroDays(p1Alpha)).toEqual(["2026-08-04=7200", "2026-08-05=3600"]);
        expect(nonZeroDays(p1Beta)).toEqual(["2026-08-06=5400"]);
        expect(nonZeroDays(p5Beta)).toEqual(["2026-08-31=1800", "2026-09-01=3600"]);
        expect(p3Alpha.days).toHaveLength(7);
        expect(nonZeroDays(p3Alpha)).toEqual([]);

        // P1 already carries a note; P2 wrote nothing; P3 booked no ADO entry of its own.
        expect(active.clarity.notes.map((n) => [n.timesheetId, n.userId])).toEqual([
            [555000, 900001],
            [555005, 900001],
        ]);
        expect(active.clarity.notes[0].text).toContain("weekend release");
        expect(active.clarity.notes[1].text).toContain("month end");
        expect(active.clarity.notes[0].text).not.toContain("alpha work");
        expect(
            run.lines.some((line) => line.includes("Timesheet 555001 already carries 1 note(s), not adding another"))
        ).toBe(true);
        expect(resultsLine(run)).toBe("Results: 5 updated, 2 note(s)");

        // Discovery reads every week lacking an entry count; the CLI then reads the one it lacks.
        expect(active.clarity.getTimesheetCalls).toEqual([555000, 555001, 555002, 555003, 555005, 555004]);
    });

    test("a dry run previews the weeks and writes nothing", async () => {
        const active = useWorld();

        const run = await runCli([]);

        expect(run.exitCode).toBeUndefined();
        expect(active.clarity.writes).toEqual([]);
        expect(active.clarity.notes).toEqual([]);
        expect(run.lines.some((line) => line.includes("This is a DRY RUN"))).toBe(true);
        expect(run.lines.filter((line) => line.includes("Week: ")).map((line) => line.trim())).toEqual([
            "Week: 2026-07-27 to 2026-08-02 (Timesheet: 555000)",
            "Week: 2026-08-03 to 2026-08-09 (Timesheet: 555001)",
            "Week: 2026-08-10 to 2026-08-16 (Timesheet: 555002)",
            "Week: 2026-08-31 to 2026-09-06 (Timesheet: 555005)",
            "Week: 2026-08-17 to 2026-08-23 (Timesheet: 555003)",
        ]);
        expect(resultsLine(run)).toBeUndefined();
    });

    test("--no-comments books the hours and posts no note", async () => {
        const active = useWorld();

        const run = await runCli(["--confirm", "--no-comments"]);

        expect(run.exitCode).toBeUndefined();
        expect(writeSummary(active.clarity.writes)).toEqual(CliAugustWrites);
        expect(active.clarity.notes).toEqual([]);
        expect(resultsLine(run)).toBe("Results: 5 updated");
    });

    test("a failed write is counted, kept out of the note, and exits 1", async () => {
        const active = useWorld();
        active.clarity.failWrite = (timesheetId, timeEntryId) => timesheetId === 555001 && timeEntryId === 10011;

        const run = await runCli(["--confirm", "--verbose"]);

        expect(run.exitCode).toBe(1);
        expect(writeSummary(active.clarity.writes)).toEqual(CliAugustWrites);
        expect(run.lines.some((line) => line.includes("FAIL Task Alpha: Clarity API error 500: boom"))).toBe(true);
        expect(run.lines.some((line) => line.includes('Debug: {"url":') && line.includes('"responseStatus":500'))).toBe(
            true
        );
        expect(
            run.lines.some((line) =>
                line.includes("PUT https://clarity.example.com/timesheets/555001/timeEntries/10012")
            )
        ).toBe(true);

        const p1Note = active.clarity.notes.find((note) => note.timesheetId === 555001);
        expect(p1Note?.text).toContain("beta review");
        expect(p1Note?.text).not.toContain("alpha work");
        expect(active.clarity.notes.map((n) => n.timesheetId)).toEqual([555000, 555001, 555005]);
        expect(resultsLine(run)).toBe("Results: 4 updated, 3 note(s), 1 failed");
        expect(run.lines.some((line) => line.includes("Some hours were not booked"))).toBe(true);
    });

    test("an unmapped work item stops the fill before Clarity is read", async () => {
        const active = useWorld({ entries: [...AugustEntries, adoEntry(510099, "2026-08-04", 45)] });

        const run = await runCli(["--confirm"]);

        expect(run.exitCode).toBe(1);
        expect(active.clarity.writes).toEqual([]);
        expect(active.clarity.getTimesheetCalls).toEqual([]);
        expect(run.lines.some((line) => line.includes("1 work item(s) have no Clarity mapping"))).toBe(true);
        expect(run.lines.some((line) => line.includes("#510099"))).toBe(true);
        expect(run.lines.some((line) => line.includes("Refusing to fill an incomplete month"))).toBe(true);
    });

    test("--allow-unmapped books the mapped work and lists the unmapped item under its week", async () => {
        const active = useWorld({ entries: [...AugustEntries, adoEntry(510099, "2026-08-04", 45)] });

        const run = await runCli(["--confirm", "--allow-unmapped"]);

        expect(run.exitCode).toBeUndefined();
        expect(writeSummary(active.clarity.writes)).toEqual(CliAugustWrites);
        const skippedAt = run.lines.findIndex((line) => line.includes("Unmapped work items (skipped):"));
        expect(skippedAt).toBeGreaterThan(-1);
        expect(run.lines[skippedAt + 1]).toContain("#510099");
        const weekHeader = run.lines.slice(0, skippedAt).findLast((line) => line.includes("Week: "));
        expect(weekHeader).toContain("Timesheet: 555001");
    });

    test("a day no opened Clarity period covers refuses the month", async () => {
        const active = useWorld({ periods: augustPeriods({ p2Unopened: true }) });

        const run = await runCli(["--confirm"]);

        expect(run.exitCode).toBe(1);
        expect(active.clarity.writes).toEqual([]);
        expect(run.lines.some((line) => line.includes("No Clarity period covers 2026-08-11"))).toBe(true);
        expect(
            run.lines.some((line) => line.includes("Refusing to fill: those hours would be silently dropped."))
        ).toBe(true);
    });

    test("a task with hours but no row in the week is reported and exits 1", async () => {
        const active = useWorld({ periods: augustPeriods({ p1WithoutBeta: true }) });

        const run = await runCli(["--confirm"]);

        expect(run.exitCode).toBe(1);
        expect(writeSummary(active.clarity.writes)).toEqual(
            CliAugustWrites.filter((w) => !w.startsWith("555001/10012"))
        );
        expect(
            run.lines.some((line) => line.includes("No time entry row for task Task Beta in timesheet 555001"))
        ).toBe(true);
        expect(resultsLine(run)).toBe("Results: 4 updated, 3 note(s), 1 task(s) with no row");
    });

    test("a week whose timesheet has no rows at all reports both tasks instead of crashing", async () => {
        const active = useWorld({ periods: augustPeriods({ p1WithoutRows: true }) });

        const run = await runCli(["--confirm"]);

        expect(run.exitCode).toBe(1);
        expect(writeSummary(active.clarity.writes)).toEqual(CliAugustWrites.filter((w) => !w.startsWith("555001/")));
        expect(
            run.lines.some((line) => line.includes("No time entry row for task Task Alpha in timesheet 555001"))
        ).toBe(true);
        expect(
            run.lines.some((line) => line.includes("No time entry row for task Task Beta in timesheet 555001"))
        ).toBe(true);
    });

    test("an empty ADO month reports it and writes nothing", async () => {
        const active = useWorld({ entries: [] });

        const run = await runCli(["--confirm"]);

        expect(run.exitCode).toBeUndefined();
        expect(active.clarity.writes).toEqual([]);
        expect(run.lines.some((line) => line.includes("No ADO timelog entries found for this month."))).toBe(true);
    });
});

const AllWeekIds = [555000, 555001, 555002, 555003, 555004, 555005];

function entrySummary(entry: {
    timesheetId: number;
    clarityTaskCode: string;
    status: string;
    error?: string;
    totalHours: number;
}) {
    return `${entry.timesheetId} ${entry.clarityTaskCode} ${entry.status} ${entry.totalHours}h${entry.error ? ` (${entry.error})` : ""}`;
}

describe("dashboard fill preview", () => {
    test("lists every opened week of the month with the ADO minutes and the hours Clarity holds", async () => {
        const active = useWorld({ periods: augustPeriods({ p1Notes: 1 }) });

        const preview = await getFillPreview(8, 2026);

        expect(preview.diagnostics).toBeUndefined();
        expect(preview.totalMapped).toBe(420);
        expect(preview.totalUnmapped).toBe(0);
        expect(preview.userId).toBe(900001);
        expect(preview.adoConfig).toEqual({ org: AdoConfig.org, project: AdoConfig.project });
        expect(preview.weeks.map((w) => [w.timesheetId, w.periodStart, w.periodFinish])).toEqual([
            [555000, "2026-07-27", "2026-08-03"],
            [555001, "2026-08-03", "2026-08-10"],
            [555002, "2026-08-10", "2026-08-17"],
            [555003, "2026-08-17", "2026-08-24"],
            [555004, "2026-08-24", "2026-08-31"],
            [555005, "2026-08-31", "2026-09-07"],
        ]);
        expect(
            preview.weeks.map((w) =>
                w.entries.map(
                    (e) =>
                        `${e.clarityTaskCode} ado=${e.totalMinutes} clarity=${e.clarityCurrentMinutes}${e.clarityOnly ? " only" : ""}`
                )
            )
        ).toEqual([
            ["T-ALPHA ado=60 clarity=60"],
            ["T-ALPHA ado=180 clarity=0", "T-BETA ado=90 clarity=0"],
            ["T-BETA ado=60 clarity=60"],
            ["T-ALPHA ado=0 clarity=120 only"],
            [],
            ["T-BETA ado=30 clarity=60"],
        ]);
        expect(preview.weeks[1].entries[0].dayValues).toEqual({ "2026-08-04": 120, "2026-08-05": 60 });
        expect(preview.weeks[1].entries[0].timelogEntries.map((e) => [e.date, e.workItemTitle, e.comment])).toEqual([
            ["2026-08-04", "Title 510001", "alpha work"],
            ["2026-08-05", "Title 510001", null],
        ]);
        expect(preview.weeks[0].entries[0].clarityDayValues).toEqual({ "2026-07-28": 60 });
        expect(preview.weeks.map((w) => [w.clarityTotalMinutes, w.hasNotes, w.numberOfNotes])).toEqual([
            [60, false, 0],
            [0, true, 1],
            [60, false, 0],
            [120, false, 0],
            [0, false, 0],
            [60, false, 0],
        ]);
        expect(active.clarity.writes).toEqual([]);
        expect(active.clarity.getTimesheetCalls).toEqual([555000, 555001, 555002, 555003, 555005, 555004]);
    });

    test("a week whose timesheet has no rows at all previews with no Clarity hours instead of failing", async () => {
        useWorld({ periods: augustPeriods({ p1WithoutRows: true }) });

        const preview = await getFillPreview(8, 2026);

        expect(preview.diagnostics).toBeUndefined();
        expect(preview.weeks?.map((w) => w.timesheetId)).toContain(555001);
    });

    test("an unmapped work item refuses the preview unless allowed, then shows under its week", async () => {
        useWorld({ entries: [...AugustEntries, adoEntry(510099, "2026-08-04", 45)] });

        const refused = await getFillPreview(8, 2026);

        expect(refused.weeks).toEqual([]);
        expect(refused.totalUnmapped).toBe(45);
        expect(refused.diagnostics?.reason).toBe("unmapped_work_items");
        expect(refused.diagnostics?.message).toContain("1 work item(s) carrying 0.8h have no Clarity mapping");

        const allowed = await getFillPreview(8, 2026, true);

        expect(allowed.diagnostics).toBeUndefined();
        expect(allowed.weeks.map((w) => w.unmappedWorkItems)).toEqual([
            [],
            [{ workItemId: 510099, minutes: 45 }],
            [],
            [],
            [],
            [],
        ]);
    });

    test("a day no opened Clarity period covers refuses the preview", async () => {
        useWorld({ periods: augustPeriods({ p2Unopened: true }) });

        const preview = await getFillPreview(8, 2026);

        expect(preview.weeks).toEqual([]);
        expect(preview.unresolvedDates).toEqual(["2026-08-11"]);
        expect(preview.diagnostics?.reason).toBe("unresolved_dates");
        expect(preview.userId).toBe(900001);
    });

    test("an empty carousel reports that no timesheet week resolved", async () => {
        useWorld({ periods: [] });

        const preview = await getFillPreview(8, 2026);

        expect(preview.weeks).toEqual([]);
        expect(preview.diagnostics?.reason).toBe("no_timesheet_weeks");
        expect(preview.unresolvedDates).toEqual([
            "2026-08-01",
            "2026-08-04",
            "2026-08-05",
            "2026-08-06",
            "2026-08-11",
            "2026-08-31",
        ]);
    });

    test("an empty ADO month and a config without mappings each get their own diagnostic", async () => {
        useWorld({ entries: [] });
        expect((await getFillPreview(8, 2026)).diagnostics?.reason).toBe("no_ado_entries");

        useWorld({ mappings: [] });
        expect((await getFillPreview(8, 2026)).diagnostics?.reason).toBe("no_mappings");
    });
});

describe("dashboard fill execute", () => {
    test("writes the selected weeks and reports every task of every week", async () => {
        const active = useWorld();

        const result = await executeFill(8, 2026, AllWeekIds);

        expect([result.success, result.failed, result.skipped]).toEqual([5, 0, 7]);
        expect(result.entries.map(entrySummary)).toEqual([
            "555000 T-ALPHA success 2h",
            "555000 T-BETA skipped 0h (No minutes for this task in this week)",
            "555001 T-ALPHA success 3h",
            "555001 T-BETA success 1.5h",
            "555002 T-ALPHA skipped 0h (No minutes for this task in this week)",
            "555002 T-BETA skipped 0h (Clarity already holds these hours)",
            "555003 T-ALPHA success 0h",
            "555003 T-BETA skipped 0h (No minutes for this task in this week)",
            "555004 T-ALPHA skipped 0h (No minutes for this task in this week)",
            "555004 T-BETA skipped 0h (No minutes for this task in this week)",
            "555005 T-ALPHA skipped 0h (No minutes for this task in this week)",
            "555005 T-BETA success 1.5h",
        ]);
        expect(result.entries[0].segments).toEqual([
            { date: "2026-07-28", hours: 1 },
            { date: "2026-08-01", hours: 1 },
        ]);
        expect(result.entries[0].timeEntryId).toBe(10001);
        expect(result.entries[0].debug?.responseStatus).toBe(200);
        expect(writeSummary(active.clarity.writes)).toEqual([
            "555000/10001 task 700001 total 7200",
            "555001/10011 task 700001 total 10800",
            "555001/10012 task 700002 total 5400",
            "555003/10031 task 700001 total 0",
            "555005/10052 task 700002 total 5400",
        ]);
        expect(active.clarity.writes.map(nonZeroDays)).toEqual([
            ["2026-07-28=3600", "2026-08-01=3600"],
            ["2026-08-04=7200", "2026-08-05=3600"],
            ["2026-08-06=5400"],
            [],
            ["2026-08-31=1800", "2026-09-01=3600"],
        ]);
        expect(active.clarity.writes.map((w) => w.days.length)).toEqual([7, 7, 7, 7, 7]);
        expect(active.clarity.notes).toEqual([]);
        // Discovery, then a fresh read of every requested week.
        expect(active.clarity.getTimesheetCalls).toEqual([555000, 555001, 555002, 555003, 555005, ...AllWeekIds]);
    });

    test("writes only the weeks the caller names", async () => {
        const active = useWorld();

        const result = await executeFill(8, 2026, [555001]);

        expect([result.success, result.failed, result.skipped]).toEqual([2, 0, 0]);
        expect(writeSummary(active.clarity.writes)).toEqual([
            "555001/10011 task 700001 total 10800",
            "555001/10012 task 700002 total 5400",
        ]);
    });

    test("a failed write is reported with the request debug and the rest still write", async () => {
        const active = useWorld();
        active.clarity.failWrite = (timesheetId, timeEntryId) => timesheetId === 555001 && timeEntryId === 10011;

        const result = await executeFill(8, 2026, AllWeekIds);

        expect([result.success, result.failed, result.skipped]).toEqual([4, 1, 7]);
        const failed = result.entries.find((entry) => entry.status === "error");
        expect(failed && entrySummary(failed)).toBe("555001 T-ALPHA error 3h (Clarity API error 500: boom)");
        expect(failed?.debug?.responseStatus).toBe(500);
        expect(failed?.debug?.responseBody).toBe("boom");
        expect(active.clarity.writes).toHaveLength(5);
    });

    test("a task with no row in a week is skipped, and an unknown week is an error", async () => {
        useWorld({ periods: augustPeriods({ p1WithoutBeta: true }) });

        const result = await executeFill(8, 2026, [555001, 999999]);

        expect([result.success, result.failed, result.skipped]).toEqual([1, 1, 1]);
        expect(result.entries.map(entrySummary)).toEqual([
            "555001 T-ALPHA success 3h",
            "555001 T-BETA skipped 0h (No time entry for task in timesheet 555001)",
            "999999  error 0h (Timesheet 999999 not found)",
        ]);
    });

    test("a week whose timesheet has no rows at all skips each task instead of failing the week", async () => {
        useWorld({ periods: augustPeriods({ p1WithoutRows: true }) });

        const result = await executeFill(8, 2026, [555001]);

        expect(result.entries.map(entrySummary)).toEqual([
            "555001 T-ALPHA skipped 0h (No time entry for task in timesheet 555001)",
            "555001 T-BETA skipped 0h (No time entry for task in timesheet 555001)",
        ]);
    });

    test("an unmapped work item refuses the write unless allowed", async () => {
        const active = useWorld({ entries: [...AugustEntries, adoEntry(510099, "2026-08-04", 45)] });

        await expect(executeFill(8, 2026, AllWeekIds)).rejects.toThrow(
            "Refusing to fill: 1 work item(s) carrying 0.8h have no Clarity mapping."
        );
        expect(active.clarity.writes).toEqual([]);

        const allowed = await executeFill(8, 2026, AllWeekIds, true);

        expect(allowed.success).toBe(5);
    });

    test("a day no opened Clarity period covers refuses the write", async () => {
        const active = useWorld({ periods: augustPeriods({ p2Unopened: true }) });

        await expect(executeFill(8, 2026, AllWeekIds)).rejects.toThrow(
            "Refusing to fill: no Clarity period covers 2026-08-11."
        );
        expect(active.clarity.writes).toEqual([]);
    });

    test("posting a note passes the text and author straight to Clarity", async () => {
        const active = useWorld();

        await postTimesheetNote(555001, "Sample note", 900001);

        expect(active.clarity.notes).toEqual([{ timesheetId: 555001, text: "Sample note", userId: 900001 }]);
    });
});
