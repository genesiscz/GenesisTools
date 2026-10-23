import { suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    GENESIS_LINK_KINDS,
    type GenesisLinkKind,
    type GenesisToolsProbe,
    type LinkState,
    linkState,
    probeGenesisTools,
    readProbeFacts,
} from "@genesiscz/utils/genesis-tools/probe";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const PARTS = ["tools", "app", "router", "markdown", "cmux"] as const;
type Part = (typeof PARTS)[number];
const NAMES: readonly string[] = [...PARTS, ...GENESIS_LINK_KINDS];

/** The router preset that writes each link kind's route. */
const PRESET_OF: Record<GenesisLinkKind, string> = {
    md: "genesis-md",
    finder: "finder",
    hub: "genesis-hub",
    "claude-find": "claude-find",
};

interface Row {
    name: string;
    ok: boolean;
    detail: string;
    fix: string | null;
}

function partRow(part: Part, probe: GenesisToolsProbe): Row {
    const install = toolCommand("browser-router install");

    switch (part) {
        case "tools":
            return {
                name: part,
                ok: probe.tools.path !== null,
                detail: probe.tools.path ?? "no checkout found",
                fix: null,
            };
        case "app":
            return {
                name: part,
                ok: probe.app.installed,
                detail: probe.app.installed ? probe.app.path : `not at ${probe.app.path}`,
                fix: probe.app.installed ? null : install,
            };
        case "router": {
            const { defaultHandler, httpsHandler, linkHost } = probe.router;
            const ok = defaultHandler && linkHost !== null;
            const detail = !defaultHandler
                ? `https opens in ${httpsHandler ?? "no app"}`
                : linkHost
                  ? `https handler, link host ${linkHost}`
                  : "https handler, no link host";
            const fix = !defaultHandler ? install : linkHost ? null : toolCommand("browser-router link-host", "<host>");

            return { name: part, ok, detail, fix };
        }
        case "markdown":
            return {
                name: part,
                ok: probe.markdown.path !== null,
                detail: probe.markdown.path ?? "no app opens Genesis Markdown links",
                fix: probe.markdown.path ? null : "install Genesis Markdown",
            };
        case "cmux":
            return { name: part, ok: probe.cmux.path !== null, detail: probe.cmux.path ?? "not installed", fix: null };
    }
}

function fixFor(kind: GenesisLinkKind | null, state: LinkState): string | null {
    switch (state.problem) {
        case null:
        case "not-darwin":
            return null;
        case "app-missing":
        case "not-https-handler":
            return toolCommand("browser-router install");
        case "no-link-host":
            return toolCommand("browser-router link-host", "<host>");
        case "no-route":
            return kind
                ? toolCommand("browser-router presets enable", PRESET_OF[kind])
                : toolCommand("browser-router presets");
        case "target-missing":
            return kind === "md" ? "install Genesis Markdown" : null;
    }
}

function linkRow(kind: GenesisLinkKind, state: LinkState): Row {
    return {
        name: `${kind} links`,
        ok: state.opens,
        detail: state.opens ? (state.action ?? "") : (state.reason ?? ""),
        fix: fixFor(kind, state),
    };
}

function printRows(rows: Row[]): void {
    const table = createBoxTable(["PART", "STATE", "DETAIL"]);

    for (const row of rows) {
        table.push([row.name, formatDotStatus(row.ok ? "ok" : "err", row.ok ? "ok" : "missing"), row.detail]);
    }

    out.println(table.toString());

    for (const row of rows.filter((row) => !row.ok && row.fix)) {
        out.println(`${pc.yellow(row.name)}: ${row.fix}`);
    }
}

export function registerProbeCommand(program: Command): void {
    program
        .command("probe")
        .description(
            "What of GenesisTools this Mac has (the CLI, the app, the link router, Genesis Markdown, cmux) and which " +
                "genesis.tools links a click opens; exits 1 when a named part is missing"
        )
        .argument("[names...]", `Parts to check: ${NAMES.join(", ")}`)
        .option("--url <url>", "Whether a click on this one link opens what it names")
        .option("--json", "Print the probe as JSON")
        .action((names: string[], options: { url?: string; json?: boolean }) => {
            if (options.url) {
                const state = linkState(options.url, readProbeFacts());

                if (options.json) {
                    out.result(state);
                } else {
                    printRows([
                        {
                            name: "link",
                            ok: state.opens,
                            detail: state.reason ?? state.action ?? "",
                            fix: fixFor(null, state),
                        },
                    ]);
                }

                process.exitCode = state.opens ? 0 : 1;
                return;
            }

            const unknown = names.filter((name) => !NAMES.includes(name));

            if (unknown.length > 0) {
                out.log.error(`Unknown part: ${unknown.join(", ")}. The parts: ${NAMES.join(", ")}`);
                out.println(suggestCommand("tools genesis-tools", { replaceCommand: ["probe", "md", "finder"] }));
                process.exitCode = 1;
                return;
            }

            const probe = probeGenesisTools();
            const rows = [
                ...PARTS.map((part) => partRow(part, probe)),
                ...GENESIS_LINK_KINDS.map((kind) => linkRow(kind, probe.links[kind])),
            ];
            const picked =
                names.length > 0 ? rows.filter((row) => names.some((name) => row.name.split(" ")[0] === name)) : rows;

            if (options.json) {
                out.result(probe);
            } else {
                renderCliHeader("GenesisTools on this Mac", "parts and links");
                printRows(picked);
            }

            if (names.length > 0 && picked.some((row) => !row.ok)) {
                process.exitCode = 1;
            }
        });
}
