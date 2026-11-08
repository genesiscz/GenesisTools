import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import * as edits from "../lib/edit";
import { verifyHidden } from "../lib/fx-analysis";
import { clock, hidePrivateHint } from "./fx-analysis";

// The export verifyHidden makes stands in: a file that is not a movie, so the check fails right after the export.
const exported: string[] = [];
mock.module("../lib/edit", () => ({
    ...edits,
    exportAs: async (_value: string, options: { out?: string }) => {
        const out = options.out ?? join(mkdtempSync(join(tmpdir(), "gt-fake-export-")), "verify.mp4");
        exported.push(out);
        writeFileSync(out, "not a movie");
        return { ok: true, path: out };
    },
}));

describe("the fx analysis commands' output", () => {
    // Review CLI-F6: the ISO slice dropped the hours, so a leak at 1:02:05 printed as 02:05.0.
    test("a time at or after an hour keeps its hours", () => {
        expect(clock(0)).toBe("00:00.0");
        expect(clock(65.2)).toBe("01:05.2");
        expect(clock(3599.9)).toBe("59:59.9");
        expect(clock(3725)).toBe("1:02:05.0");
        expect(clock(36_000)).toBe("10:00:00.0");
    });

    // Review CLI-F2: the hint dropped --names and --exclude-fixed, so the printed command left the names readable.
    test("the hide-them-all hint carries the names and exclude-fixed it listed with", () => {
        const op = (hint: string) => SafeJSON.parse(hint.match(/'(\{.*?\})'/)?.[1] ?? "{}", { strict: true });

        expect(op(hidePrivateHint("last", {}))).toEqual({ op: "hidePrivate" });
        expect(
            op(hidePrivateHint("last", { names: ["Alice Example", " ", "Bob Example"], excludeFixed: true }))
        ).toEqual({ op: "hidePrivate", names: ["Alice Example", "Bob Example"], excludeFixed: true });
        // The ids form names them too: the op finds the name hits only when it looks for the names.
        expect(hidePrivateHint("last", { names: ["Alice Example"] })).toContain('"names":["Alice Example"],"ids":[…]');
        // A quote in a name stays inside the shell's single quotes.
        expect(hidePrivateHint("last", { names: ["Ann O'Example"] })).toContain(`["Ann O'\\''Example"]`);
    });
});

describe("verify-hidden's own export (review CLI-F8)", () => {
    // Each verify left a full export in $TMPDIR (hundreds of MB for a 5-minute demo), and macOS clears it after days.
    test("the export it made for the check is removed after it, unless keepExport asks to keep it", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-verify-scratch-"));
        const path = join(folder, "demo.edit.json");
        writeProject(
            path,
            wholeProject({ video: join(folder, "demo.mp4"), durationUs: 2_000_000, width: 64, height: 36 })
        );

        await expect(verifyHidden(path, { text: "Alice Example" })).rejects.toThrow();
        expect(exported).toHaveLength(1);
        expect(existsSync(dirname(exported[0]))).toBe(false);

        await expect(verifyHidden(path, { text: "Alice Example", keepExport: true })).rejects.toThrow();
        expect(exported).toHaveLength(2);
        expect(existsSync(exported[1])).toBe(true);
    });
});
