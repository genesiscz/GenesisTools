import { resolve } from "node:path";
import { WATCH_DRIVER_IDS, WATCH_DRIVERS, type WatchDriverId } from "@genesiscz/utils/fs/watch-driver/registry";
import { logger, out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { diffFor, loadHooksConfig } from "../lib/hooks/config";
import type { StatusReport } from "../lib/hooks/diff/status/gates";
import { armsFor } from "../lib/hooks/diff/status/modes";
import { compareToReference } from "../lib/hooks/diff/status/shadow";
import {
    type DiffStatusConfig,
    STATUS_MODE_IDS,
    type StatusAnswer,
    type StatusArm,
    type StatusRequest,
} from "../lib/hooks/diff/status/types";
import { parseHorizon } from "../lib/hooks/gc";
import { gitOut, objectId } from "../lib/hooks/git";

const { log } = logger.scoped("hooks-status-modes");

function statusConfig(): DiffStatusConfig {
    return diffFor(loadHooksConfig(), undefined).status;
}

/** Every arm the config gives, once, with the roles it plays. */
async function configuredArms(config: DiffStatusConfig): Promise<Array<{ arm: StatusArm; roles: string[] }>> {
    const rows = new Map<string, { arm: StatusArm; roles: string[] }>();
    const add = (arm: StatusArm, role: string) => {
        const row = rows.get(arm.id) ?? { arm, roles: [] };
        row.roles.push(role);
        rows.set(arm.id, row);
    };

    for (const shape of ["read", "write"] as const) {
        const arms = await armsFor(config, shape);
        add(arms.reference, `reference (${shape})`);
        add(arms.active, `active (${shape})`);

        for (const arm of arms.shadow) {
            add(arm, `shadow (${shape})`);
        }
    }

    for (const row of rows.values()) {
        row.roles = [...new Set(row.roles)];
    }

    return [...rows.values()];
}

async function driverState(id: WatchDriverId): Promise<{ driver: WatchDriverId; ok: boolean; detail: string }> {
    try {
        const driver = await WATCH_DRIVERS[id].load();
        const available = await driver.available();
        await driver.dispose();
        return available.ok
            ? { driver: id, ok: true, detail: available.version }
            : { driver: id, ok: false, detail: available.reason };
    } catch (error) {
        log.debug({ error, driver: id }, "a watch driver did not load");
        return { driver: id, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
}

async function list(flags: { json?: boolean }): Promise<void> {
    const config = statusConfig();
    const arms = await configuredArms(config);
    const drivers = await Promise.all(WATCH_DRIVER_IDS.map(driverState));

    if (flags.json) {
        out.result({
            config,
            arms: arms.map((row) => ({ arm: row.arm.id, mode: row.arm.mode, roles: row.roles })),
            drivers,
        });
        return;
    }

    renderCliHeader("Status modes", "arms from the config, watch drivers");
    const table = createBoxTable(["ARM", "MODE", "ROLES"]);

    for (const row of arms) {
        table.push([pc.white(row.arm.id), row.arm.mode, row.roles.join(", ")]);
    }

    out.println(table.toString());
    const shadow = config.shadow.modes.length
        ? `${config.shadow.modes.join(", ")}, one call in ${config.shadow.every}, budget ${config.shadow.budgetMs} ms`
        : "off (diff.status.shadow.modes is empty)";
    out.println(`${pc.bold("shadow")}  ${shadow}`);
    renderCliSection("Watch drivers (read only: nothing is opened)");
    const driverTable = createBoxTable(["DRIVER", "AVAILABLE"]);

    for (const row of drivers) {
        driverTable.push([pc.white(row.driver), formatDotStatus(row.ok ? "ok" : "warn", row.detail)]);
    }

    out.println(driverTable.toString());
}

/** A config that runs every mode and every driver once: the arms `try` reads. */
function everyArm(config: DiffStatusConfig): DiffStatusConfig {
    const driver = config.modes.snapshot.driver;
    return {
        ...config,
        shadow: { ...config.shadow, modes: [...STATUS_MODE_IDS] },
        modes: {
            ...config.modes,
            snapshot: { ...config.modes.snapshot, shadowDrivers: WATCH_DRIVER_IDS.filter((id) => id !== driver) },
        },
    };
}

async function observe(arm: StatusArm, request: StatusRequest): Promise<StatusAnswer> {
    try {
        return await arm.observe(request);
    } catch (error) {
        log.debug({ error, arm: arm.id }, "a status arm threw in try");
        return {
            state: "unavailable",
            reason: "arm-error",
            cost: { cpuMs: 0, wallMs: 0, gitSpawns: 0, serviceCpuMs: null, fullStatus: false },
        };
    }
}

function ms(value: number | null): string {
    return value === null ? "—" : value.toFixed(1);
}

async function tryArms(rootArg: string | undefined, flags: { json?: boolean }): Promise<void> {
    const dir = resolve(rootArg ?? ".");
    const root = gitOut(dir, ["rev-parse", "--show-toplevel"]).trim();

    if (!root) {
        out.printlnErr(`${dir} is not inside a Git worktree`);
        process.exitCode = 1;
        return;
    }

    const head = objectId(gitOut(root, ["rev-parse", "HEAD"]).trim());
    const arms = await armsFor(everyArm(statusConfig()), "write");
    const ordered = [arms.reference, arms.active, ...arms.shadow].filter(
        (arm, index, all) => all.findIndex((other) => other.id === arm.id) === index
    );
    const request: StatusRequest = { phase: "pre", root, need: "all", head, mark: null };
    const reference = await observe(arms.reference, request);
    const rows = [];

    for (const arm of ordered) {
        const answer = arm === arms.reference ? reference : await observe(arm, request);
        const parity =
            answer.state === "ok" && reference.state === "ok" && arm !== arms.reference
                ? compareToReference({ need: "all", phase: "pre", reference: reference.view, got: answer.view })
                : null;
        rows.push({ arm: arm.id, mode: arm.mode, answer, parity });
    }

    if (flags.json) {
        out.result({ root, head, arms: rows });
        return;
    }

    renderCliHeader("Status modes: one read per arm", root);
    const table = createBoxTable([
        "ARM",
        "ANSWER",
        "SOURCE",
        "ENTRIES",
        "PARITY",
        "CPU ms",
        "WALL ms",
        "GIT",
        "SVC CPU",
    ]);

    for (const row of rows) {
        const { answer } = row;
        table.push([
            pc.white(row.arm),
            answer.state === "ok" ? formatDotStatus("ok", "ok") : formatDotStatus("warn", answer.reason),
            answer.state === "ok" ? answer.source : "—",
            answer.state === "ok" ? String(answer.view.entries.length) : "—",
            row.parity ? row.parity.parity : row.arm === arms.reference.id ? "reference" : "—",
            ms(answer.cost.cpuMs),
            ms(answer.cost.wallMs),
            String(answer.cost.gitSpawns),
            ms(answer.cost.serviceCpuMs),
        ]);
    }

    out.println(table.toString());

    for (const row of rows) {
        if (row.parity && row.parity.differences.length > 0) {
            renderCliSection(
                `${row.arm}: ${row.parity.differences.length} differences, cause ${row.parity.cause ?? "none"}`
            );

            for (const difference of row.parity.differences.slice(0, 10)) {
                out.println(`  ${difference.reference ?? "--"} -> ${difference.got ?? "--"}  ${difference.path}`);
            }
        }
    }

    if (reference.state === "ok") {
        renderCliSection(`Git entries (${reference.view.entries.length})`);

        for (const entry of reference.view.entries.slice(0, 20)) {
            out.println(`  ${entry.index}${entry.worktree} ${entry.path}`);
        }
    }

    out.println(pc.dim("parity is from one read: the hooks confirm a difference by reading both again."));
}

function sinceOf(text: string, now: number): number | null {
    try {
        return now - parseHorizon(text);
    } catch (error) {
        log.debug({ error, since: text }, "--since is no duration, trying a date");
        const at = Date.parse(text);
        return Number.isNaN(at) ? null : at;
    }
}

function holdsCell(holds: boolean | null): string {
    if (holds === null) {
        return formatDotStatus("dim", "not measured");
    }

    return holds ? formatDotStatus("ok", "yes") : formatDotStatus("err", "no");
}

function printReport(report: StatusReport, gateRows: typeof import("../lib/hooks/diff/status/gates").gateRows): void {
    const armTable = createBoxTable([
        "ARM",
        "MODE",
        "CALLS",
        "OBS",
        "ANSWERED",
        "TOP REASONS",
        "FULL/CALL",
        "ROOTS",
        "LINKED",
        "HARNESSES",
        "DAYS",
    ]);

    for (const arm of report.arms) {
        const asked = arm.observations - arm.skipped;
        const reasons = Object.entries(arm.reasons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, count]) => `${reason} ${count}`)
            .join(", ");
        armTable.push([
            pc.white(arm.arm),
            arm.mode,
            String(arm.calls),
            String(arm.observations),
            asked === 0 ? "—" : `${((arm.answered / asked) * 100).toFixed(1)}%`,
            truncateDisplay(reasons, 40),
            String(arm.fullStatusPerCall),
            String(arm.roots),
            String(arm.linkedRoots),
            arm.harnesses.join(", "),
            String(arm.days),
        ]);
    }

    out.println(armTable.toString());
    renderCliSection("Parity against the git arm at the same boundary");
    const parityTable = createBoxTable(["ARM", ...Object.keys(report.arms[0]?.parity ?? {}), "WRITER PRE MISSING"]);

    for (const arm of report.arms) {
        parityTable.push([
            pc.white(arm.arm),
            ...Object.values(arm.parity).map(String),
            String(arm.missingDirtyAtWriterPre),
        ]);
    }

    out.println(parityTable.toString());
    renderCliSection("Cost per phase (ms)");
    const costTable = createBoxTable(["ARM", "PHASE", "OBS", "CPU p50", "CPU p90", "WALL p50", "WALL p90", "WALL p99"]);

    for (const arm of report.arms) {
        for (const phase of ["pre", "post"] as const) {
            const cost = arm.phases[phase];
            costTable.push([
                pc.white(arm.arm),
                phase,
                String(cost.observations),
                String(cost.cpuMs.p50),
                String(cost.cpuMs.p90),
                String(cost.wallMs.p50),
                String(cost.wallMs.p90),
                String(cost.wallMs.p99),
            ]);
        }
    }

    out.println(costTable.toString());

    for (const arm of report.arms) {
        const rows = gateRows(arm);

        if (rows.length === 0) {
            continue;
        }

        renderCliSection(`Gates of ${arm.arm} (they are reported only; nothing switches)`);
        const gateTable = createBoxTable(["GATE", "VALUE", "THRESHOLD", "HOLDS"]);

        for (const row of rows) {
            gateTable.push([
                row.text,
                row.value === null ? "—" : String(row.value),
                row.threshold,
                holdsCell(row.holds),
            ]);
        }

        out.println(gateTable.toString());
    }

    if (report.differences.length > 0) {
        renderCliSection("Differences by cause, the unexplained first");
        const differenceTable = createBoxTable(["ARM", "CAUSE", "COUNT", "EXAMPLES"]);

        for (const group of report.differences) {
            differenceTable.push([
                pc.white(group.arm),
                group.cause ?? pc.red("unexplained"),
                String(group.count),
                truncateDisplay(group.examples.join(", "), 60),
            ]);
        }

        out.println(differenceTable.toString());
    }
}

async function report(flags: { since?: string; json?: boolean }): Promise<void> {
    const now = Date.now();
    const since = sinceOf(flags.since ?? "7d", now);

    if (since === null) {
        out.printlnErr(`--since takes a duration like 6h or 7d, or a date, not ${flags.since}`);
        process.exitCode = 1;
        return;
    }

    const { buildStatusReport, gateRows } = await import("../lib/hooks/diff/status/gates");
    const built = await buildStatusReport({ since });

    if (flags.json) {
        out.result({
            since,
            arms: built.arms.map((arm) => ({ ...arm, gates: gateRows(arm) })),
            differences: built.differences,
        });
        return;
    }

    renderCliHeader("Status modes report", `since ${new Date(since).toLocaleString()}`);

    if (built.arms.length === 0) {
        out.println(
            "No status events in this window: the shadow run is off (diff.status.shadow.modes is empty), or the metrics store has none yet."
        );
        return;
    }

    printReport(built, gateRows);
}

/** `tools agents hooks diff modes list|try|report`. */
export function registerStatusModeCommands(diff: Command): void {
    const modes = diff
        .command("modes")
        .description("The status modes of the diff hooks: their arms, a trial read, the shadow report");

    modes
        .command("list")
        .description(
            "The arms the config gives (active, reference, shadow) and whether each watch driver is installed; opens nothing"
        )
        .option("--json", "print the answer as JSON")
        .action((flags: { json?: boolean }) => list(flags));

    modes
        .command("try [root]")
        .description(
            "Read the Git state of one worktree once with every arm (every mode and driver) and compare each to the git arm. It may open a watch in the GenesisTools service, ask the service to start when none runs, and write the narrow-git admission record"
        )
        .option("--json", "print the answer as JSON")
        .action((root: string | undefined, flags: { json?: boolean }) => tryArms(root, flags));

    modes
        .command("report")
        .description(
            "The shadow run per arm from the metrics store: answered share, parity, cost, the gates of its mode and the differences by cause. Reads only and switches nothing"
        )
        .option("--since <when>", "from this long ago (6h, 7d) or this date", "7d")
        .option("--json", "print the answer as JSON")
        .action((flags: { since?: string; json?: boolean }) => report(flags));
}
