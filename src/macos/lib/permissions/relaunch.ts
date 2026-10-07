import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath, genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

/**
 * Window faces that survive a rebuild. `reapStaleAppFaces` kills every face of the replaced bundle, and
 * a review or hub window that was open simply vanished. Before the reap, each window face's exact argv
 * is recorded; after it, the faces start again from the NEW bundle with the same arguments.
 *
 * The argv comes from the record each window face writes at launch (`~/.genesis-tools/app/faces/<pid>.json`,
 * Sources/App/FaceRecord.swift), because `ps` joins argv with spaces and a path with a space in it
 * (`--repo "/x/My Repo"`) would come back as two arguments. A face started by a build that wrote no
 * record falls back to the `ps` line, with the words after a flag joined back into one value.
 */

export type WindowFaceKind = "hub" | "review" | "settings";

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
const SCRIPTED_FLAGS = new Set(["--snapshot", "--bench"]);

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

    // --rpc, --notify, --mic, --capsule end on their own; a link router must never be kept alive.
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

/**
 * The window faces among the pids the reap is about to kill. `psStdout` is `ps -Ao pid=,args=`; a record
 * is trusted only while its argv still spells the `ps` line, so a reused pid never borrows another
 * face's arguments.
 */
export function windowFacesFromPs(options: {
    psStdout: string;
    launcherPath: string;
    stalePids: Set<string>;
    records: Map<number, string[]>;
}): WindowFace[] {
    const { psStdout, launcherPath, stalePids, records } = options;
    const faces: WindowFace[] = [];

    for (const line of psStdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);

        if (!match || !stalePids.has(match[1]) || !match[2].startsWith(launcherPath)) {
            continue;
        }

        const pid = Number(match[1]);
        const rest = match[2].slice(launcherPath.length).trim();
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

/**
 * What each face starts with again. Only the face that was frontmost activates, and it goes last so it
 * ends in front; every other one opens behind (`open -g` plus the face's own `--no-activate`). A hub
 * also gets `--resume`: it reopens the mode and selection it last showed (Sources/Hub/HubPlace.swift),
 * and an older hub's record that has none keeps its own arguments.
 */
export function relaunchPlan(faces: WindowFace[], frontPid: number | null): RelaunchStep[] {
    const steps = faces.map((face): RelaunchStep => {
        const activate = face.pid === frontPid;
        const kept = face.argv.filter((arg) => arg !== "--no-activate" && arg !== "--resume");
        let argv = kept;

        if (face.kind === "settings") {
            argv = ["--window"];
        } else if (face.kind === "hub") {
            argv = [...kept, "--resume"];
        }

        if (!activate) {
            argv.push("--no-activate");
        }

        return { pid: face.pid, kind: face.kind, argv, activate };
    });

    return [...steps.filter((step) => !step.activate), ...steps.filter((step) => step.activate)];
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

/** Every face record on disk, by pid. An unreadable one is skipped and logged. */
export function readFaceRecords(dir = facesRecordDir()): Map<number, string[]> {
    const records = new Map<number, string[]>();

    if (!existsSync(dir)) {
        return records;
    }

    for (const name of readdirSync(dir)) {
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

/** The window faces of `stalePids` with their argv, and which of them is in front. Call before the reap. */
export function captureRelaunch(options: {
    psStdout: string;
    launcherPath: string;
    stalePids: string[];
}): RelaunchStep[] {
    const faces = windowFacesFromPs({
        psStdout: options.psStdout,
        launcherPath: options.launcherPath,
        stalePids: new Set(options.stalePids),
        records: readFaceRecords(),
    });

    if (faces.length === 0) {
        return [];
    }

    const front = frontmostPid();
    const plan = relaunchPlan(faces, front);
    logger.info(
        {
            faces: faces.map((face) => ({ pid: face.pid, kind: face.kind, argv: face.argv, lossless: face.lossless })),
            front,
        },
        "relaunch: window faces recorded before the reap"
    );
    return plan;
}

/** Starts each recorded face from the installed bundle through Launch Services, as `tools hub` does. */
export function runRelaunch(plan: RelaunchStep[], step: (message: string) => void): void {
    pruneFaceRecords();

    if (plan.length === 0) {
        return;
    }

    const bundle = genesisAppBundlePath();

    for (const entry of plan) {
        const openArgs = ["open", "-n", ...(entry.activate ? [] : ["-g"]), bundle, "--args", ...entry.argv];
        const result = spawnText(openArgs);

        if (result.code !== 0) {
            logger.warn({ pid: entry.pid, openArgs, stderr: result.stderr }, "relaunch: open failed");
            step(`could not reopen the ${entry.kind} window (was pid ${entry.pid}): ${result.stderr.trim()}`);
            continue;
        }

        logger.info(
            { was: entry.pid, kind: entry.kind, argv: entry.argv, activate: entry.activate },
            "relaunch: reopened"
        );
        step(`reopened the ${entry.kind} window (was pid ${entry.pid}): ${entry.argv.join(" ")}`);
    }
}
