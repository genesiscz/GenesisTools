import { describe, expect, test } from "bun:test";
import { FableReplaceError } from "./internal";
import { editsFromJson, reportToJson } from "./report-json";
import type { FileEdit, RunReport } from "./types";

// The JSON doors are a contract for code mode, the CLI's --edits and the MCP tool. These tests pin the round trip of
// every RegExp-bearing op, the refusal of a bad or unknown field by its path, and the report shape a caller parses.

/** What a code-mode caller sends: RegExp fields as { source, flags }, then parsed back from text. */
const throughJson = (edits: FileEdit[]): unknown => {
    const text = JSON.stringify(edits, (_key, value: unknown) =>
        value instanceof RegExp ? { source: value.source, flags: value.flags } : value
    );
    return JSON.parse(text);
};

const refusal = (value: unknown): FableReplaceError => {
    try {
        editsFromJson(value);
    } catch (err) {
        if (err instanceof FableReplaceError) {
            return err;
        }

        throw err;
    }

    throw new Error("editsFromJson accepted the value");
};

describe("editsFromJson", () => {
    test("a literal, a regex, deleteLines and dropComments with matching, and a rewrite round-trip", () => {
        const edits: FileEdit[] = [
            {
                file: "src/alpha.ts",
                ops: [
                    { find: "oldName", replace: "newName", count: "all", label: "rename" },
                    { kind: "regex", find: /foo(\d+)/g, replace: "bar$1", expect: 2 },
                    { kind: "deleteLines", matching: /^\s*debugger;$/m, expect: 1 },
                    { kind: "dropComments", matching: /TODO/i, scope: "line", optional: true },
                ],
                expectAfter: ["newName"],
                absentAfter: ["oldName"],
                absentInChange: ["console.log"],
                diff: "full",
            },
            {
                file: "src/beta.ts",
                ops: [{ kind: "rewrite", content: "export const beta = 2;\n", expectSha256: "a".repeat(64) }],
                renameTo: "src/gamma.ts",
                gitMove: true,
            },
            { file: "src/old.ts", delete: true },
        ];

        const back = editsFromJson(throughJson(edits));

        expect(back).toEqual(edits);
        const regex = back[0].ops?.[1];
        expect(regex?.kind === "regex" ? regex.find.flags : undefined).toBe("g");
        // No key is present with an undefined value, so a later spread cannot erase a set field.
        expect(Object.keys(back[2])).toEqual(["file", "delete"]);
    });

    test("a wrong field type names its path", () => {
        const err = refusal([{ file: 1 }]);
        expect(err.code).toBe(2);
        expect(err.message).toContain("[0].file");
    });

    test("an unknown key names its path", () => {
        const err = refusal([{ file: "a", opz: [] }]);
        expect(err.code).toBe(2);
        expect(err.message).toContain("[0].opz");
        expect(refusal([{ file: "a", absentAfer: ["x"] }]).message).toContain("[0].absentAfer");
    });

    test("a bad op field names the op's path", () => {
        const fine = { file: "a", ops: [{ find: "x", replace: "y" }] };
        const regexAsText = refusal([fine, fine, { file: "c", ops: [{ kind: "regex", find: "x", replace: "y" }] }]);
        expect(regexAsText.message).toContain("[2].ops[0].find");
        expect(
            refusal([{ file: "a", ops: [{ kind: "regex", find: { source: "(" }, replace: "" }] }]).message
        ).toContain("[0].ops[0].find is not a valid regex");
        expect(refusal([{ file: "a", ops: [{ kind: "regex", find: { source: "x" }, replace: 1 }] }]).message).toContain(
            "[0].ops[0].replace"
        );
        expect(refusal([{ file: "a", ops: [{ kind: "wipe" }] }]).message).toContain("[0].ops[0].kind");
        expect(refusal([{ file: "a", ops: [{ find: "x", replace: "y", cuont: 2 }] }]).message).toContain(
            "[0].ops[0].cuont"
        );
        expect(refusal({ file: "a" }).message).toContain("array");
    });
});

describe("reportToJson", () => {
    const report: RunReport = {
        ok: false,
        files: [
            {
                file: "/repo/src/alpha.ts",
                action: "edited",
                ops: [{ status: "OK", desc: "rename", found: 3, expected: "all", lines: [1, 4, 9] }],
                postConditionFailures: [],
                changed: true,
                diffStat: { added: 3, removed: 3 },
            },
        ],
        written: ["/repo/src/alpha.ts"],
        writtenPaths: ["/repo/src/alpha.ts"],
        missCount: 0,
        backupDir: "/tmp/backup",
        verify: {
            command: "bun run test",
            status: "fail",
            exitCode: 1,
            signal: null,
            timedOut: false,
            buffered: false,
            ms: 120,
            outputChars: 40,
            shown: ["1 fail"],
        },
    };

    test("a code 2 refusal without a report gives ok false, exit 2 and the error", () => {
        const json = reportToJson({
            error: new FableReplaceError("edits JSON: [0].file is required", 2),
            dryRun: true,
        });
        expect(json).toEqual({
            v: 1,
            ok: false,
            exitCode: 2,
            dryRun: true,
            missCount: 0,
            written: [],
            files: [],
            error: "edits JSON: [0].file is required",
        });
    });

    test("a thrown report keeps its code and maps files, ops and verify", () => {
        const json = reportToJson({ error: new FableReplaceError("verify failed", 3, report), dryRun: false });
        expect(json.ok).toBe(false);
        expect(json.exitCode).toBe(3);
        expect(json.files).toEqual([
            {
                file: "/repo/src/alpha.ts",
                action: "edited",
                diffStat: { added: 3, removed: 3 },
                ops: [{ status: "OK", desc: "rename", found: 3, expected: "all", lines: [1, 4, 9] }],
                postConditionFailures: [],
            },
        ]);
        expect(json.verify).toEqual({
            command: "bun run test",
            status: "fail",
            exitCode: 1,
            timedOut: false,
            shown: ["1 fail"],
        });
        expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    });

    test("a returned report is exit 0 and carries no error", () => {
        const json = reportToJson({ report: { ...report, ok: true, verify: undefined }, dryRun: false });
        expect(json.ok).toBe(true);
        expect(json.exitCode).toBe(0);
        expect("error" in json).toBe(false);
        expect("verify" in json).toBe(false);
        expect(json.backupDir).toBe("/tmp/backup");
    });
});
