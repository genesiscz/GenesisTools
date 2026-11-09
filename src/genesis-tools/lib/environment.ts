import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grantsFor } from "@app/macos/lib/permissions/report";
import {
    readTccRows,
    TCC_SERVICES,
    TCC_SYSTEM_DB_PATH,
    TCC_USER_DB_PATH,
    type TccService,
} from "@app/macos/lib/permissions/tcc";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import { readLiveService } from "@genesiscz/utils/screen-recorder/service-link";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/** The app build's facts from `~/.genesis-tools/app/manifest.json` (written by every `bun run app`). */
export interface ManifestFacts {
    sourceCommit?: string;
    sourceBranch?: string;
    sourceDirty?: boolean;
    sourceRoot?: string;
    builtAt?: string;
}

export interface GrantState {
    name: string;
    /** "granted", "denied", "not asked yet", "unknown (database not readable)". */
    state: string;
}

export interface RecorderState {
    facePids: number[];
    service: { pid: number; startedAt: string } | null;
}

/** Where each fact comes from; the real ones read the Mac, a test hands in fixed values. */
export interface EnvironmentSources {
    now: () => Date;
    /** Shown times are in this zone (the Mac's own when unset). */
    timeZone?: string;
    manifest: () => ManifestFacts | null;
    /** A commit's committer date (ISO), null when the checkout does not have it. */
    commitDate: (commit: string, checkout: string) => string | null;
    toolsHead: () => { checkout: string; head: string | null; branch: string | null };
    bunVersion: string;
    macos: () => { version: string | null; build: string | null };
    machine: () => { chip: string | null; arch: string };
    grants: () => GrantState[];
    recorder: () => RecorderState;
}

export interface EnvironmentReport {
    at: string;
    app: {
        commit: string;
        shortCommit: string;
        commitDate: string | null;
        commitAge: string | null;
        branch: string | null;
        dirty: boolean;
        builtAt: string | null;
        builtAge: string | null;
        checkout: string | null;
    } | null;
    tools: {
        checkout: string;
        head: string | null;
        shortHead: string | null;
        branch: string | null;
        differsFromApp: boolean;
    };
    bun: string;
    macos: { version: string | null; build: string | null };
    machine: { chip: string | null; arch: string };
    grants: GrantState[];
    recorder: RecorderState;
    timeZone: string;
}

/**
 * The environment an issue template asks for: the running build (commit, its age, branch, dirty, when it was built),
 * the tools checkout when it differs, Bun, macOS, the chip, the recorder's privacy grants and the recorder's processes.
 * Reads only; never asks for a grant.
 */
export function gatherEnvironment(sources: EnvironmentSources = realSources()): EnvironmentReport {
    const now = sources.now();
    const manifest = sources.manifest();
    const tools = sources.toolsHead();
    let app: EnvironmentReport["app"] = null;

    if (manifest?.sourceCommit) {
        const commitDate = sources.commitDate(manifest.sourceCommit, manifest.sourceRoot ?? tools.checkout);
        app = {
            commit: manifest.sourceCommit,
            shortCommit: manifest.sourceCommit.slice(0, 12),
            commitDate,
            commitAge: commitDate ? `${age(now, commitDate, false)} old` : null,
            branch: manifest.sourceBranch ?? null,
            dirty: manifest.sourceDirty === true,
            builtAt: manifest.builtAt ?? null,
            builtAge: manifest.builtAt ? `${age(now, manifest.builtAt, true)} ago` : null,
            checkout: manifest.sourceRoot ?? null,
        };
    }

    return {
        at: now.toISOString(),
        app,
        tools: {
            ...tools,
            shortHead: tools.head?.slice(0, 12) ?? null,
            differsFromApp: app !== null && tools.head !== null && tools.head !== app.commit,
        },
        bun: sources.bunVersion,
        macos: sources.macos(),
        machine: sources.machine(),
        grants: sources.grants(),
        recorder: sources.recorder(),
        timeZone: sources.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
}

/** The issue's Environment section: one bullet per fact. */
export function environmentMarkdown(report: EnvironmentReport): string {
    const time = (iso: string) => shownTime(iso, report.timeZone);
    const lines: string[] = [];

    if (report.app) {
        const app = report.app;
        const build = `\`${app.shortCommit}${app.dirty ? "+dirty" : ""}\``;
        const branch = app.branch ? ` on \`${app.branch}\`` : "";
        const committed = app.commitDate ? `, committed ${time(app.commitDate)} (${app.commitAge})` : "";
        lines.push(`- **GenesisTools build:** ${build}${branch}${committed}`);
        if (app.builtAt) {
            lines.push(`- **Built:** ${time(app.builtAt)} (${app.builtAge})`);
        }
    } else {
        lines.push("- **GenesisTools build:** unknown (no ~/.genesis-tools/app/manifest.json)");
    }

    if (report.tools.differsFromApp && report.tools.shortHead) {
        const branch = report.tools.branch ? ` on \`${report.tools.branch}\`` : "";
        lines.push(`- **tools checkout:** \`${report.tools.shortHead}\`${branch} (differs from the app's build)`);
    }

    lines.push(`- **Bun:** ${report.bun}`);
    const macos = [report.macos.version ?? "unknown", report.macos.build ? `(${report.macos.build})` : null]
        .filter(Boolean)
        .join(" ");
    lines.push(`- **macOS:** ${[macos, report.machine.chip, report.machine.arch].filter(Boolean).join(", ")}`);
    if (report.grants.length > 0) {
        lines.push(`- **Privacy grants:** ${report.grants.map((g) => `${g.name} ${g.state}`).join(", ")}`);
    }

    const face =
        report.recorder.facePids.length > 0 ? `face pid ${report.recorder.facePids.join(", ")}` : "face not running";
    const service = report.recorder.service
        ? `service pid ${report.recorder.service.pid} (since ${time(report.recorder.service.startedAt)})`
        : "service not running";
    lines.push(`- **Recorder:** ${face}, ${service}`);
    return lines.join("\n");
}

/** "3 h", "2 d", "12 min"; with `minutes`, "1 h 27 min". */
function age(now: Date, iso: string, minutes: boolean): string {
    const ms = Math.max(0, now.getTime() - new Date(iso).getTime());
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const days = Math.floor(hours / 24);

    if (totalMinutes < 1) {
        return "under 1 min";
    }

    if (hours < 1) {
        return `${totalMinutes} min`;
    }

    if (days >= 2) {
        return `${days} d`;
    }

    const rest = totalMinutes % 60;
    return minutes && rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "2026-11-09 10:00 CET" in `timeZone`. */
function shownTime(iso: string, timeZone: string): string {
    const date = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

// MARK: - The real sources

/** The recorder's grants: the three TCC_SERVICES the recorder needs, plus the camera. */
const CAMERA: TccService = { id: "kTCCServiceCamera", label: "Camera", db: "user", pane: "Privacy_Camera" };
const RECORDER_SERVICES: readonly TccService[] = [
    "kTCCServiceScreenCapture",
    "kTCCServiceMicrophone",
    "kTCCServiceCamera",
    "kTCCServiceAccessibility",
].flatMap((id) => [...TCC_SERVICES, CAMERA].filter((service) => service.id === id));

function run(argv: string[], cwd?: string): string | null {
    const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: 3_000 });

    if (result.exitCode !== 0) {
        logger.debug({ argv, cwd, stderr: result.stderr.toString() }, "environment: a fact command failed");
        return null;
    }

    const text = result.stdout.toString().trim();
    return text.length > 0 ? text : null;
}

/** This checkout: the folder above `src/genesis-tools/lib`. */
function toolsCheckout(): string {
    return join(import.meta.dirname, "../../..");
}

function manifestFacts(value: unknown): ManifestFacts | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const text = (key: string) =>
        key in value && typeof Reflect.get(value, key) === "string" ? String(Reflect.get(value, key)) : undefined;
    return {
        sourceCommit: text("sourceCommit"),
        sourceBranch: text("sourceBranch"),
        sourceDirty: Reflect.get(value, "sourceDirty") === true,
        sourceRoot: text("sourceRoot"),
        builtAt: text("builtAt"),
    };
}

export function realSources(): EnvironmentSources {
    return {
        now: () => new Date(),
        manifest: () => {
            const file = genesisToolsDir("app", "manifest.json");
            if (!existsSync(file)) {
                return null;
            }

            try {
                return manifestFacts(SafeJSON.parse(readFileSync(file, "utf8"), { strict: true }));
            } catch (error) {
                logger.debug({ error, file }, "environment: the app manifest does not read");
                return null;
            }
        },
        commitDate: (commit, checkout) => run(["git", "-C", checkout, "show", "-s", "--format=%cI", commit]),
        toolsHead: () => {
            const checkout = toolsCheckout();
            return {
                checkout,
                head: run(["git", "-C", checkout, "rev-parse", "HEAD"]),
                branch: run(["git", "-C", checkout, "rev-parse", "--abbrev-ref", "HEAD"]),
            };
        },
        bunVersion: Bun.version,
        macos: () => ({ version: run(["sw_vers", "-productVersion"]), build: run(["sw_vers", "-buildVersion"]) }),
        machine: () => ({ chip: run(["sysctl", "-n", "machdep.cpu.brand_string"]), arch: process.arch }),
        grants: () => {
            const ids = RECORDER_SERVICES.map((s) => s.id);
            const user = readTccRows({ dbPath: TCC_USER_DB_PATH, services: ids, client: GENESIS_APP_BUNDLE_ID });
            const system = readTccRows({ dbPath: TCC_SYSTEM_DB_PATH, services: ids, client: GENESIS_APP_BUNDLE_ID });
            return grantsFor(GENESIS_APP_BUNDLE_ID, user, system, RECORDER_SERVICES).map((grant) => ({
                name: grant.service.label,
                state: grant.label,
            }));
        },
        recorder: () => {
            const ps = run(["ps", "-Ao", "pid=,command="]) ?? "";
            const facePids = ps
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => /MacOS\/GenesisTools --recorder(\s|$)/.test(line))
                .map((line) => Number.parseInt(line, 10))
                .filter((pid) => Number.isFinite(pid));
            const entry = readLiveService();
            return { facePids, service: entry ? { pid: entry.pid, startedAt: entry.startedAt } : null };
        },
    };
}
