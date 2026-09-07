import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeNeedsBuild } from "./native-build";

test("native source edits invalidate an existing binary", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "control-build-test-"));
    const binary = join(sourceDir, "ax-tool");
    writeFileSync(join(sourceDir, "Package.swift"), "package");
    utimesSync(join(sourceDir, "Package.swift"), 100, 100);
    mkdirSync(join(sourceDir, "SnapshotSupport"));
    utimesSync(join(sourceDir, "SnapshotSupport"), 100, 100);
    mkdirSync(join(sourceDir, "Sources"));
    const source = join(sourceDir, "Sources", "main.swift");
    writeFileSync(source, "print(1)");
    writeFileSync(binary, "compiled");
    utimesSync(source, 100, 100);
    utimesSync(binary, 200, 200);
    utimesSync(join(sourceDir, "Sources"), 100, 100);
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(false);
    utimesSync(source, 300, 300);
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(true);
});

test("removing a Swift source invalidates the binary that still contains it", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "control-build-delete-"));
    const binary = join(sourceDir, "ax-tool");
    writeFileSync(join(sourceDir, "Package.swift"), "package");
    utimesSync(join(sourceDir, "Package.swift"), 100, 100);
    mkdirSync(join(sourceDir, "SnapshotSupport"));
    utimesSync(join(sourceDir, "SnapshotSupport"), 100, 100);
    const directory = join(sourceDir, "Sources");
    mkdirSync(directory);
    const source = join(directory, "removed.swift");
    writeFileSync(source, "print(1)");
    writeFileSync(binary, "compiled");
    utimesSync(source, 100, 100);
    utimesSync(directory, 100, 100);
    utimesSync(binary, 200, 200);
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(false);
    unlinkSync(source);
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(true);
});

test("removing an entire native target cannot leave its old executable trusted", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "control-build-root-"));
    const binary = join(sourceDir, "ax-tool");
    writeFileSync(join(sourceDir, "Package.swift"), "package");
    utimesSync(join(sourceDir, "Package.swift"), 100, 100);

    for (const name of ["Sources", "SnapshotSupport"]) {
        mkdirSync(join(sourceDir, name));
        utimesSync(join(sourceDir, name), 100, 100);
    }

    writeFileSync(binary, "compiled");
    utimesSync(binary, 200, 200);
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(false);
    rmdirSync(join(sourceDir, "SnapshotSupport"));
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(true);
});
