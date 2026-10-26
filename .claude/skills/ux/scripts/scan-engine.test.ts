import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swiftFiles } from "./scan-engine";

describe("Swift scanner file discovery", () => {
    it("finds nested Swift files and excludes hidden, build and test directories", () => {
        const root = mkdtempSync(join(tmpdir(), "swift-scan-"));
        const source = join(root, "Sources");
        mkdirSync(source);
        const file = join(source, "View.swift");
        writeFileSync(file, "struct ExampleView {}\n");
        writeFileSync(join(source, "README.md"), "ignored");

        for (const name of [".hidden", ".build", "Tests"]) {
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, "Ignored.swift"), "ignored");
        }

        const files: string[] = [];
        swiftFiles(root, files);
        expect(files).toEqual([file]);

        const direct: string[] = [];
        swiftFiles(file, direct);
        expect(direct).toEqual([file]);
    });

    it("skips dangling links, ancestor cycles and linked Swift files", () => {
        const root = mkdtempSync(join(tmpdir(), "swift-scan-links-"));
        const file = join(root, "View.swift");
        writeFileSync(file, "struct ExampleView {}\n");
        const links = [join(root, "a-dangling.swift"), join(root, "b-cycle"), join(root, "c-linked.swift")];
        symlinkSync(join(root, "missing"), links[0]);
        symlinkSync(root, links[1]);
        symlinkSync(file, links[2]);

        const files: string[] = [];
        swiftFiles(root, files);
        expect(files).toEqual([file]);

        for (const link of links) {
            const direct: string[] = [];
            swiftFiles(link, direct);
            expect(direct).toEqual([]);
        }
    });
});

describe("Swift audit scanner candidates", () => {
    it("includes AppKit actions without including background-only process calls", () => {
        const root = mkdtempSync(join(tmpdir(), "swift-action-scan-"));
        writeFileSync(
            join(root, "Action.swift"),
            "final class Action: NSObject {\n@IBAction func run() {\nprocess.waitUntilExit()\n}\n}\n"
        );
        writeFileSync(join(root, "Worker.swift"), "final class Worker {\nprocess.waitUntilExit()\n}\n");
        const result = Bun.spawnSync(
            [process.execPath, new URL("../../swift/scripts/swift-scan.ts", import.meta.url).pathname, root],
            { env: process.env }
        );
        expect(result.exitCode).toBe(0);
        const output = result.stdout.toString();
        expect(output).toContain("process-or-encode [1]");
        expect(output).toContain("Action.swift:3");
        expect(output).not.toContain("Worker.swift:");
    });

    it("flags either frame dimension below 22 without matching larger numbers", () => {
        const root = mkdtempSync(join(tmpdir(), "swift-target-scan-"));
        writeFileSync(
            join(root, "Targets.swift"),
            [
                ".frame(width: 21, height: 21)",
                ".frame(width: 40, height: 10)",
                ".frame(width: 22, height: 22)",
                ".frame(width: 121, height: 100)",
                ".frame(height: 21.5)",
            ].join("\n")
        );
        const result = Bun.spawnSync([process.execPath, new URL("./ux-scan.ts", import.meta.url).pathname, root], {
            env: process.env,
        });
        expect(result.exitCode).toBe(0);
        const candidates = result.stdout.toString().split("- small-frame")[1]?.split("- small-glyph-button")[0];
        expect(candidates).toContain("[3]");
        expect(candidates).toContain("Targets.swift:1");
        expect(candidates).toContain("Targets.swift:2");
        expect(candidates).toContain("Targets.swift:5");
        expect(candidates).not.toContain("Targets.swift:3");
        expect(candidates).not.toContain("Targets.swift:4");
    });
});
