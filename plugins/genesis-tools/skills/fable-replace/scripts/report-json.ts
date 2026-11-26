/**
 * fable-replace — the JSON doors. `editsFromJson` turns parsed JSON into FileEdits (code mode, `--edits`, the
 * MCP tool) and refuses anything it does not know by its path, so a typo such as `absentAfer` is an error
 * instead of a check that never runs. `reportToJson` turns a run's outcome into RunReportJson, the versioned
 * contract a caller parses; RunReport itself holds functions and grows freely.
 */

import { FableReplaceError } from "./internal";
import type { DiffLevel, FileEdit, FileResult, Op, OpResult, RunReport, RunReportJson, VerifyResult } from "./types";

type JsonObject = Record<string, unknown>;

const OP_KINDS = [
    "replace",
    "regex",
    "deleteBlock",
    "replaceBlock",
    "insertBefore",
    "insertAfter",
    "insertLinesBefore",
    "insertLinesAfter",
    "append",
    "dropComments",
    "deleteLines",
    "fuzzy",
    "rewrite",
] as const;
const DIFF_LEVELS: readonly DiffLevel[] = ["none", "stat", "full"];
const COMMENT_SCOPES = ["line", "block", "both"] as const;
const FILE_EDIT_KEYS = [
    "file",
    "ops",
    "delete",
    "renameTo",
    "overwrite",
    "allowGenerated",
    "createWith",
    "expectAfter",
    "absentAfter",
    "absentInChange",
    "gitMove",
    "diff",
];

const refuse = (path: string, problem: string): never => {
    throw new FableReplaceError(`edits JSON: ${path} ${problem}`, 2);
};

const describeValue = (value: unknown): string => {
    if (value === null) {
        return "null";
    }

    return Array.isArray(value) ? "an array" : typeof value;
};

const isObject = (value: unknown): value is JsonObject => {
    return typeof value === "object" && value !== null && !Array.isArray(value);
};

const objectAt = (value: unknown, path: string): JsonObject => {
    if (!isObject(value)) {
        return refuse(path, `must be an object (got ${describeValue(value)})`);
    }

    return value;
};

/** Drops the keys whose value is undefined, so a later spread never overwrites a set field with nothing. */
const compact = <T extends object>(value: T): T => {
    for (const key of Object.keys(value)) {
        if (Reflect.get(value, key) === undefined) {
            Reflect.deleteProperty(value, key);
        }
    }

    return value;
};

const regexAt = (value: unknown, path: string): RegExp => {
    const fields = readFields(value, path, ["source", "flags"], "a regex ({ source, flags })");
    const source = fields.str("source");
    const flags = fields.optStr("flags") ?? "";
    try {
        return new RegExp(source, flags);
    } catch (err) {
        return refuse(path, `is not a valid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
};

/** Typed readers over one JSON object; any key outside `known` is refused before a field is read. */
const readFields = (value: unknown, path: string, known: readonly string[], what: string) => {
    const object = objectAt(value, path);
    for (const key of Object.keys(object)) {
        if (!known.includes(key)) {
            refuse(`${path}.${key}`, `is not a known key of ${what} (known: ${known.join(", ")})`);
        }
    }

    const at = (key: string): string => `${path}.${key}`;
    const optStr = (key: string): string | undefined => {
        const field = object[key];
        if (field !== undefined && typeof field !== "string") {
            return refuse(at(key), `must be a string (got ${describeValue(field)})`);
        }

        return field;
    };
    const str = (key: string): string => {
        const field = optStr(key);
        if (field === undefined) {
            return refuse(at(key), "is required (a string)");
        }

        return field;
    };
    const optBool = (key: string): boolean | undefined => {
        const field = object[key];
        if (field !== undefined && typeof field !== "boolean") {
            return refuse(at(key), `must be true or false (got ${describeValue(field)})`);
        }

        return field;
    };
    const optInt = (key: string): number | undefined => {
        const field = object[key];
        if (field === undefined) {
            return undefined;
        }

        if (typeof field !== "number" || !Number.isInteger(field)) {
            return refuse(at(key), `must be a whole number (got ${describeValue(field)} ${String(field)})`);
        }

        return field;
    };
    const optCount = (key: string): number | "all" | undefined => {
        return object[key] === "all" ? "all" : optInt(key);
    };
    const optRegex = (key: string): RegExp | undefined => {
        return object[key] === undefined ? undefined : regexAt(object[key], at(key));
    };
    const optStrings = (key: string): string[] | undefined => {
        const field = object[key];
        if (field === undefined) {
            return undefined;
        }

        if (!Array.isArray(field)) {
            return refuse(at(key), `must be an array of strings (got ${describeValue(field)})`);
        }

        return field.map((item, index) => {
            if (typeof item !== "string") {
                return refuse(`${at(key)}[${index}]`, `must be a string (got ${describeValue(item)})`);
            }

            return item;
        });
    };
    const optOneOf = <T extends string>(key: string, values: readonly T[]): T | undefined => {
        const field = object[key];
        if (field === undefined) {
            return undefined;
        }

        const match = values.find((candidate) => candidate === field);
        if (match === undefined) {
            return refuse(at(key), `must be one of ${values.join(", ")} (got ${JSON.stringify(field)})`);
        }

        return match;
    };
    return { object, str, optStr, optBool, optInt, optCount, optRegex, optStrings, optOneOf };
};

const opFromJson = (value: unknown, path: string): Op => {
    const kind = objectAt(value, path).kind;
    const what = `an op with kind ${typeof kind === "string" ? JSON.stringify(kind) : describeValue(kind)}`;
    const fieldsFor = (keys: readonly string[]) => readFields(value, path, ["kind", "label", ...keys], what);
    switch (kind) {
        case undefined:
        case "replace": {
            const f = fieldsFor(["find", "replace", "count", "wholeLines", "optional"]);
            if (isObject(f.object.find)) {
                return refuse(`${path}.find`, 'is a { source, flags } regex: a regex op needs kind "regex"');
            }

            return compact({
                kind,
                find: f.str("find"),
                replace: f.str("replace"),
                count: f.optCount("count"),
                wholeLines: f.optBool("wholeLines"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "regex": {
            const f = fieldsFor(["find", "replace", "expect", "optional"]);
            if (f.object.replace !== undefined && typeof f.object.replace !== "string") {
                return refuse(
                    `${path}.replace`,
                    "must be a string: JSON has no replacer functions (use the script door)"
                );
            }

            return compact({
                kind,
                find: regexAt(f.object.find, `${path}.find`),
                replace: f.str("replace"),
                expect: f.optInt("expect"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "deleteBlock": {
            const f = fieldsFor(["from", "to", "keepFrom", "keepTo", "occurrence", "optional"]);
            return compact({
                kind,
                from: f.str("from"),
                to: f.str("to"),
                keepFrom: f.optBool("keepFrom"),
                keepTo: f.optBool("keepTo"),
                occurrence: f.optInt("occurrence"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "replaceBlock": {
            const f = fieldsFor(["from", "to", "replace", "keepFrom", "keepTo", "occurrence", "optional"]);
            return compact({
                kind,
                from: f.str("from"),
                to: f.str("to"),
                replace: f.str("replace"),
                keepFrom: f.optBool("keepFrom"),
                keepTo: f.optBool("keepTo"),
                occurrence: f.optInt("occurrence"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "insertBefore":
        case "insertAfter": {
            const f = fieldsFor(["anchor", "text", "occurrence", "optional"]);
            return compact({
                kind,
                anchor: f.str("anchor"),
                text: f.str("text"),
                occurrence: f.optInt("occurrence"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "insertLinesBefore":
        case "insertLinesAfter": {
            const f = fieldsFor(["anchor", "text", "optional"]);
            return compact({
                kind,
                anchor: f.str("anchor"),
                text: f.str("text"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "append": {
            const f = fieldsFor(["text"]);
            return compact({ kind, text: f.str("text"), label: f.optStr("label") });
        }
        case "dropComments": {
            const f = fieldsFor(["containing", "matching", "scope", "expect", "optional"]);
            return compact({
                kind,
                containing: f.optStr("containing"),
                matching: f.optRegex("matching"),
                scope: f.optOneOf("scope", COMMENT_SCOPES),
                expect: f.optInt("expect"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "deleteLines": {
            const f = fieldsFor(["containing", "matching", "expect", "optional"]);
            return compact({
                kind,
                containing: f.optStr("containing"),
                matching: f.optRegex("matching"),
                expect: f.optInt("expect"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "fuzzy": {
            const f = fieldsFor(["find", "replace", "count", "optional"]);
            return compact({
                kind,
                find: f.str("find"),
                replace: f.str("replace"),
                count: f.optCount("count"),
                optional: f.optBool("optional"),
                label: f.optStr("label"),
            });
        }
        case "rewrite": {
            const f = fieldsFor(["content", "expectSha256"]);
            return compact({
                kind,
                content: f.str("content"),
                expectSha256: f.optStr("expectSha256"),
                label: f.optStr("label"),
            });
        }
        default:
            return refuse(`${path}.kind`, `must be one of ${OP_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
    }
};

const fileEditFromJson = (value: unknown, path: string): FileEdit => {
    const f = readFields(value, path, FILE_EDIT_KEYS, "a file edit");
    const ops = f.object.ops;
    if (ops !== undefined && !Array.isArray(ops)) {
        return refuse(`${path}.ops`, `must be an array of ops (got ${describeValue(ops)})`);
    }

    return compact({
        file: f.str("file"),
        ops: ops?.map((op, index) => opFromJson(op, `${path}.ops[${index}]`)),
        delete: f.optBool("delete"),
        renameTo: f.optStr("renameTo"),
        overwrite: f.optBool("overwrite"),
        allowGenerated: f.optBool("allowGenerated"),
        createWith: f.optStr("createWith"),
        expectAfter: f.optStrings("expectAfter"),
        absentAfter: f.optStrings("absentAfter"),
        absentInChange: f.optStrings("absentInChange"),
        gitMove: f.optBool("gitMove"),
        diff: f.optOneOf("diff", DIFF_LEVELS),
    });
};

/**
 * Every RegExp field (regex `find`, dropComments and deleteLines `matching`) is { source, flags }; a replacer is a
 * string only; an unknown key is refused. A bad field throws FableReplaceError code 2 naming its path ("[2].ops[0].find").
 */
export const editsFromJson = (value: unknown): FileEdit[] => {
    if (!Array.isArray(value)) {
        return refuse("the top level", `must be an array of file edits (got ${describeValue(value)})`);
    }

    return value.map((edit, index) => fileEditFromJson(edit, `[${index}]`));
};

const opResultToJson = (op: OpResult): RunReportJson["files"][number]["ops"][number] => {
    return compact({
        status: op.status === "NOOP" ? "MISS" : op.status,
        desc: op.desc,
        found: op.found,
        expected: op.expected,
        reason: op.reason,
        lines: op.lines,
        currentSha256: op.currentSha256,
    });
};

const fileResultToJson = (file: FileResult): RunReportJson["files"][number] => {
    return compact({
        file: file.file,
        renamedTo: file.renamedTo,
        action: file.action,
        reason: file.reason,
        sha256Before: file.sha256Before,
        diffStat: file.diffStat,
        diff: file.diff,
        ops: file.ops.map(opResultToJson),
        postConditionFailures: file.postConditionFailures,
    });
};

const verifyToJson = (verify: VerifyResult): NonNullable<RunReportJson["verify"]> => {
    return compact({
        command: verify.command,
        status: verify.status,
        exitCode: verify.exitCode,
        timedOut: verify.timedOut,
        control: verify.control,
        shown: verify.shown,
        outputFile: verify.outputFile,
    });
};

/** The exit code run() would have used for a report it returned or attached to its error. */
const exitCodeOf = (report: RunReport, dryRun: boolean): RunReportJson["exitCode"] => {
    if (report.ok) {
        return 0;
    }

    if (report.verify !== undefined && report.verify.status !== "pass") {
        return 3;
    }

    // Misses (or a dry run) mean nothing or not everything landed; a written, miss-free run that is
    // not ok left stale prose behind, which run() reports as a 3 like a red verify.
    return dryRun || report.missCount > 0 || report.written.length === 0 ? 1 : 3;
};

/**
 * One run's outcome as RunReportJson. `report` is what run() returned; `error` is what it threw (a
 * FableReplaceError carries its exit code and, past pre-flight, its report). With neither a report nor one
 * attached to the error, the answer is a refusal: ok false, the error's code (2 for a FableReplaceError
 * refusal, 1 for anything else) and its message.
 */
export const reportToJson = ({
    report,
    error,
    dryRun,
    warnings = [],
}: {
    report?: RunReport;
    error?: unknown;
    dryRun: boolean;
    /** Warnings met before run() (a spec's), listed ahead of the run's own. */
    warnings?: string[];
}): RunReportJson => {
    const thrown = error instanceof FableReplaceError ? error : undefined;
    const source = report ?? thrown?.report;
    const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    const allWarnings = [...warnings, ...(source?.warnings ?? [])];
    if (source === undefined) {
        return {
            v: 1,
            ok: false,
            exitCode: thrown?.code ?? (error === undefined ? 2 : 1),
            dryRun,
            missCount: 0,
            written: [],
            files: [],
            ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
            error: message ?? "no report and no error to describe",
        };
    }

    const exitCode = thrown?.code ?? (error === undefined ? exitCodeOf(source, dryRun) : 1);
    return compact({
        v: 1,
        ok: exitCode === 0,
        exitCode,
        dryRun,
        missCount: source.missCount,
        written: [...source.writtenPaths],
        backupDir: source.backupDir,
        files: source.files.map(fileResultToJson),
        verify: source.verify === undefined ? undefined : verifyToJson(source.verify),
        warnings: allWarnings.length > 0 ? allWarnings : undefined,
        error: message,
    });
};
