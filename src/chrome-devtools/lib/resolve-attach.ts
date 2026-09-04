import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import {
    currentPlatform,
    defaultExec,
    type ExecFn,
    type ExecResult,
    listListeningTcpPorts,
    listProcesses,
    type Platform,
    tmpRoot,
} from "./platform.ts";

export type { ExecFn, ExecResult };
export { defaultExec };

const { log } = logger.scoped("chrome-devtools:resolve-attach");

export type BrowserId = string;

export type BrowserKind = {
    id: BrowserId;
    /** macOS app name (also the pgrep -x / osascript target there). */
    app: string;
    /** Lowercase substrings that classify a command line as this browser, on any platform. */
    match: string[];
    /** Linux executable names, tried in order on PATH. */
    linuxBins?: string[];
    /** Windows image names (tasklist / taskkill targets), first one is the launch target. */
    winExes?: string[];
};

/** Chromium-family browsers that accept --remote-debugging-port. Same refuse/restart treatment. */
export const BROWSERS: BrowserKind[] = [
    {
        id: "chrome-canary",
        app: "Google Chrome Canary",
        match: ["google chrome canary", "chrome-canary"],
        linuxBins: ["google-chrome-canary"],
    },
    {
        id: "chrome-beta",
        app: "Google Chrome Beta",
        match: ["google chrome beta", "chrome-beta"],
        linuxBins: ["google-chrome-beta"],
    },
    {
        id: "chrome-dev",
        app: "Google Chrome Dev",
        match: ["google chrome dev", "chrome-unstable"],
        linuxBins: ["google-chrome-unstable"],
    },
    {
        id: "chrome",
        app: "Google Chrome",
        match: ["google chrome", "google-chrome", "/opt/google/chrome/", "chrome.exe"],
        linuxBins: ["google-chrome", "google-chrome-stable"],
        winExes: ["chrome.exe"],
    },
    {
        id: "brave-beta",
        app: "Brave Browser Beta",
        match: ["brave browser beta", "brave-browser-beta"],
        linuxBins: ["brave-browser-beta"],
    },
    {
        id: "brave-nightly",
        app: "Brave Browser Nightly",
        match: ["brave browser nightly", "brave-browser-nightly"],
        linuxBins: ["brave-browser-nightly"],
    },
    {
        id: "brave",
        app: "Brave Browser",
        match: ["brave browser", "brave", "brave-browser", "brave.exe"],
        linuxBins: ["brave-browser", "brave"],
        winExes: ["brave.exe"],
    },
    {
        id: "edge-canary",
        app: "Microsoft Edge Canary",
        match: ["microsoft edge canary", "microsoft-edge-canary"],
        linuxBins: ["microsoft-edge-canary"],
    },
    {
        id: "edge-dev",
        app: "Microsoft Edge Dev",
        match: ["microsoft edge dev", "microsoft-edge-dev"],
        linuxBins: ["microsoft-edge-dev"],
    },
    {
        id: "edge-beta",
        app: "Microsoft Edge Beta",
        match: ["microsoft edge beta", "microsoft-edge-beta"],
        linuxBins: ["microsoft-edge-beta"],
    },
    {
        id: "edge",
        app: "Microsoft Edge",
        match: ["microsoft edge", "microsoft-edge", "msedge.exe"],
        linuxBins: ["microsoft-edge", "microsoft-edge-stable"],
        winExes: ["msedge.exe"],
    },
    {
        id: "chromium",
        app: "Chromium",
        match: ["chromium", "chromium.exe"],
        linuxBins: ["chromium", "chromium-browser"],
        winExes: ["chromium.exe"],
    },
    { id: "arc", app: "Arc", match: ["arc.app"] },
    {
        id: "vivaldi",
        app: "Vivaldi",
        match: ["vivaldi", "vivaldi.exe"],
        linuxBins: ["vivaldi", "vivaldi-stable"],
        winExes: ["vivaldi.exe"],
    },
    { id: "opera-gx", app: "Opera GX", match: ["opera gx"] },
    { id: "opera", app: "Opera", match: ["opera", "opera.exe"], linuxBins: ["opera"], winExes: ["opera.exe"] },
    { id: "dia", app: "Dia", match: ["dia.app"] },
    { id: "comet", app: "Comet", match: ["comet.app"] },
];

export const BROWSER_APPS: Record<string, string> = Object.fromEntries(BROWSERS.map((b) => [b.id, b.app]));

export function browserById(id: BrowserId): BrowserKind | undefined {
    return BROWSERS.find((b) => b.id === id);
}

export const CDP_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230];

export const DEVTOOLS_PORT_RELPATHS: { id: BrowserId; rel: string }[] = [
    { id: "chrome", rel: "Library/Application Support/Google/Chrome/DevToolsActivePort" },
    { id: "chrome-canary", rel: "Library/Application Support/Google/Chrome Canary/DevToolsActivePort" },
    { id: "chrome-beta", rel: "Library/Application Support/Google/Chrome Beta/DevToolsActivePort" },
    { id: "chrome-dev", rel: "Library/Application Support/Google/Chrome Dev/DevToolsActivePort" },
    { id: "brave", rel: "Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort" },
    { id: "edge", rel: "Library/Application Support/Microsoft Edge/DevToolsActivePort" },
    { id: "chromium", rel: "Library/Application Support/Chromium/DevToolsActivePort" },
    { id: "arc", rel: "Library/Application Support/Arc/User Data/DevToolsActivePort" },
    { id: "vivaldi", rel: "Library/Application Support/Vivaldi/DevToolsActivePort" },
    { id: "opera", rel: "Library/Application Support/com.operasoftware.Opera/DevToolsActivePort" },
];

const DEVTOOLS_PORT_RELPATHS_LINUX: { id: BrowserId; rel: string }[] = [
    { id: "chrome", rel: ".config/google-chrome/DevToolsActivePort" },
    { id: "chrome-beta", rel: ".config/google-chrome-beta/DevToolsActivePort" },
    { id: "chrome-dev", rel: ".config/google-chrome-unstable/DevToolsActivePort" },
    { id: "brave", rel: ".config/BraveSoftware/Brave-Browser/DevToolsActivePort" },
    { id: "edge", rel: ".config/microsoft-edge/DevToolsActivePort" },
    { id: "chromium", rel: ".config/chromium/DevToolsActivePort" },
    { id: "vivaldi", rel: ".config/vivaldi/DevToolsActivePort" },
];

const DEVTOOLS_PORT_RELPATHS_WIN: { id: BrowserId; rel: string }[] = [
    { id: "chrome", rel: "Google/Chrome/User Data/DevToolsActivePort" },
    { id: "brave", rel: "BraveSoftware/Brave-Browser/User Data/DevToolsActivePort" },
    { id: "edge", rel: "Microsoft/Edge/User Data/DevToolsActivePort" },
    { id: "chromium", rel: "Chromium/User Data/DevToolsActivePort" },
];

export function devtoolsPortRelpaths(platform: Platform): { id: BrowserId; rel: string }[] {
    if (platform === "linux") {
        return DEVTOOLS_PORT_RELPATHS_LINUX;
    }

    if (platform === "win32") {
        return DEVTOOLS_PORT_RELPATHS_WIN;
    }

    return DEVTOOLS_PORT_RELPATHS;
}

export function classifyProcessName(comm: string): BrowserId | null {
    const n = comm.toLowerCase();
    const base = (n.split(/[/\\]/).pop() ?? n).trim();
    let best: { id: BrowserId; len: number } | null = null;

    for (const b of BROWSERS) {
        const app = b.app.toLowerCase();
        if (base === app || base === b.id) {
            if (app.length >= (best?.len ?? 0)) {
                best = { id: b.id, len: app.length };
            }
            continue;
        }

        for (const m of [...b.match, ...(b.linuxBins ?? []), ...(b.winExes ?? [])]) {
            if (n.includes(m) && m.length >= (best?.len ?? 0)) {
                best = { id: b.id, len: m.length };
            }
        }
    }

    return best?.id ?? null;
}

/** Parse `tasklist /FO CSV /NH` image names. Exported for tests. */
export function parseTasklistImages(stdout: string): Set<string> {
    const names = new Set<string>();
    for (const line of stdout.split("\n")) {
        const m = line.match(/^"([^"]+)"/);
        if (m) {
            names.add(m[1].toLowerCase());
        }
    }

    return names;
}

export function listRunningBrowsers(exec: ExecFn = defaultExec, platform: Platform = currentPlatform()): BrowserId[] {
    if (platform === "win32") {
        const r = exec(["tasklist", "/FO", "CSV", "/NH"]);
        const images = r.exitCode === 0 ? parseTasklistImages(r.stdout) : new Set<string>();

        return BROWSERS.filter((b) => (b.winExes ?? []).some((exe) => images.has(exe))).map((b) => b.id);
    }

    if (platform === "linux") {
        return BROWSERS.filter((b) => (b.linuxBins ?? []).some((bin) => exec(["pgrep", "-x", bin]).exitCode === 0)).map(
            (b) => b.id
        );
    }

    const found: BrowserId[] = [];
    for (const b of BROWSERS) {
        const r = exec(["pgrep", "-x", b.app]);
        if (r.exitCode === 0) {
            found.push(b.id);
        }
    }

    return found;
}

export function isPortSpecified(argv: string[] = process.argv): boolean {
    return argv.some((a) => a === "--port" || a.startsWith("--port="));
}

export function parseRemoteDebuggingPort(commandLine: string): {
    present: boolean;
    empty: boolean;
    port: number | null;
} {
    const eq = commandLine.match(/--remote-debugging-port=(\S*)/);
    if (eq) {
        const raw = eq[1];
        if (!raw) {
            return { present: true, empty: true, port: null };
        }

        const port = Number(raw);
        if (Number.isFinite(port) && port > 0) {
            return { present: true, empty: false, port };
        }

        return { present: true, empty: true, port: null };
    }

    if (commandLine.includes("--remote-debugging-port")) {
        const spaced = commandLine.match(/--remote-debugging-port(?:\s+|$)(\d+)?/);
        const raw = spaced?.[1];
        if (raw) {
            return { present: true, empty: false, port: Number(raw) };
        }

        return { present: true, empty: true, port: null };
    }

    return { present: false, empty: false, port: null };
}

export function browsersWithEmptyDebugFlag(
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): BrowserId[] {
    const found: BrowserId[] = [];
    for (const proc of listProcesses(exec, platform)) {
        const flag = parseRemoteDebuggingPort(proc.command);
        if (!flag.present || !flag.empty) {
            continue;
        }

        const id = classifyProcessName(proc.command);
        if (id && !found.includes(id)) {
            found.push(id);
        }
    }

    return found;
}

export function discoverListeningCdpPorts(
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): number[] {
    const listeners = listListeningTcpPorts(exec, platform).filter((l) => l.port >= 9000 && l.port <= 9999);
    if (listeners.length === 0) {
        return [];
    }

    const commandOf = new Map(listProcesses(exec, platform).map((p) => [p.pid, p.command]));
    const ports = new Set<number>();
    for (const l of listeners) {
        const command = l.pid !== null ? commandOf.get(l.pid) : undefined;
        if (command && classifyProcessName(command)) {
            ports.add(l.port);
        }
    }

    return [...ports].sort((a, b) => a - b);
}

export function ownerOfPort(
    port: number,
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): BrowserId | null {
    const listener = listListeningTcpPorts(exec, platform).find((l) => l.port === port);
    if (!listener || listener.pid === null) {
        return null;
    }

    const command = listProcesses(exec, platform).find((p) => p.pid === listener.pid)?.command;

    return command ? classifyProcessName(command) : null;
}

export function readDevToolsActivePorts(opts: {
    home: string;
    readFile: (abs: string) => string | null;
    platform?: Platform;
}): number[] {
    const ports: number[] = [];
    for (const { rel } of devtoolsPortRelpaths(opts.platform ?? currentPlatform())) {
        const text = opts.readFile(`${opts.home}/${rel}`);
        if (!text) {
            continue;
        }

        const port = Number(text.split("\n")[0]?.trim());
        if (Number.isFinite(port) && port > 0) {
            ports.push(port);
        }
    }

    return ports;
}

export function mergeProbePorts(...groups: number[][]): number[] {
    return [...new Set(groups.flat())].sort((a, b) => a - b);
}

export function readDevToolsActivePortsFromDisk(home?: string, platform: Platform = currentPlatform()): number[] {
    const base = home ?? (platform === "win32" ? (env.get("LOCALAPPDATA") ?? "") : env.paths.getHome());

    return readDevToolsActivePorts({
        home: base,
        platform,
        readFile: (abs) => {
            if (!existsSync(abs)) {
                return null;
            }

            try {
                return readFileSync(abs, "utf8");
            } catch (err) {
                // A permissions/IO failure here makes a RUNNING browser
                // undiscoverable — worth a trace even though it is non-fatal.
                log.debug({ err, path: abs }, "DevToolsActivePort read failed");

                return null;
            }
        },
    });
}

export async function waitForCdp(opts: {
    port: number;
    timeoutMs?: number;
    probe: (port: number) => Promise<unknown>;
    sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 20000;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await opts.probe(opts.port)) {
            return true;
        }

        await sleep(500);
    }

    return false;
}

export async function quitBrowser(opts: {
    app: string;
    browser?: BrowserKind;
    force?: boolean;
    timeoutMs?: number;
    exec?: ExecFn;
    sleep?: (ms: number) => Promise<void>;
    platform?: Platform;
}): Promise<{ exited: boolean; usedForce: boolean }> {
    const exec = opts.exec ?? defaultExec;
    const platform = opts.platform ?? currentPlatform();
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const timeoutMs = opts.timeoutMs ?? 15000;

    const linuxBins = opts.browser?.linuxBins ?? [];
    const winExe = opts.browser?.winExes?.[0];

    const dead = (): boolean => {
        if (platform === "win32") {
            if (!winExe) {
                return true;
            }

            const r = exec(["tasklist", "/FO", "CSV", "/NH", "/FI", `IMAGENAME eq ${winExe}`]);

            return !parseTasklistImages(r.stdout).has(winExe);
        }

        if (platform === "linux") {
            return linuxBins.every((bin) => exec(["pgrep", "-x", bin]).exitCode !== 0);
        }

        return exec(["pgrep", "-x", opts.app]).exitCode !== 0;
    };

    if (platform === "win32") {
        if (winExe) {
            exec(["taskkill", "/IM", winExe]);
        }
    } else if (platform === "linux") {
        for (const bin of linuxBins) {
            exec(["pkill", "-TERM", "-x", bin]);
        }
    } else {
        exec(["osascript", "-e", `quit app "${opts.app}"`]);
    }

    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (dead()) {
            return { exited: true, usedForce: false };
        }

        await sleep(250);
    }

    if (!opts.force) {
        return { exited: dead(), usedForce: false };
    }

    if (platform === "win32") {
        if (winExe) {
            exec(["taskkill", "/F", "/IM", winExe]);
        }
    } else if (platform === "linux") {
        for (const bin of linuxBins) {
            exec(["pkill", "-KILL", "-x", bin]);
        }
    } else {
        const pids = exec(["pgrep", "-x", opts.app]).stdout.trim().split("\n").filter(Boolean);
        if (pids.length) {
            exec(["kill", "-KILL", ...pids]);
        }
    }

    const forceUntil = Date.now() + 5000;
    while (Date.now() < forceUntil) {
        if (dead()) {
            return { exited: true, usedForce: true };
        }

        await sleep(250);
    }

    return { exited: dead(), usedForce: true };
}

const WIN_INSTALL_ROOTS = () =>
    [env.get("ProgramFiles"), env.get("ProgramFiles(x86)"), env.get("LOCALAPPDATA")].filter((v): v is string =>
        Boolean(v)
    );

const WIN_EXE_RELPATHS: Record<string, string> = {
    "chrome.exe": "Google/Chrome/Application/chrome.exe",
    "brave.exe": "BraveSoftware/Brave-Browser/Application/brave.exe",
    "msedge.exe": "Microsoft/Edge/Application/msedge.exe",
};

/** Detached fire-and-forget spawn — injectable so tests can pin argv per platform. */
export type SpawnDetachedFn = (cmd: string[]) => void;

const defaultSpawnDetached: SpawnDetachedFn = (cmd) => {
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
};

/**
 * The real executable for a browser, or null when it is not installed here.
 *
 * darwin resolves the binary INSIDE the .app bundle (Chromium apps name it
 * exactly like the app). `launchBrowser` does not need that — `open -na`
 * takes the app name — but a caller that must own the browser's stdio does:
 * `open` cannot pipe it, and an all-ignore stdio stalls Chrome before the CDP
 * port opens (see lib/launch.ts).
 */
export function browserExecutable(opts: {
    browser: BrowserKind;
    platform?: Platform;
    exec?: ExecFn;
    fileExists?: (path: string) => boolean;
    home?: string;
}): string | null {
    const platform = opts.platform ?? currentPlatform();
    const fileExists = opts.fileExists ?? existsSync;

    if (platform === "darwin") {
        const home = opts.home ?? env.paths.getHome();
        for (const root of ["/Applications", join(home, "Applications")]) {
            const bin = join(root, `${opts.browser.app}.app`, "Contents", "MacOS", opts.browser.app);
            if (fileExists(bin)) {
                return bin;
            }
        }

        return null;
    }

    if (platform === "linux") {
        const exec = opts.exec ?? defaultExec;

        return (opts.browser.linuxBins ?? []).find((b) => exec(["which", b]).exitCode === 0) ?? null;
    }

    const exe = opts.browser.winExes?.[0];
    if (!exe) {
        return null;
    }

    const rel = WIN_EXE_RELPATHS[exe];
    const full = rel
        ? WIN_INSTALL_ROOTS()
              .map((root) => join(root, rel))
              .find((p) => fileExists(p))
        : undefined;

    return full ?? exe;
}

/**
 * Launch a browser with the given args, per platform. darwin: `open -na` (the
 * only way that respects app bundles); linux: first bin on PATH, detached;
 * win32: known install path or the exe name.
 */
export function launchBrowser(opts: {
    browser: BrowserKind;
    args: string[];
    url: string;
    exec?: ExecFn;
    platform?: Platform;
    spawnDetached?: SpawnDetachedFn;
    fileExists?: (path: string) => boolean;
}): { ok: boolean; message: string } {
    const exec = opts.exec ?? defaultExec;
    const platform = opts.platform ?? currentPlatform();
    const spawnDetached = opts.spawnDetached ?? defaultSpawnDetached;

    if (platform === "darwin") {
        const r = exec(["open", "-na", opts.browser.app, "--args", ...opts.args, opts.url]);

        return { ok: r.exitCode === 0, message: r.exitCode === 0 ? `launched ${opts.browser.app}` : r.stderr.trim() };
    }

    const bin = browserExecutable({ browser: opts.browser, platform, exec, fileExists: opts.fileExists });

    if (platform === "linux") {
        if (!bin) {
            return {
                ok: false,
                message: `none of [${(opts.browser.linuxBins ?? []).join(", ")}] found on PATH for ${opts.browser.id}`,
            };
        }

        spawnDetached([bin, ...opts.args, opts.url]);

        return { ok: true, message: `launched ${bin}` };
    }

    if (!bin) {
        return { ok: false, message: `${opts.browser.id} has no Windows executable mapping` };
    }

    spawnDetached([bin, ...opts.args, opts.url]);

    return { ok: true, message: `launched ${bin}` };
}

/** The isolated profile dir `open --fresh` / `--extension` uses. */
export function freshProfileDir(port: number, platform: Platform = currentPlatform()): string {
    return join(tmpRoot(platform), `cdp-profile-${port}`);
}

export type Endpoint = {
    port: number;
    browser: string;
    owner: BrowserId | null;
    pages: { title: string; url: string }[];
};

export type Inventory = {
    running: BrowserId[];
    endpoints: Endpoint[];
    emptyDebugFlag?: BrowserId[];
};

export type AttachPlan = {
    status: "list" | "none" | "ambiguous";
    running: BrowserId[];
    endpoints: Endpoint[];
    undebugged: BrowserId[];
    emptyDebugFlag: BrowserId[];
    restartPort: number;
};

export function pickRestartPort(used: number[]): number {
    for (const port of [...CDP_PORTS, 9226, 9227]) {
        if (!used.includes(port)) {
            return port;
        }
    }

    return Math.max(0, ...used) + 1;
}

export function planAttach(inventory: Inventory, opts?: { explicitPort?: number }): AttachPlan {
    const undebugged = inventory.running.filter((id) => !inventory.endpoints.some((e) => e.owner === id));
    const emptyDebugFlag = (inventory.emptyDebugFlag ?? []).filter((id) => undebugged.includes(id));
    const restartPort = pickRestartPort(inventory.endpoints.map((e) => e.port));
    const kinds = new Set<BrowserId>([
        ...inventory.running,
        ...inventory.endpoints.map((e) => e.owner).filter((id): id is BrowserId => id != null),
    ]);
    const base = {
        running: inventory.running,
        undebugged,
        emptyDebugFlag,
        restartPort,
    };

    if (opts?.explicitPort != null) {
        const endpoints = inventory.endpoints.filter((e) => e.port === opts.explicitPort);

        return {
            ...base,
            status: endpoints.length ? "list" : "none",
            endpoints,
        };
    }

    if (kinds.size >= 2) {
        return { ...base, status: "ambiguous", endpoints: inventory.endpoints };
    }

    if (!inventory.endpoints.length) {
        return { ...base, status: "none", endpoints: [] };
    }

    return { ...base, status: "list", endpoints: inventory.endpoints };
}

function truncate(s: string, n: number) {
    return s.length > n ? s.slice(0, n) : s;
}

function renderEndpoint(e: Endpoint): string[] {
    const lines = [`  port ${e.port}: ${e.browser}: ${e.pages.length} page(s)`];
    e.pages.forEach((p, i) => {
        lines.push(`    [${i}] ${truncate(p.title ?? "", 50)} :: ${truncate(p.url, 110)}`);
    });

    return lines;
}

function restartLines(id: BrowserId, port: number, cmd: string, platform: Platform): string[] {
    const app = BROWSER_APPS[id];
    const lines = [
        `  --remote-debugging-port is read at startup only. Restart ${app} with it (costs open tabs):`,
        `    ${cmd} restart --browser ${id} --port ${port}`,
    ];

    if (platform === "darwin") {
        lines.push(
            `    osascript -e 'quit app "${app}"'`,
            `    open -na "${app}" --args --remote-debugging-port=${port}`,
            `    ${cmd} attach --port ${port}`
        );
    }

    lines.push(
        `  Or a throwaway profile (logins not kept):`,
        `    ${cmd} open --browser ${id} --port ${port} --fresh <url>`
    );

    return lines;
}

export function renderAttachPlan(
    plan: AttachPlan,
    opts: { cmd: string; suggestCommand: (add: string[]) => string; platform?: Platform }
): { text: string; exitCode: number } {
    const lines: string[] = [];
    const want = new Set<BrowserId>([
        ...plan.running,
        ...plan.endpoints.map((e) => e.owner).filter((id): id is BrowserId => id != null),
    ]);
    const ids: BrowserId[] = [];
    for (const b of BROWSERS) {
        if (want.has(b.id)) {
            ids.push(b.id);
        }
    }
    for (const id of want) {
        if (!ids.includes(id)) {
            ids.push(id);
        }
    }

    if (plan.status === "ambiguous") {
        const names = ids.map((id) => BROWSER_APPS[id] ?? id);
        const who = names.length === 2 ? `${names[0]} and ${names[1]}` : names.join(", ");
        lines.push(`${who} are both open. Your bug could live in either, so nothing is picked silently. Pick one:`);
        lines.push("");
    }

    for (const id of ids) {
        const app = BROWSER_APPS[id];
        const owned = plan.endpoints.filter((e) => e.owner === id);
        const off = plan.undebugged.includes(id);

        if (off && !owned.length) {
            const empty = plan.emptyDebugFlag.includes(id);
            lines.push(
                empty
                    ? `=== ${app}: open, debugging flag is empty, nothing listens ===`
                    : `=== ${app}: open, debugging port is not on ===`
            );
            lines.push(...restartLines(id, plan.restartPort, opts.cmd, opts.platform ?? currentPlatform()));
        } else if (owned.length) {
            lines.push(`=== ${app}: debugging on ===`);
            for (const e of owned) {
                lines.push(...renderEndpoint(e));
                lines.push(`  attach:`);
                lines.push(`    ${opts.suggestCommand(["attach", "--port", String(e.port)])}`);
            }
        }

        lines.push("");
    }

    const exitCode = plan.status === "list" ? 0 : 1;

    return { text: lines.join("\n").trimEnd(), exitCode };
}
