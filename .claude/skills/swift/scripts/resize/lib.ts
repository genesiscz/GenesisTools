// Shared by the resize scripts: the installed app, the live hub's pid, its accessibility edges, the pointer-drag
// binary (built once, through the app launcher so the Accessibility grant applies) and the perf log tail.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisAppLauncherPath } from "@genesiscz/utils/macos/genesis-app";
import { listPsRows } from "@genesiscz/utils/process/ps";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

export const APP = genesisAppLauncherPath();
export const LOG = genesisToolsDir("logs", "app-perf.log");

export const sh = (argv: string[]) => {
    const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    return `${p.stdout}${p.stderr}`;
};

/// The live hub's pid (the process table through the kit's reader, not a `pgrep` per call).
export async function hubPid(): Promise<string> {
    const row = (await listPsRows()).find((r) => r.command.includes("MacOS/GenesisTools --hub"));
    return row ? String(row.pid) : "";
}

/// The flags that open a mode with something to resize: `--pr <ref>` for PRs, `--worktree <path>` for Worktrees.
export function modeArgs(mode: string, opts: { pr?: string; worktree?: string }): string[] {
    if (mode === "prs") {
        return ["--mode", "prs", ...(opts.pr ? ["--pr", opts.pr] : [])];
    }
    if (mode === "worktrees") {
        return ["--mode", "worktrees", "--worktree", opts.worktree ?? process.cwd()];
    }
    return ["--mode", mode];
}

/// Switches the live hub (one hub runs at a time; a second launch hands its flags over) without taking focus.
export const openHub = (mode: string, opts: { pr?: string; worktree?: string }) =>
    sh([APP, "--hub", ...modeArgs(mode, opts), "--no-activate"]);

export type Edge = { desc: string; x: number; y: number; w: number; h: number };

/// The resize edges of the live hub: the accessibility elements labelled "Resize <title>", long and thin.
export async function resizeEdges(): Promise<Edge[]> {
    const out = sh(["tools", "control", "dump", "--app", await hubPid()]);
    const j = SafeJSON.parse(out.slice(out.indexOf("{")), { strict: true }) as { elements: Edge[] };
    return j.elements.filter(
        (e) => typeof e.desc === "string" && /^Resize /.test(e.desc) && e.w > 0 && e.h > 0 && Math.max(e.w, e.h) > 100
    );
}

/// Where to put the pointer for an edge, and which way the drag runs: `vertical` is a horizontal edge dragged
/// up or down; `along` is the fixed coordinate, `across` the one the drag moves.
export function dragGeometry(e: Edge) {
    const vertical = e.w > e.h;
    const along = vertical ? Math.round(e.x + Math.min(e.w / 2, 160)) : Math.round(e.y + e.h / 2);
    const across = vertical ? e.y + e.h / 2 : e.x + e.w / 2;
    return { vertical, along, across };
}

/// The pointer-drag binary, built once from pointer-drag.swift into the user's cache (a test never makes an
/// executable per run: a fresh file's first start waits on syspolicyd, which froze the Mac on 2026-10-14).
export function dragBinary(): string {
    const dir = genesisToolsDir("cache", "swift-scripts");
    const bin = `${dir}/pointer-drag`;
    const src = `${import.meta.dir}/pointer-drag.swift`;
    if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
        mkdirSync(dir, { recursive: true });
        const built = Bun.spawnSync(["swiftc", "-O", "-o", bin, src], { stdout: "pipe", stderr: "pipe" });
        if (built.exitCode !== 0) {
            throw new Error(`swiftc failed: ${built.stderr}`);
        }
    }
    return bin;
}

/// Drags the real pointer: out to `across + delta` over `out` seconds, back to `across` over `back` seconds.
export function drag(e: Edge, delta: number, out: number, back: number) {
    const g = dragGeometry(e);
    return Bun.spawn(
        [
            APP,
            dragBinary(),
            g.vertical ? "y" : "x",
            String(g.along),
            String(g.across),
            String(g.across + delta),
            String(out),
            String(g.across),
            String(back),
        ],
        { stdout: "ignore", stderr: "ignore" }
    );
}

export const focusHub = async () => sh(["tools", "control", "window", "--app", await hubPid(), "--action", "focus"]);

export const logSize = () => statSync(LOG).size;

/// The hub's own verdict on a drag: its `hub.resize <panel> a->b pt: N steps …` line (none: the pointer hit
/// something else) and the `…release main busy` line after it.
export function dragLines(since: number) {
    const lines = readFileSync(LOG).subarray(since).toString().split("\n");
    const step = lines.find((l) => /mark hub\.resize (panel|prThreads)/.test(l));
    const release = lines.find((l) => /resize\..*\.release main busy/.test(l));
    return {
        step: step?.replace(/^.*mark hub\.resize /, "").slice(0, 120),
        release: release?.replace(/^.*mark hub\./, "").slice(0, 100),
    };
}

export function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
}
