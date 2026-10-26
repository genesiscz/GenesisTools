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
