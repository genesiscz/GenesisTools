import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = readFileSync(join(import.meta.dir, "../../../native/ax-tool/Package.swift"), "utf8");

// CGWindowListCreateImage is SCREEN_CAPTURE_OBSOLETE(10.5,14.0,15.0): it leaves the SDK the moment
// the deployment target reaches 15, and it is the only screenshot path ax-tool has. Raising the
// target without a ScreenCaptureKit path would remove every screenshot silently.
test("the native deployment target stays on macOS 13 while CGWindowListCreateImage is the screenshot path", () => {
    expect(manifest).toContain("platforms: [.macOS(.v13)]");
    expect(manifest).toContain("SCREEN_CAPTURE_OBSOLETE");
});

test("right-click fallback errors reach the outer focus-restoration handler before exiting", () => {
    const source = readFileSync(
        join(import.meta.dir, "../../../native/ax-tool/Sources/SnapshotWorkflow.swift"),
        "utf8"
    );
    const fallback = source.indexOf("case .showMenu:");
    const nextAction = source.indexOf('    case "paste":', fallback);
    expect(fallback).toBeGreaterThan(-1);
    expect(nextAction).toBeGreaterThan(fallback);

    // workflowFailure exits the process. A pointer catch that calls it skips the outer focus guard.
    const pointerTail = source.slice(fallback, nextAction);
    expect(pointerTail).toContain("throw WindowEventError.unavailable");
    expect(pointerTail).not.toContain("workflowFailure(");
    expect(pointerTail).toMatch(/catch\s*\{\s*(?:\/\/[^\n]*\n\s*)*throw error\s*\}\s*$/);
    expect(source.slice(nextAction)).toContain(
        "workflowFailure(error, extras: contextMenuAction ? secondaryClickFrontGuard(before: activeBefore, target: pid) : [:])"
    );
});

test("explicit AXShowMenu checks takeover after its baseline and immediately before dispatch", () => {
    const source = readFileSync(
        join(import.meta.dir, "../../../native/ax-tool/Sources/SnapshotWorkflow.swift"),
        "utf8"
    );
    const start = source.indexOf('        if name == "AXShowMenu" {');
    const end = source.indexOf("            contextMenuSeen = outcome == .opened", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toMatch(
        /let baseline = workflowMenuBaseline\([^\n]+\)\s+try inputGate\.check\(\)\s+let outcome = workflowShowMenu\([^;]+baseline: baseline\)/
    );
});

test("legacy global input checks foreground permission independently of app activation", () => {
    const source = readFileSync(
        join(import.meta.dir, "../../../native/ax-tool/Sources/commands/Harness.swift"),
        "utf8"
    );
    for (const method of ["postRouted()", "pressRouted(release up: CGEvent)"]) {
        const start = source.indexOf(`func ${method}`);
        expect(start).toBeGreaterThan(-1);
        const body = source.slice(start, source.indexOf("\n    }", start));
        expect(body).toMatch(
            /foregroundInputGate\.dispatch\(background: argValue\("--to-pid"\) != nil\)\s*\{\s*try inputGate\.(?:post|press)\(/
        );
    }
    const gate = readFileSync(join(import.meta.dir, "../../../native/ax-tool/Sources/utils/InputGate.swift"), "utf8");
    expect(gate).toContain("ForegroundInputGate(check: checkForegroundAllowed)");
    expect(gate).toMatch(/catch let refusal as UserActiveError\s*\{\s*userActiveExit\(refusal\)/);
    expect(gate).not.toContain("last-synthetic-input");
});

test("snapshot restore checks foreground permission before pointer or app changes", () => {
    const source = readFileSync(
        join(import.meta.dir, "../../../native/ax-tool/Sources/commands/SnapshotRestore.swift"),
        "utf8"
    );
    const restore = source.slice(source.indexOf("func cmdRestore("));
    const guard = restore.indexOf("gatedOrExit { try checkForegroundAllowed() }");
    expect(guard).toBeGreaterThan(-1);
    expect(restore.indexOf("CGWarpMouseCursorPosition")).toBeGreaterThan(guard);
    expect(restore.indexOf("runningApp.activate(")).toBeGreaterThan(guard);
});

test("single-window recording validates exclusions before creating a capture stream", () => {
    const source = readFileSync(join(import.meta.dir, "../../../native/ax-tool/Sources/Record.swift"), "utf8");
    const guard = source.indexOf(
        "try validateRecordingWindow(target.id, excluding: options.selection.excludedWindowIDs)"
    );
    expect(guard).toBeGreaterThan(-1);
    expect(source.indexOf("windowTarget = target")).toBeGreaterThan(guard);
    expect(source.indexOf("SCContentFilter(desktopIndependentWindow: window)")).toBeGreaterThan(guard);
});
