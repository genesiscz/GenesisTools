import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureNativeSources, nativeNeedsBuild, recordNativeBuild } from "./native-build";

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
    recordNativeBuild({ binary, sourceDir, before: captureNativeSources(sourceDir) });
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(false);
    writeFileSync(source, "print(2)");
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
    recordNativeBuild({ binary, sourceDir, before: captureNativeSources(sourceDir) });
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
    recordNativeBuild({ binary, sourceDir, before: captureNativeSources(sourceDir) });
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(false);
    rmdirSync(join(sourceDir, "SnapshotSupport"));
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(true);
});

test("a receipt keeps a no-op native build fresh after source timestamps change", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "control-build-receipt-"));
    const binary = join(sourceDir, ".build", "release", "ax-tool");
    mkdirSync(join(sourceDir, "Sources"));
    mkdirSync(join(sourceDir, "SnapshotSupport"));
    mkdirSync(join(sourceDir, ".build", "release"), { recursive: true });
    writeFileSync(join(sourceDir, "Package.swift"), "package");
    writeFileSync(join(sourceDir, "Sources", "main.swift"), "print(1)");
    writeFileSync(binary, "compiled");

    const before = captureNativeSources(sourceDir);
    recordNativeBuild({ binary, sourceDir, before });
    utimesSync(join(sourceDir, "Sources", "main.swift"), 400, 400);

    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(false);
});

test("recording refuses a build whose native source changed after capture", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "control-build-race-"));
    const binary = join(sourceDir, ".build", "release", "ax-tool");
    mkdirSync(join(sourceDir, "Sources"));
    mkdirSync(join(sourceDir, "SnapshotSupport"));
    mkdirSync(join(sourceDir, ".build", "release"), { recursive: true });
    writeFileSync(join(sourceDir, "Package.swift"), "package");
    const source = join(sourceDir, "Sources", "main.swift");
    writeFileSync(source, "print(1)");
    writeFileSync(binary, "compiled");

    const before = captureNativeSources(sourceDir);
    writeFileSync(source, "print(2)");

    expect(() => recordNativeBuild({ binary, sourceDir, before })).toThrow("native sources changed during build");
    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(true);
});

test("adding a Swift source invalidates a receipt-backed binary", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "control-build-add-"));
    const binary = join(sourceDir, ".build", "release", "ax-tool");
    mkdirSync(join(sourceDir, "Sources"));
    mkdirSync(join(sourceDir, "SnapshotSupport"));
    mkdirSync(join(sourceDir, ".build", "release"), { recursive: true });
    writeFileSync(join(sourceDir, "Package.swift"), "package");
    writeFileSync(join(sourceDir, "Sources", "main.swift"), "print(1)");
    writeFileSync(binary, "compiled");
    recordNativeBuild({ binary, sourceDir, before: captureNativeSources(sourceDir) });

    writeFileSync(join(sourceDir, "SnapshotSupport", "new.swift"), "struct NewSource {}\n");

    expect(nativeNeedsBuild({ binary, sourceDir })).toBe(true);
});
