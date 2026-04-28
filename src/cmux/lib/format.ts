import pc from "picocolors";
import { formatBytes } from "@app/utils/format";
import { stripAnsi } from "@app/utils/string";
import type { Pane, Profile, ProfileSummary, Surface } from "@app/cmux/lib/types";

const TREE_VERTICAL = pc.dim("│");
const TREE_BRANCH = pc.dim("├─");
const TREE_LAST = pc.dim("└─");
const TREE_GAP = pc.dim("  ");

export function renderProfileList(summaries: ProfileSummary[]): string {
    if (summaries.length === 0) {
        return pc.dim("(no profiles saved yet)");
    }

    const rows: string[][] = [
        [
            pc.bold("name"),
            pc.bold("scope"),
            pc.bold("captured"),
            pc.bold("W"),
            pc.bold("Ws"),
            pc.bold("P"),
            pc.bold("S"),
            pc.bold("size"),
            pc.bold("note"),
        ],
    ];
    for (const s of summaries) {
        rows.push([
            pc.cyan(s.name),
            scopeLabel(s.scope),
            pc.dim(relativeIso(s.captured_at)),
            String(s.windows),
            String(s.workspaces),
            String(s.panes),
            String(s.surfaces),
            pc.dim(formatBytes(s.bytes)),
            s.note ? pc.dim(truncate(s.note, 40)) : pc.dim("—"),
        ]);
    }
    return renderTable(rows);
}

export function renderProfileTree(profile: Profile): string {
    const lines: string[] = [];
    const header = `${pc.bold(pc.cyan(profile.name))} ${pc.dim(`(${profile.scope})`)}  ${pc.dim(profile.captured_at)}`;
    lines.push(header);
    if (profile.note) {
        lines.push(pc.dim(`note: ${profile.note}`));
    }
    lines.push(pc.dim(`cmux ${profile.cmux_version}  ·  ${profile.windows.length} window(s)`));
    lines.push("");

    profile.windows.forEach((window, wi) => {
        const isLastWindow = wi === profile.windows.length - 1;
        const windowPrefix = isLastWindow ? TREE_LAST : TREE_BRANCH;
        lines.push(
            `${windowPrefix} ${pc.bold(window.title || window.ref)} ${pc.dim(`${window.container_frame.width.toFixed(0)}×${window.container_frame.height.toFixed(0)} px`)}`,
        );

        const childIndent = isLastWindow ? "   " : `${TREE_VERTICAL}  `;
        window.workspaces.forEach((ws, wsIndex) => {
            const isLastWs = wsIndex === window.workspaces.length - 1;
            const wsPrefix = isLastWs ? TREE_LAST : TREE_BRANCH;
            const wsBadge = ws.selected ? pc.green(" ★") : "";
            lines.push(
                `${childIndent}${wsPrefix} ${pc.cyan(ws.title)}${wsBadge} ${pc.dim(`(${ws.panes.length} pane${ws.panes.length === 1 ? "" : "s"})`)}`,
            );
            const wsChildIndent = childIndent + (isLastWs ? "   " : `${TREE_VERTICAL}  `);
            ws.panes.forEach((pane, pi) => {
                const isLastPane = pi === ws.panes.length - 1;
                const panePrefix = isLastPane ? TREE_LAST : TREE_BRANCH;
                lines.push(`${wsChildIndent}${panePrefix} ${formatPaneHeader(pane)}`);
                const paneChildIndent = wsChildIndent + (isLastPane ? "   " : `${TREE_VERTICAL}  `);
                pane.surfaces.forEach((surface, si) => {
                    const isLastSurface = si === pane.surfaces.length - 1;
                    const surfacePrefix = isLastSurface ? TREE_LAST : TREE_BRANCH;
                    const star = si === pane.selected_surface_index ? pc.green("★") : pc.dim("·");
                    lines.push(`${paneChildIndent}${surfacePrefix} ${star} ${formatSurface(surface)}`);
                });
            });
        });
    });

    return lines.join("\n");
}

function formatPaneHeader(pane: Pane): string {
    const dims = pc.dim(`${pane.columns}×${pane.rows}`);
    const px = pc.dim(
        `@(${pane.pixel_frame.x.toFixed(0)},${pane.pixel_frame.y.toFixed(0)}) ${pane.pixel_frame.width.toFixed(0)}×${pane.pixel_frame.height.toFixed(0)}px`,
    );
    return `${pc.bold(`pane ${pane.index}`)} ${dims} ${px}`;
}

function formatSurface(surface: Surface): string {
    const title = pc.white(truncate(surface.title || "(untitled)", 60));
    if (surface.type === "browser") {
        const url = surface.url ? pc.dim(` → ${truncate(surface.url, 60)}`) : pc.dim(" (no url)");
        return `${pc.magenta("browser")} ${title}${url}`;
    }
    const cwd = surface.cwd ? pc.dim(` cwd=${truncate(surface.cwd, 50)}`) : "";
    const screen = surface.screen
        ? pc.dim(` screen=${surface.screen.rows}r/${formatBytes(Buffer.byteLength(surface.screen.text, "utf8"))}`)
        : "";
    const cmd =
        surface.command && surface.command_source && surface.command_source !== "none"
            ? pc.dim(` cmd[${surface.command_source}]=${truncate(surface.command, 40)}`)
            : "";
    return `${pc.yellow("term")} ${title}${cwd}${screen}${cmd}`;
}

function scopeLabel(scope: string): string {
    if (scope === "all") {
        return pc.green("all");
    }
    if (scope === "window") {
        return pc.blue("window");
    }
    return pc.magenta("workspace");
}

function relativeIso(iso: string): string {
    return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function truncate(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max - 1)}…`;
}

function renderTable(rows: string[][]): string {
    const widths: number[] = [];
    for (const row of rows) {
        row.forEach((cell, i) => {
            const visibleLength = stripAnsi(cell).length;
            if (widths[i] === undefined || visibleLength > widths[i]) {
                widths[i] = visibleLength;
            }
        });
    }
    return rows
        .map((row) =>
            row
                .map((cell, i) => {
                    const visible = stripAnsi(cell).length;
                    return cell + " ".repeat(widths[i] - visible);
                })
                .join("  "),
        )
        .join("\n");
}

