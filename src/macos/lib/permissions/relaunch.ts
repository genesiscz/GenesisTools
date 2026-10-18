import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath, genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import type { ProcessEntry } from "@genesiscz/utils/process/processes";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

/**
 * Faces that survive a rebuild. `reapStaleAppFaces` kills every face of the replaced bundle, and a review or
 * hub window that was open simply vanished; the widget did too, after every install, until 2026-10-11.
 * Before the reap, each long-lived face's exact argv is recorded; after it, exactly those faces start again
 * from the NEW bundle with the same arguments, behind the app in front. A face that was not running is never
 * started, and short-lived faces (`--rpc`, `--notify`, link routers, scripted runs) end on their own.
 *
 * The argv comes from the record each window face writes at launch (`~/.genesis-tools/app/faces/<pid>.json`,
 * Sources/App/FaceRecord.swift), because `ps` joins argv with spaces and a path with a space in it
 * (`--repo "/x/My Repo"`) would come back as two arguments. A face started by a build that wrote no
 * record falls back to the `ps` line, with the words after a flag joined back into one value.
 */

/** The settings window, the hub, a review, the edge-panel widget and Clicky (the feature settings host). */
export type WindowFaceKind = "hub" | "review" | "settings" | "widget" | "features";

export interface WindowFace {
    pid: number;
    kind: WindowFaceKind;
    argv: string[];
    /** True when the argv came from the face's own record, false when it was rebuilt from `ps`. */
    lossless: boolean;
}

export interface RelaunchStep {
    pid: number;
    kind: WindowFaceKind;
    argv: string[];
    activate: boolean;
}

interface FaceRecord {
    pid: number;
    argv: string[];
}

/** Flags that make a face a one-shot scripted run: it ends on its own and must never come back. */
const SCRIPTED_FLAGS = new Set(["--snapshot", "--bench", "--headless"]);

export function facesRecordDir(): string {
    return join(genesisAppDir(), "faces");
}

/** Which window a face's argv opens, or null for every face that must not be relaunched. */
export function windowFaceKind(argv: string[]): WindowFaceKind | null {
    if (argv.some((arg) => SCRIPTED_FLAGS.has(arg))) {
        return null;
    }

    const first = argv[0] ?? "";

    if (first === "" || first === "--window" || first.startsWith("-psn_")) {
        return "settings";
    }

    if (first === "--hub") {
        return "hub";
    }

    if (first === "--review") {
        return "review";
    }

    if (first === "--widget") {
        return "widget";
    }

    // `--clicky` is the old name of the feature settings face: a face started by an older build still carries it.
    if (first === "--features" || first === "--clicky") {
        return "features";
    }

    // --rpc, --notify, --mic, --capsule end on their own; a link router must never be kept alive; the link relay
    // comes back through `RelaunchCapture.relay`.
    return null;
}

/**
 * Rebuilds an argv from the space-joined `ps` text. Every flag starts a new argument; the words after a
 * flag up to the next flag are one value, so `--repo /x/My Repo --scope branch` keeps its path whole.
 * Lossy only for a value that itself starts with `--` or holds two spaces in a row.
 */
export function argvFromPs(rest: string): string[] {
    const words = rest.split(" ").filter((word) => word !== "");
    const argv: string[] = [];
    let last: "none" | "flag" | "value" = "none";

    for (const word of words) {
        if (word.startsWith("--")) {
            argv.push(word);
            last = "flag";
        } else if (last === "flag") {
            argv.push(word);
            last = "value";
        } else if (last === "value") {
            argv[argv.length - 1] = `${argv[argv.length - 1]} ${word}`;
        } else {
            argv.push(word);
        }
    }

    return argv;
}

/** The pids the reap is about to kill, each with the `ps` text after the launcher path. */
function staleLauncherLines(options: {
    processes: Pick<ProcessEntry, "pid" | "command">[];
    launcherPath: string;
    stalePids: Set<string>;
}): Array<{ pid: number; rest: string }> {
    const { processes, launcherPath, stalePids } = options;
    return processes.flatMap((entry) => {
        if (!stalePids.has(String(entry.pid)) || !entry.command?.startsWith(launcherPath)) {
            return [];
        }
        return [{ pid: entry.pid, rest: entry.command.slice(launcherPath.length).trim() }];
    });
}

/** Whether the reap is about to kill a link relay (`GenesisTools --link-relay`). */
export function linkRelayAmong(options: {
    processes: Pick<ProcessEntry, "pid" | "command">[];
    launcherPath: string;
    stalePids: Set<string>;
}): boolean {
    return staleLauncherLines(options).some((line) => line.rest === "--link-relay");
}

/**
 * The window faces among the pids the reap is about to kill. A record is trusted only while
 * its argv still matches the process entry, so a reused pid never borrows another
 * face's arguments.
 */
export function windowFacesFromPs(options: {
    processes: Pick<ProcessEntry, "pid" | "command">[];
    launcherPath: string;
    stalePids: Set<string>;
    records: Map<number, string[]>;
}): WindowFace[] {
    const { records } = options;
    const faces: WindowFace[] = [];

    for (const { pid, rest } of staleLauncherLines(options)) {
        const recorded = records.get(pid);
        const lossless = recorded !== undefined && recorded.join(" ") === rest;
        const argv = lossless ? recorded : argvFromPs(rest);
        const kind = windowFaceKind(argv);

        if (kind) {
            faces.push({ pid, kind, argv, lossless });
        }
    }

    return faces;
}

/** `lsappinfo info -only pid <front ASN>` prints `"pid"=123`. */
export function parseFrontmostPid(output: string): number | null {
    const match = output.match(/"pid"\s*=\s*(\d+)/);
    return match ? Number(match[1]) : null;
}

/** Flags that run something once at a face's launch: a value after each, none, or an optional one. */
interface OneShotFlags {
    value: Set<string>;
    bare: Set<string>;
    optional: Set<string>;
}

/** Sources/Hub/HubWindow.swift. */
const HUB_ONE_SHOTS: OneShotFlags = {
    value: new Set([
        "--inbox-resume",
        "--inbox-info",
        "--decision",
        "--question",
        "--timeline-open",
        "--timeline-action",
    ]),
    bare: new Set(["--digest", "--rules", "--prompts", "--handoff"]),
    optional: new Set(["--palette", "--find", "--session-search"]),
};

/** Sources/WidgetWindow.swift: open the settings, open a session, or only make sure the widget runs. */
const WIDGET_ONE_SHOTS: OneShotFlags = {
    value: new Set(["--session-key"]),
    bare: new Set(["--settings", "--ensure-running"]),
    optional: new Set(),
};

/** Parts/Features/FeaturesEntry.swift: the settings page to open. */
const FEATURES_ONE_SHOTS: OneShotFlags = { value: new Set(["--page"]), bare: new Set(), optional: new Set() };

function withoutOneShots(argv: string[], flags: OneShotFlags): string[] {
    const kept: string[] = [];

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = argv[index + 1];

        if (flags.value.has(arg)) {
            index++;
            continue;
        }

        if (flags.optional.has(arg)) {
            if (next !== undefined && !next.startsWith("--")) {
                index++;
            }

            continue;
        }

        if (flags.bare.has(arg)) {
            continue;
        }

        kept.push(arg);
    }

    return kept;
}

/** A hub's argv without its one-shot actions, so a rebuild reopens the window and does not run them again. */
export function withoutHubActions(argv: string[]): string[] {
    return withoutOneShots(argv, HUB_ONE_SHOTS);
}

/**
 * What each face starts with again. Only the face that was frontmost activates, and it goes last so it
 * ends in front; every other one opens behind (`open -g` plus the face's own `--no-activate`). A hub
 * also gets `--resume`: it reopens the mode and selection it last showed (Sources/Hub/HubPlace.swift),
 * and an older hub's record that has none keeps its own arguments. The widget and Clicky come back
 * without the settings page or session they were opened with; the widget also gets `--ensure-running`,
 * so a copy that finds one already started (by another face) exits instead of opening the settings, and
 * `--no-activate` keeps a widget that is switched off from opening them on its own. Copies of one window
 * (settings windows opened before that face held an instance lock) come back as one: the frontmost copy
 * when it is among them, else the first.
 */
export function relaunchPlan(faces: WindowFace[], frontPid: number | null): RelaunchStep[] {
    const steps = faces.map((face): RelaunchStep => {
        const activate = face.pid === frontPid;
        const kept = face.argv.filter((arg) => arg !== "--no-activate" && arg !== "--resume");
        let argv = kept;

        if (face.kind === "settings") {
            argv = ["--window"];
        } else if (face.kind === "hub") {
            argv = [...withoutHubActions(kept), "--resume"];
        } else if (face.kind === "widget") {
            argv = [...withoutOneShots(kept, WIDGET_ONE_SHOTS), "--ensure-running"];
        } else if (face.kind === "features") {
            argv = ["--features", ...withoutOneShots(kept.slice(1), FEATURES_ONE_SHOTS)];
        }

        if (!activate) {
            argv.push("--no-activate");
        }

        return { pid: face.pid, kind: face.kind, argv, activate };
    });
    const unique = new Map<string, RelaunchStep>();

    for (const step of steps) {
        const key = step.argv.filter((arg) => arg !== "--no-activate").join("\0");
        const kept = unique.get(key);

        if (!kept || (step.activate && !kept.activate)) {
            unique.set(key, step);
        }
    }

    const once = [...unique.values()];
    return [...once.filter((step) => !step.activate), ...once.filter((step) => step.activate)];
}

function spawnText(cmd: string[]): { code: number; stdout: string; stderr: string } {
    logger.debug({ cmd }, "relaunch: spawn");
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return {
        code: proc.exitCode,
        stdout: new TextDecoder().decode(proc.stdout),
        stderr: new TextDecoder().decode(proc.stderr),
    };
}

function isFaceRecord(value: unknown): value is FaceRecord {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    if (!("pid" in value) || !("argv" in value)) {
        return false;
    }

    const { pid, argv } = value;
    return typeof pid === "number" && Array.isArray(argv) && argv.every((arg: unknown) => typeof arg === "string");
}

/**
 * Every face record on disk, by pid. An unreadable one is skipped and logged, and a folder that cannot be listed
 * gives none: each face then comes back from its `ps` line, and the reap still knows whether a link relay ran.
 */
export function readFaceRecords(dir = facesRecordDir()): Map<number, string[]> {
    const records = new Map<number, string[]>();

    if (!existsSync(dir)) {
        return records;
    }

    let names: string[];
    try {
        names = readdirSync(dir);
    } catch (err) {
        logger.warn({ err, dir }, "relaunch: face records unreadable; faces come back from their ps lines");
        return records;
    }

    for (const name of names) {
        if (!name.endsWith(".json")) {
            continue;
        }

        try {
            const parsed: unknown = SafeJSON.parse(readFileSync(join(dir, name), "utf8"), { strict: true });

            if (isFaceRecord(parsed)) {
                records.set(parsed.pid, parsed.argv);
            }
        } catch (err) {
            logger.debug({ err, name }, "relaunch: face record unreadable, skipped");
        }
    }

    return records;
}

/** Drops the records of faces that are gone (a SIGTERM skips the face's own cleanup). */
export function pruneFaceRecords(dir = facesRecordDir()): void {
    if (!existsSync(dir)) {
        return;
    }

    for (const name of readdirSync(dir)) {
        const pid = Number(name.replace(/\.json$/, ""));

        if (!name.endsWith(".json") || !Number.isInteger(pid) || isProcessAlive(pid)) {
            continue;
        }

        rmSync(join(dir, name), { force: true });
    }
}

function frontmostPid(): number | null {
    const front = spawnText(["lsappinfo", "front"]);

    if (front.code !== 0 || front.stdout.trim() === "") {
        logger.debug({ stderr: front.stderr }, "relaunch: no frontmost app");
        return null;
    }

    const info = spawnText(["lsappinfo", "info", "-only", "pid", front.stdout.trim()]);
    return info.code === 0 ? parseFrontmostPid(info.stdout) : null;
}

/** What a rebuild starts again: the faces it stopped, and whether a link relay comes back before them. */
export interface RelaunchCapture {
    steps: RelaunchStep[];
    /** A link relay was among the stopped faces, or a face that comes back needs one in front of it. */
    relay: boolean;
}

/**
 * The faces among `stalePids` with their argv, in start order. `frontPid` is asked only when a face comes
 * back. A link relay that was not running starts only for the faces that come back (each window face
 * starts one first itself), so a reap of nothing but short-lived faces starts nothing.
 */
export function planRelaunch(options: {
    processes: Pick<ProcessEntry, "pid" | "command">[];
    launcherPath: string;
    stalePids: Set<string>;
    records: Map<number, string[]>;
    frontPid: () => number | null;
}): RelaunchCapture {
    const faces = windowFacesFromPs(options);
    const steps = faces.length > 0 ? relaunchPlan(faces, options.frontPid()) : [];
    return { steps, relay: steps.length > 0 || linkRelayAmong(options) };
}

/** The faces of `stalePids` with their argv, and which of them is in front. Call before the reap. */
export function captureRelaunch(options: {
    processes: Pick<ProcessEntry, "pid" | "command">[];
    launcherPath: string;
    stalePids: string[];
}): RelaunchCapture {
    const capture = planRelaunch({
        processes: options.processes,
        launcherPath: options.launcherPath,
        stalePids: new Set(options.stalePids),
        records: readFaceRecords(),
        frontPid: frontmostPid,
    });
    logger.info(
        {
            faces: capture.steps.map((entry) => ({ pid: entry.pid, kind: entry.kind, argv: entry.argv })),
            relay: capture.relay,
            front: capture.steps.find((entry) => entry.activate)?.pid ?? null,
        },
        "relaunch: faces recorded before the reap"
    );
    return capture;
}

/** The windowless face that takes link deliveries, started in the background before any window face. */
export function linkRelayOpenArgs(bundle: string): string[] {
    return ["open", "-n", "-g", bundle, "--args", "--link-relay"];
}

/**
 * The `open` commands a relaunch runs, in order: the link relay first (the oldest instance gets the links,
 * LinkRelay.swift), then one per face, behind the front app (`-g`) unless it was the front face.
 * `step` is null for the relay.
 */
export function relaunchCommands(
    capture: RelaunchCapture,
    bundle: string
): Array<{ step: RelaunchStep | null; args: string[] }> {
    const faces = capture.steps.map((entry) => ({
        step: entry,
        args: ["open", "-n", ...(entry.activate ? [] : ["-g"]), bundle, "--args", ...entry.argv],
    }));
    return capture.relay ? [{ step: null, args: linkRelayOpenArgs(bundle) }, ...faces] : faces;
}

/** Starts each recorded face from the installed bundle through Launch Services, as `tools hub` does. */
export function runRelaunch(capture: RelaunchCapture, step: (message: string) => void): void {
    pruneFaceRecords();

    for (const { step: entry, args } of relaunchCommands(capture, genesisAppBundlePath())) {
        const result = spawnText(args);

        if (!entry) {
            if (result.code !== 0) {
                logger.warn({ stderr: result.stderr }, "relaunch: link relay did not start");
            }

            continue;
        }

        if (result.code !== 0) {
            logger.warn({ pid: entry.pid, args, stderr: result.stderr }, "relaunch: open failed");
            step(`could not reopen the ${entry.kind} face (was pid ${entry.pid}): ${result.stderr.trim()}`);
            continue;
        }

        logger.info(
            { was: entry.pid, kind: entry.kind, argv: entry.argv, activate: entry.activate },
            "relaunch: reopened"
        );
        step(`reopened the ${entry.kind} face (was pid ${entry.pid}): ${entry.argv.join(" ")}`);
    }
}
