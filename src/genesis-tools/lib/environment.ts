import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { genesisAppGrants } from "@app/macos/lib/permissions/report";
import { whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import { agentSessionIds } from "@genesiscz/utils/agent/host";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { captureSync } from "@genesiscz/utils/process/capture";
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
    /** "allowed", "denied", "not asked yet", "asks on first use", "unknown (database not readable)". */
    state: string;
}

/** The agent session that ran this command, from its environment; null outside an agent. */
export interface CallerState {
    agent: string;
    sessionId: string | null;
    /** Other session ids the environment carries (a Codex worker inside a Claude session), as `agent id`. */
    others: string[];
}

/** The Mac itself: the chip, the model id (`Mac15,9`), the memory, the CPU architecture. */
export interface MachineFacts {
    chip: string | null;
    model: string | null;
    memoryGb: number | null;
    arch: string;
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
    machine: () => MachineFacts;
    grants: () => GrantState[];
    recorder: () => RecorderState;
    caller: () => CallerState | null;
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
    machine: MachineFacts;
    grants: GrantState[];
    recorder: RecorderState;
    caller: CallerState | null;
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
        caller: sources.caller(),
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
    lines.push(`- **macOS:** ${macos}`);
    lines.push(`- **Mac:** ${machineLine(report.machine)}`);
    if (report.caller) {
        lines.push(`- **Calling agent:** ${callerLine(report.caller)}`);
    }

    if (report.grants.length > 0) {
        lines.push(
            `- **Privacy grants of GenesisTools.app:** ${report.grants.map((g) => `${g.name} ${g.state}`).join(", ")}`
        );
    }

    const face =
        report.recorder.facePids.length > 0 ? `face pid ${report.recorder.facePids.join(", ")}` : "face not running";
    const service = report.recorder.service
        ? `service pid ${report.recorder.service.pid} (since ${time(report.recorder.service.startedAt)})`
        : "service not running";
    lines.push(`- **Recorder:** ${face}, ${service}`);
    return lines.join("\n");
}

/** "Apple M3 Max, Mac15,9, 64 GB, arm64". */
function machineLine(machine: MachineFacts): string {
    const memory = machine.memoryGb === null ? null : `${machine.memoryGb} GB`;
    return [machine.chip, machine.model, memory, machine.arch].filter(Boolean).join(", ");
}

function callerLine(caller: CallerState): string {
    const own = `${caller.agent}${caller.sessionId ? ` session ${caller.sessionId}` : ""}`;
    return caller.others.length > 0 ? `${own} (also ${caller.others.join(", ")})` : own;
}

/** One field of a GitHub issue form, as `.github/ISSUE_TEMPLATE/bug_report.yml` declares it. */
export interface IssueTemplateField {
    id: string;
    label: string;
    type: string;
    /** `shell` and the like: GitHub wraps the answer in a code block of that language. */
    render: string | null;
}

/** The form's fields in order, without its markdown blocks. Empty when the text is no issue form. */
export function parseIssueTemplate(text: string): IssueTemplateField[] {
    let form: unknown;
    try {
        form = Bun.YAML.parse(text);
    } catch (error) {
        logger.debug({ error }, "environment: the issue template does not parse");
        return [];
    }

    const body = typeof form === "object" && form !== null ? Reflect.get(form, "body") : undefined;
    if (!Array.isArray(body)) {
        return [];
    }

    const fields: IssueTemplateField[] = [];
    for (const item of body) {
        if (typeof item !== "object" || item === null) {
            continue;
        }

        const type = Reflect.get(item, "type");
        const id = Reflect.get(item, "id");
        const attributes = Reflect.get(item, "attributes");
        const label =
            typeof attributes === "object" && attributes !== null ? Reflect.get(attributes, "label") : undefined;
        if (type === "markdown" || typeof type !== "string" || typeof id !== "string" || typeof label !== "string") {
            continue;
        }

        const render = Reflect.get(attributes, "render");
        fields.push({ id, label, type, render: typeof render === "string" ? render : null });
    }

    return fields;
}

/** The checkout's bug form (`.github/ISSUE_TEMPLATE/bug_report.yml`), empty when it has none. */
export function readBugTemplate(checkout: string = toolsCheckout()): {
    path: string | null;
    fields: IssueTemplateField[];
} {
    const path = join(checkout, ".github/ISSUE_TEMPLATE/bug_report.yml");
    if (!existsSync(path)) {
        return { path: null, fields: [] };
    }

    return { path, fields: parseIssueTemplate(readFileSync(path, "utf8")) };
}

/** The bug form's environment answers, by field id: commit, branch, app-build, macos, chip, bun, permissions. */
export function issueEnvironmentValues(report: EnvironmentReport): Record<string, string> {
    const time = (iso: string) => shownTime(iso, report.timeZone);
    const app = report.app;
    const build: string[] = [];

    if (app) {
        build.push(
            `commit ${app.shortCommit}${app.dirty ? " with uncommitted Swift changes (+dirty)" : ""} on ${app.branch ?? "?"}`
        );
        if (app.builtAt) {
            build.push(`built ${time(app.builtAt)} (${app.builtAge})`);
        }
    } else {
        build.push("no build manifest (~/.genesis-tools/app/manifest.json)");
    }

    if (report.tools.differsFromApp && report.tools.shortHead) {
        build.push(
            `tools checkout ${report.tools.shortHead} on ${report.tools.branch ?? "?"} differs from the app's build`
        );
    }

    const face =
        report.recorder.facePids.length > 0 ? `face pid ${report.recorder.facePids.join(", ")}` : "face not running";
    const service = report.recorder.service ? `service pid ${report.recorder.service.pid}` : "service not running";
    build.push(`recorder: ${face}, ${service}`);

    return {
        commit: app
            ? `${app.shortCommit}${app.dirty ? "+dirty" : ""}${app.commitAge ? `, ${app.commitAge}` : ""}`
            : "unknown",
        branch: app?.branch ?? report.tools.branch ?? "unknown",
        "app-build": build.join("\n"),
        macos: [report.macos.version ?? "unknown", report.macos.build ? `(${report.macos.build})` : null]
            .filter(Boolean)
            .join(" "),
        chip: machineLine(report.machine),
        bun: report.bun,
        permissions: report.grants.map((grant) => `${grant.name}: ${grant.state}`).join("\n"),
        ...(report.caller ? { agent: callerLine(report.caller) } : {}),
    };
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
        machine: () => {
            // One sysctl for the three; a name the kernel does not have prints nothing for it.
            const [chip, model, memsize] = (
                run(["sysctl", "-n", "machdep.cpu.brand_string", "hw.model", "hw.memsize"]) ?? ""
            )
                .split("\n")
                .map((line) => line.trim() || null);
            const bytes = Number(memsize);
            return {
                chip: chip ?? null,
                model: model ?? null,
                memoryGb: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 ** 3) : null,
                arch: process.arch,
            };
        },
        // Every grant `tools macos permissions` lists, with the app's own check where TCC.db is closed to this process.
        grants: () => genesisAppGrants().grants.map((grant) => ({ name: grant.service.label, state: grant.label })),
        caller: () => {
            const caller = whoIsCallingHere();
            const ids = agentSessionIds(env.getProcessEnv());
            if (!caller.isInAgent && ids.length === 0) {
                return null;
            }

            const others = ids
                .filter((entry) => entry.id !== caller.sessionId)
                .map((entry) => `${entry.agent} ${entry.id}`);
            return {
                agent: caller.isInAgent ? caller.agent : (ids[0]?.agent ?? "unknown"),
                sessionId: caller.sessionId ?? ids[0]?.id ?? null,
                others: caller.sessionId ? others : others.slice(1),
            };
        },
        recorder: () => {
            // lint-rules-ignore: the recorder faces are found by their command line, which only ps lists (registered in scripts/benchmarks/process/call-sites.ts)
            const ps = captureSync("ps", ["-Ao", "pid=,command="], { timeoutMs: 3_000 }).stdout;
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
