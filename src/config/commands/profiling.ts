import * as p from "@clack/prompts";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import {
    getGenesisToolsConfigPath,
    getProfilingConfig,
    type ProfilingConfig,
    type ProfilingDetail,
    setProfilingConfig,
} from "@genesiscz/utils/GenesisTools";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    getProfilerGate,
    PROFILER_SCOPE_NAMES,
    PROFILING_DETAIL_VALUES,
    reloadProfiler,
} from "@genesiscz/utils/profile";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

export interface ProfilingCliFlags {
    enable?: boolean;
    disable?: boolean;
    scopes?: string | true;
    stderr?: boolean;
    noStderr?: boolean;
    file?: boolean;
    noFile?: boolean;
    filePath?: string;
    minDurationMs?: string;
    detail?: string | true;
    summaryOnExit?: boolean;
    noSummaryOnExit?: boolean;
    json?: boolean;
}

export type ProfilingRunResult =
    | { status: "ok"; stored: ProfilingConfig; wrote: boolean }
    | { status: "missing-enum"; flag: string; values: readonly string[]; help: string };

export interface ProfilingIo {
    interactive: boolean;
    promptScopes?: () => Promise<string[] | null>;
    promptDetail?: () => Promise<ProfilingDetail | null>;
    promptEdit?: () => Promise<Partial<ProfilingConfig> | null>;
}

const ENUM_TOOL = "tools config profiling";
const ENUM_SUB = ["profiling"] as const;

function isMissingEnumValue(raw: string | true | undefined): boolean {
    return raw === true || raw === "";
}

function missingEnum(flag: string, values: readonly string[], given?: string): ProfilingRunResult {
    return {
        status: "missing-enum",
        flag,
        values,
        help: suggestEnumFlag(ENUM_TOOL, flag, values, { subcommand: [...ENUM_SUB], given }),
    };
}

function hasMutatingFlags(flags: ProfilingCliFlags): boolean {
    return Boolean(
        flags.enable ||
            flags.disable ||
            flags.scopes !== undefined ||
            flags.stderr === true ||
            flags.stderr === false ||
            flags.noStderr ||
            flags.file === true ||
            flags.file === false ||
            flags.noFile ||
            flags.filePath !== undefined ||
            flags.minDurationMs !== undefined ||
            flags.detail !== undefined ||
            flags.summaryOnExit === true ||
            flags.summaryOnExit === false ||
            flags.noSummaryOnExit
    );
}

async function defaultPromptScopes(): Promise<string[] | null> {
    const picked = await p.multiselect({
        message: "Profiler scopes (empty scopes means all)",
        options: [
            { value: "all", label: "all scopes" },
            ...PROFILER_SCOPE_NAMES.map((name) => ({ value: name, label: name })),
        ],
        required: true,
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked as string[];
}

async function defaultPromptDetail(): Promise<ProfilingDetail | null> {
    const picked = await p.select({
        message: "Profiling detail",
        options: [
            { value: "phases", label: "phases — a few timers per command" },
            { value: "all", label: "all — also time each file parse" },
        ],
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked as ProfilingDetail;
}

async function defaultPromptEdit(): Promise<Partial<ProfilingConfig> | null> {
    const current = getProfilingConfig();
    const want = await p.confirm({ message: "Change profiling settings?", initialValue: false });

    if (p.isCancel(want) || !want) {
        return null;
    }

    const enabled = await p.confirm({ message: "Enable profiling?", initialValue: current.enabled });

    if (p.isCancel(enabled)) {
        return null;
    }

    const scopes = await defaultPromptScopes();

    if (scopes === null) {
        return null;
    }

    const stderr = await p.confirm({ message: "Also write to stderr?", initialValue: current.stderr });

    if (p.isCancel(stderr)) {
        return null;
    }

    const detail = await defaultPromptDetail();

    if (detail === null) {
        return null;
    }

    const summaryOnExit = await p.confirm({
        message: "Print a summary when the process exits?",
        initialValue: current.summaryOnExit,
    });

    if (p.isCancel(summaryOnExit)) {
        return null;
    }

    return {
        enabled: enabled as boolean,
        scopes: scopes.includes("all") ? [] : scopes,
        stderr: stderr as boolean,
        detail,
        summaryOnExit: summaryOnExit as boolean,
    };
}

function defaultIo(): ProfilingIo {
    return {
        interactive: isInteractive(),
        promptScopes: defaultPromptScopes,
        promptDetail: defaultPromptDetail,
        promptEdit: defaultPromptEdit,
    };
}

function scopesToFlag(scopes: string[]): string {
    if (scopes.length === 0 || scopes.includes("all")) {
        return "all";
    }

    return scopes.join(",");
}

export async function runProfilingCommand(
    flags: ProfilingCliFlags,
    io: ProfilingIo = defaultIo()
): Promise<ProfilingRunResult> {
    const next: ProfilingCliFlags = { ...flags };

    if (isMissingEnumValue(next.scopes)) {
        if (io.interactive && io.promptScopes) {
            const picked = await io.promptScopes();

            if (picked === null) {
                return { status: "ok", stored: getProfilingConfig(), wrote: false };
            }

            next.scopes = scopesToFlag(picked);
        } else {
            return missingEnum("--scopes", PROFILER_SCOPE_NAMES);
        }
    }

    if (isMissingEnumValue(next.detail)) {
        if (io.interactive && io.promptDetail) {
            const picked = await io.promptDetail();

            if (picked === null) {
                return { status: "ok", stored: getProfilingConfig(), wrote: false };
            }

            next.detail = picked;
        } else {
            return missingEnum("--detail", PROFILING_DETAIL_VALUES);
        }
    }

    if (typeof next.detail === "string" && next.detail !== "phases" && next.detail !== "all") {
        const given = next.detail;

        if (io.interactive && io.promptDetail) {
            const picked = await io.promptDetail();

            if (picked === null) {
                return { status: "ok", stored: getProfilingConfig(), wrote: false };
            }

            next.detail = picked;
        } else {
            return missingEnum("--detail", PROFILING_DETAIL_VALUES, given);
        }
    }

    // t30: an unknown scope used to be stored verbatim, and then nothing matched
    // it — profiling simply stayed silent instead of reporting the typo.
    // t26: "all" is the clear-the-filter token, not a scope name — scopesToFlag
    // emits it for the interactive all-scopes selection, and applyProfilingFlags
    // accepts it case-insensitively, so it must pass validation.
    if (typeof next.scopes === "string" && next.scopes.trim().length > 0) {
        const raw = next.scopes.trim();

        if (raw.toLowerCase() !== "all") {
            const unknown = raw
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name.length > 0)
                .filter((name) => !PROFILER_SCOPE_NAMES.includes(name as (typeof PROFILER_SCOPE_NAMES)[number]));

            if (unknown.length > 0) {
                return missingEnum("--scopes", PROFILER_SCOPE_NAMES, unknown.join(", "));
            }
        }
    }

    if (!hasMutatingFlags(flags) && !flags.json && io.interactive && io.promptEdit) {
        const patch = await io.promptEdit();

        if (patch === null) {
            return { status: "ok", stored: getProfilingConfig(), wrote: false };
        }

        const stored = await setProfilingConfig(patch);
        reloadProfiler();
        return { status: "ok", stored, wrote: true };
    }

    const before = getProfilingConfig();
    const stored = await applyProfilingFlags(next);
    const wrote = SafeJSON.stringify(before) !== SafeJSON.stringify(stored);
    return { status: "ok", stored, wrote };
}

export async function applyProfilingFlags(flags: ProfilingCliFlags): Promise<ProfilingConfig> {
    if (flags.enable && flags.disable) {
        throw new Error("Use either --enable or --disable, not both.");
    }

    const patch: Partial<ProfilingConfig> = {};

    if (flags.enable) {
        patch.enabled = true;
    }

    if (flags.disable) {
        patch.enabled = false;
    }

    if (typeof flags.scopes === "string") {
        const raw = flags.scopes.trim();

        if (raw === "" || raw.toLowerCase() === "all") {
            patch.scopes = [];
        } else {
            patch.scopes = raw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }

    if (flags.stderr === true) {
        patch.stderr = true;
    }

    if (flags.stderr === false || flags.noStderr) {
        patch.stderr = false;
    }

    if (flags.file === true) {
        patch.file = true;
    }

    if (flags.file === false || flags.noFile) {
        patch.file = false;
    }

    if (flags.filePath !== undefined) {
        patch.filePath = flags.filePath.length > 0 ? flags.filePath : null;
    }

    if (flags.minDurationMs !== undefined) {
        const n = Number(flags.minDurationMs);

        if (!Number.isFinite(n) || n < 0) {
            throw new Error("--min-duration-ms must be a number >= 0");
        }

        patch.minDurationMs = n;
    }

    if (flags.detail === "phases" || flags.detail === "all") {
        patch.detail = flags.detail;
    }

    if (flags.summaryOnExit === true) {
        patch.summaryOnExit = true;
    }

    if (flags.summaryOnExit === false || flags.noSummaryOnExit) {
        patch.summaryOnExit = false;
    }

    if (Object.keys(patch).length === 0) {
        return getProfilingConfig();
    }

    const next = await setProfilingConfig(patch);
    reloadProfiler();
    return next;
}

export function printProfilingStatus(stored: ProfilingConfig, json: boolean): void {
    reloadProfiler();
    const resolved = getProfilerGate();
    const path = getGenesisToolsConfigPath();

    if (json) {
        out.result(SafeJSON.stringify({ path, stored, resolved }, { strict: true }));
        return;
    }

    renderCliHeader("Profiling", path);
    const table = createBoxTable(["KEY", "STORED", "RESOLVED"]);
    table.push(["enabled", String(stored.enabled), String(resolved.on)]);
    const storedScopes = stored.scopes.length ? stored.scopes.join(",") : "(all)";
    const resolvedScopes = resolved.scopes ? resolved.scopes.join(",") : "(all)";
    table.push(["scopes", storedScopes, resolvedScopes]);
    table.push(["stderr", String(stored.stderr), String(resolved.stderr)]);
    table.push(["file", String(stored.file), String(resolved.file)]);
    table.push(["filePath", stored.filePath ?? "(daily log)", resolved.filePath ?? "(daily log)"]);
    table.push(["minDurationMs", String(stored.minDurationMs), String(resolved.minDurationMs)]);
    table.push(["detail", stored.detail, resolved.detail]);
    table.push(["summaryOnExit", String(stored.summaryOnExit), String(resolved.summaryOnExit)]);
    out.println(table.toString());
    out.println(pc.dim(`  Env: PROFILE, PROFILE_TO_STDERR, PROFILE_TO_FILE override the file for one process.`));
}

export function registerProfilingCommand(program: Command): void {
    program
        .command("profiling")
        .description("Show or change global profiler settings (GenesisTools config)")
        .option("--enable", "turn profiling on")
        .option("--disable", "turn profiling off")
        .option("--scopes [list]", "comma-separated scope names, or all; omit the value for help")
        .option("--stderr", "also write each line to stderr")
        .option("--no-stderr", "do not write to stderr")
        .option("--file", "write the daily profiling log")
        .option("--no-file", "do not write a profiling log file")
        .option("--file-path <path>", "write to this path instead of the daily log")
        .option("--min-duration-ms <n>", "omit duration lines shorter than N milliseconds")
        .option("--detail [mode]", "phases (default) or all; omit the value for help")
        .option("--summary-on-exit", "print the summary table when the process exits")
        .option("--no-summary-on-exit", "do not print a summary on exit")
        .option("--json", "print stored + resolved gate as JSON")
        .action(async (opts: ProfilingCliFlags) => {
            const io = defaultIo();
            const showFirst = io.interactive && !opts.json && !hasMutatingFlags(opts);

            if (showFirst) {
                printProfilingStatus(getProfilingConfig(), false);
            }

            const result = await runProfilingCommand(opts, io);

            if (result.status === "missing-enum") {
                out.error(result.help);
                process.exitCode = 1;
                return;
            }

            if (opts.json || result.wrote || !showFirst) {
                printProfilingStatus(result.stored, !!opts.json);
            }
        });
}
