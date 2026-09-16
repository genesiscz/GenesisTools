import { out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type AuditedApp,
    type CapabilityRoute,
    type ControlAuditReport,
    type ControlDoctorReport,
    controlAudit,
    controlDoctor,
    type GrantStatus,
    type PermissionCheck,
} from "../lib/permissions";

function statusCell(status: GrantStatus): string {
    switch (status) {
        case "granted":
            return formatDotStatus("ok", "granted");
        case "denied":
            return formatDotStatus("err", "denied");
        case "not-determined":
            return formatDotStatus("warn", "not determined");
        default:
            return formatDotStatus("dim", "unknown");
    }
}

function flagCell(value: string): string {
    if (value === "on") {
        return formatDotStatus("warn", "on");
    }

    if (value === "off") {
        return formatDotStatus("ok", "off");
    }

    return formatDotStatus("dim", value);
}

function printChecks(checks: PermissionCheck[]): void {
    const table = createBoxTable(["GRANT", "STATUS", "IDENTITY THAT NEEDS IT", "USED BY", "SOURCE"]);

    for (const check of checks) {
        table.push([
            pc.white(check.label),
            statusCell(check.status),
            truncateDisplay(check.identity, 48),
            truncateDisplay(check.usedBy, 36),
            truncateDisplay(check.source, 56),
        ]);
    }

    out.println(table.toString());

    for (const check of checks) {
        out.println(`  ${pc.dim(check.label.padEnd(17))} ${check.detail}`);

        for (const target of check.targets ?? []) {
            out.println(
                `  ${"".padEnd(17)} ${target.granted ? pc.green("●") : pc.dim("●")} ${target.target}: ${target.label}`
            );
        }
    }
}

function printResponsible(report: ControlDoctorReport | ControlAuditReport): void {
    renderCliSection("Responsible process");
    const route = report.responsible;
    out.println(`  ${pc.dim("identity".padEnd(12))} ${route.identity}`);
    out.println(`  ${pc.dim("launcher".padEnd(12))} ${route.launcher ?? `none (${route.reason ?? "not routed"})`}`);

    if (report.live) {
        out.println(
            `  ${pc.dim("live probe".padEnd(12))} pid ${report.live.responsiblePid} is responsible (${report.live.responsibleBundleId || report.live.responsiblePath || "no bundle"})`
        );
    } else {
        out.println(`  ${pc.dim("live probe".padEnd(12))} ${pc.red(report.liveError ?? "failed")}`);
    }

    out.println();
}

function printVerdict(report: ControlDoctorReport | ControlAuditReport): void {
    renderCliSection("Verdict");

    for (const finding of report.findings) {
        out.println(`  ${pc.yellow("⚠")} ${finding}`);
    }

    if (report.problems.length === 0) {
        out.println(`  ${pc.green("✓")} every grant tools control needs is held by GenesisTools.app`);
        return;
    }

    for (const problem of report.problems) {
        out.println(`  ${pc.red("✗")} ${problem}`);
    }
}

function printDoctor(report: ControlDoctorReport): void {
    renderCliHeader(
        "tools control doctor",
        "Accessibility, Screen Recording and Automation, each with the identity that holds it"
    );
    printResponsible(report);
    renderCliSection("Grants");
    printChecks(report.checks);
    out.println();
    printVerdict(report);
}

function printRoutes(routes: CapabilityRoute[]): void {
    renderCliSection("What each capability runs through");
    const table = createBoxTable(["CAPABILITY", "COMMANDS", "BINARY", "GRANTS OF"]);

    for (const route of routes) {
        table.push([
            pc.white(route.capability),
            truncateDisplay(route.commands, 48),
            truncateDisplay(route.binary, 40),
            truncateDisplay(route.identity, 48),
        ]);
    }

    out.println(table.toString());

    for (const route of routes) {
        out.println(`  ${pc.dim(truncateDisplay(route.capability, 34).padEnd(34))} ${route.note}`);
    }

    out.println();
}

function printFlaggedApps(report: ControlAuditReport): void {
    renderCliSection("Apps carrying an accessibility flag");
    const flagged = report.apps.filter((a) => a.manualAccessibility === "on" || a.enhancedUserInterface === "on");

    if (report.appsError) {
        out.println(`  ${pc.red("✗")} ${report.appsError}`);
        out.println();
        return;
    }

    if (flagged.length === 0) {
        out.println(
            `  ${pc.green("✓")} none of ${report.apps.length} apps has AXManualAccessibility or AXEnhancedUserInterface set`
        );
    } else {
        const table = createBoxTable([
            "APP",
            "PID",
            "BUNDLE ID",
            "AXManualAccessibility",
            "AXEnhancedUserInterface",
            "SET BY",
        ]);

        for (const app of flagged) {
            table.push([
                pc.white(truncateDisplay(app.name, 28)),
                String(app.pid),
                truncateDisplay(app.bundleId, 36),
                flagCell(app.manualAccessibility),
                flagCell(app.enhancedUserInterface),
                setBy(app),
            ]);
        }

        out.println(table.toString());
    }

    out.println(
        `  ${pc.dim(`${report.apps.length} apps read live; ${report.manualAccessibilityOn.length} with AXManualAccessibility on, ${report.enhancedUserInterfaceOn.length} with AXEnhancedUserInterface on, ${report.unreachable} not answering AX, ${report.unsupported} attribute reads unsupported`)}`
    );
    out.println(
        `  ${pc.dim("AXManualAccessibility: tools control writes it into every --app target and nothing clears it (native/ax-tool/Sources/main.swift resolveApp). AXEnhancedUserInterface: tools control never writes it.")}`
    );
    out.println();
}

function setBy(app: AuditedApp): string {
    const parts: string[] = [];

    if (app.manualAccessibility === "on") {
        parts.push("an assistive client; tools control does this on every --app call");
    }

    if (app.enhancedUserInterface === "on") {
        parts.push("NOT tools control (a VoiceOver-style client)");
    }

    return truncateDisplay(parts.join("; "), 60);
}

function printPeekaboo(report: ControlAuditReport): void {
    renderCliSection("peekaboo (capture backend, optional)");
    const pk = report.peekaboo;

    if (!pk.installed) {
        out.println(`  ${pc.dim("not installed; the native ax-tool recorder covers capture")}`);
        out.println();
        return;
    }

    out.println(`  ${pc.dim("binary".padEnd(12))} ${pk.path}`);

    if (pk.local) {
        const line = pk.local
            .map((g) => `${g.name}: ${g.granted ? pc.green("granted") : pc.red("not granted")}`)
            .join(", ");
        out.println(`  ${pc.dim("local".padEnd(12))} ${line} (spawned the way tools control spawns it)`);
    } else {
        out.println(`  ${pc.dim("local".padEnd(12))} ${pc.red(pk.localError ?? "probe failed")}`);
    }

    const own = pk.ownTcc.map(
        (r) => `${r.client} ${r.service.replace("kTCCService", "")}${r.target ? ` -> ${r.target}` : ""}: ${r.label}`
    );
    out.println(
        `  ${pc.dim("own TCC".padEnd(12))} ${own.length ? own.join("; ") : "no rows for Peekaboo's own identities"}`
    );
    out.println(
        `  ${pc.dim("bridge".padEnd(12))} the default peekaboo transport is the Peekaboo.app daemon (boo.peekaboo.mac) and uses ITS grants, not GenesisTools.app; not probed here because probing would start the daemon`
    );
    out.println();
}

function printAudit(report: ControlAuditReport): void {
    renderCliHeader(
        "tools control audit",
        "where control changed app metadata, and which identity holds each grant it uses"
    );
    printResponsible(report);
    printFlaggedApps(report);
    renderCliSection("Grants");
    printChecks(report.checks);
    out.println();
    printRoutes(report.routes);
    printPeekaboo(report);
    renderCliSection("DarwinKit");
    out.println(`  ${report.darwinkit}`);
    out.println();
    printVerdict(report);
}

export function registerPermissionsCommands(program: Command): void {
    program
        .command("doctor")
        .description(
            "Accessibility, Screen Recording and Automation for tools control, each as granted/denied/not determined with the identity that needs it. Read-only, never prompts; exits 1 while something is missing."
        )
        .option("--json", "raw JSON output")
        .action((opts: { json?: boolean }) => {
            const report = controlDoctor();

            if (opts.json) {
                out.result(report);
            } else {
                printDoctor(report);
            }

            if (report.problems.length > 0) {
                process.exitCode = 1;
            }
        });

    program
        .command("audit")
        .description(
            "Everything tools control changed or depends on: running apps with AXManualAccessibility / AXEnhancedUserInterface set (read live, without touching them), the grants and the identity holding each, and which binary every capability runs through. Read-only."
        )
        .option("--all", "include background-only processes (default: apps with a UI)")
        .option("--json", "raw JSON output")
        .action((opts: { all?: boolean; json?: boolean }) => {
            const report = controlAudit({ all: opts.all });

            if (opts.json) {
                out.result(report);
            } else {
                printAudit(report);
            }

            if (report.problems.length > 0) {
                process.exitCode = 1;
            }
        });
}
