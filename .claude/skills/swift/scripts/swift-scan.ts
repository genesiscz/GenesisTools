#!/usr/bin/env bun
/**
 * Lists candidate cost and wrong-state defects in Swift files, grouped by the passes of references/audit.md. A line
 * here is a candidate, not a finding: read the caller (which thread, how often) before you report it. The scan only
 * reads files. The engine is shared with the ux skill's scanner.
 *
 * Usage: bun .claude/skills/swift/scripts/swift-scan.ts <file or folder>... [--max <hits per check, default 60>]
 */
import { type Check, type CountFact, type FileFact, runCli, type ScanSet } from "../../ux/scripts/scan-engine.ts";

/** A view, a view model or anything on the main actor: where blocking work stalls the UI. */
const MAIN_ACTOR_FILE =
    /:\s*View\b|some View|@MainActor|ObservableObject|NSViewController|NSWindowController|@IBAction/;
const VIEW_FILE = /:\s*View\b|some View/;

const CHECKS: Check[] = [
    {
        pass: "1. The main thread",
        name: "blocking-io",
        pattern:
            /String\(contentsOf|Data\(contentsOf|NSImage\(contentsOf|contentsOfDirectory|enumerator\(at|fileExists\(atPath|attributesOfItem|\.write\(to:|FileLock\.withLock|Thread\.sleep|DispatchSemaphore|\.wait\(\)/,
        hint: "file or lock work: follow the callers; does one run on the main actor on a click, tick or publish?",
    },
    {
        pass: "1. The main thread",
        name: "process-or-encode",
        pattern:
            /Process\(\)|waitUntilExit|JSONEncoder\(\)\.encode|CIContext\(\)|defaults\.set\([^)]*Data|sqlite3_|\.prepare\(/,
        hint: "a process, an encode, an image render or a database read: on the main actor? how big, how often?",
        onlyIn: MAIN_ACTOR_FILE,
    },
    {
        pass: "1. The main thread",
        name: "menu-validation",
        pattern: /func validateMenuItem|func validateUserInterfaceItem|validateMenuItem/,
        hint: "runs on every menu open: only cheap reads here",
    },
    {
        pass: "1. The main thread",
        name: "write-per-item",
        pattern: /self\.\w+\.append\(|self\.\w+\[\w+\] = /,
        hint: "a published write inside a loop? build locally and assign once",
        unless: /var \w+ = self\./,
        near: 4,
    },
    {
        pass: "2. Work that runs too often",
        name: "file-watch",
        pattern:
            /FSEventStreamCreate|DirectoryWatcher\(|DispatchSource\.makeFileSystemObjectSource|FSEventStreamSetDispatchQueue/,
        hint: "ignores paths nobody reads? debounced? anyone consuming the result right now? which queue?",
    },
    {
        pass: "2. Work that runs too often",
        name: "task-restart",
        pattern: /\.task\(id:|\.onChange\(of:/,
        hint: "what restarts it, how often, and does each restart start a process or a reload?",
        byFile: true,
    },
    {
        pass: "2. Work that runs too often",
        name: "polling-loop",
        pattern:
            /Task\.sleep\(for: \.seconds\(|Task\.sleep\(nanoseconds:|Timer\.scheduledTimer\([^)]*repeats: true|Timer\.publish\(every:|TimelineView\(\.periodic|asyncAfter\(deadline: \.now\(\) \+ (0\.[0-9]|[1-9])/,
        hint: "a loop or a ticker: does it run for hidden windows, and does each tick recompute more than it shows?",
    },
    {
        pass: "2. Work that runs too often",
        name: "cli-call",
        pattern: /ToolsBridge\(|bridge\.(run|call|json|action)|runTools\(|execTool/,
        hint: "a process per call (350 to 420 ms here): per action, per open, per folder? a server door or a dedupe?",
    },
    {
        pass: "2. Work that runs too often",
        name: "write-or-publish-unconditionally",
        pattern: /writePrivate\(|postNotificationName|DistributedNotificationCenter|\.publish\(\)/,
        hint: "written or posted on every change: skip it when nobody reads it",
    },
    {
        pass: "3. Redraws wider than the change",
        name: "hot-published",
        pattern:
            /@Published (public |private\(set\) |public private\(set\) )?var \w*(level|Level|rms|partial|Partial|progress|Progress|draft|Draft|voice|Voice|text|Text)\b/,
        hint: "a fast-changing value on a model many views observe: give it its own small ObservableObject",
    },
    {
        pass: "3. Redraws wider than the change",
        name: "row-observes-model",
        pattern: /@ObservedObject (public |private )?var \w+: \w+(Model|Store|Session|Session\w*)\b/,
        hint: "in a row or a list: does it read the model, or only call actions? rows take values",
        byFile: true,
        onlyIn: VIEW_FILE,
    },
    {
        pass: "3. Redraws wider than the change",
        name: "linear-search-in-view",
        pattern: /\.first \{ \$0\.(key|id|sessionKey) ==|\.first\(where: \{ \$0\.(key|id) ==|\.filter \{ \$0\.\w+ == /,
        hint: "a search per read or per row: read once per body, or use the model's dictionary",
        byFile: true,
        onlyIn: VIEW_FILE,
    },
    {
        pass: "3. Redraws wider than the change",
        name: "inline-observed-init",
        pattern: /@ObservedObject (private )?var \w+ = \w+\(/,
        hint: "an observed object made inline is recreated with the parent: @StateObject",
    },
    {
        pass: "4. Work inside a body",
        name: "formatter-or-parser",
        pattern:
            /(?<!static let \w{1,40} = )\b(DateFormatter|NumberFormatter|ISO8601DateFormatter|RelativeDateTimeFormatter|ByteCountFormatter|DateComponentsFormatter|NSRegularExpression)\(\)|options: \.regularExpression|AttributedString\(markdown:|[iI]nlineMarkdown\(|Markdown\w*\.parse\(/,
        hint: "built per call: is this reached from a body, a computed property it reads, or a row?",
        unless: /static (let|var)/,
        near: 0,
        onlyIn: VIEW_FILE,
    },
    {
        pass: "4. Work inside a body",
        name: "derived-list",
        pattern:
            /private var \w+: \[|Dictionary\(grouping:|\.sorted\(|\.joined\(separator:|localizedCaseInsensitiveContains|\.reduce\(/,
        hint: "a list derived while drawing: computed once per change of its inputs, in the model?",
        byFile: true,
        onlyIn: VIEW_FILE,
    },
    {
        pass: "4. Work inside a body",
        name: "identity",
        pattern: /\.id\(UUID\(\)\)|\.id\(Date\(\)\)|ForEach\([^)]*\.indices|id: \\\.self|AnyView\(/,
        hint: "unstable identity resets state and rebuilds rows",
        byFile: true,
    },
    {
        pass: "4. Work inside a body",
        name: "binding-in-body",
        pattern: /Binding\(get:|GeometryReader \{/,
        hint: "a Binding or a GeometryReader in a repeated or hot view?",
        byFile: true,
        onlyIn: VIEW_FILE,
    },
    {
        pass: "5. Animation and drawing",
        name: "with-animation",
        pattern: /withAnimation\(/,
        hint: "around a first load or a bulk list change? (a list helper's guard, SWR.animates in the hub)",
        unless: /animates\(|reduceMotion \? nil|GenMotion/,
        near: 2,
    },
    {
        pass: "5. Animation and drawing",
        name: "continuous-swiftui-animation",
        pattern:
            /repeatForever|LoopingAnimation|PhaseAnimator|KeyframeAnimator|\.animation\([^)]*\), value: (level|rms|\w*Level)/,
        hint: "a loop or an audio-rate animation in SwiftUI: a layer animation in a representable instead",
    },
    {
        pass: "5. Animation and drawing",
        name: "expensive-effect",
        pattern: /\.shadow\(radius: (1[2-9]|[2-9]\d)|\.blur\(radius:|\.drawingGroup\(\)|\.compositingGroup\(\)/,
        hint: "a large shadow or blur on something that animates or updates often?",
    },
    {
        pass: "5. Animation and drawing",
        name: "custom-layout",
        pattern: /:\s*Layout \{|func placeSubviews|func makeCache/,
        hint: "a Layout that calls sizeThatFits on children in both sizeThatFits and placeSubviews measures twice",
    },
    {
        pass: "6. AppKit bridging and windows",
        name: "update-ns-view",
        pattern: /func updateNSView\(|\.rootView = |\.stringValue = |needsLayout = true/,
        hint: "an unconditional set in updateNSView rebuilds or relayouts on every SwiftUI update",
    },
    {
        pass: "6. AppKit bridging and windows",
        name: "observer-or-monitor",
        pattern:
            /addObserver\(|addLocalMonitorForEvents|addGlobalMonitorForEvents|NotificationCenter\.default\.publisher/,
        hint: "removed in dismantleNSView, deinit or onDisappear?",
        byFile: true,
    },
    {
        pass: "7. Concurrency and state",
        name: "published-sink",
        pattern: /\$\w+\s*\.sink|\$\w+\.sink\s*\{|\.sink \{ \[weak self\] _ in/,
        hint: "a @Published sink fires in willSet: does the closure read the old property instead of the value?",
    },
    {
        pass: "7. Concurrency and state",
        name: "unowned-task",
        pattern: /Task\.detached|Task \{ try|for .* in .* \{\s*Task \{/,
        hint: "why detached? does an error vanish? a Task per item in a loop?",
        byFile: true,
    },
    {
        pass: "7. Concurrency and state",
        name: "unchecked-sendable",
        pattern: /@unchecked Sendable|nonisolated\(unsafe\)|@preconcurrency|MainActor\.assumeIsolated/,
        hint: "the invariant written beside it?",
        byFile: true,
    },
];

const COUNTS: CountFact[] = [
    {
        name: "@Observable types",
        pattern: /@Observable\b/,
        zeroMeans: "every observer redraws on any publish of its object",
    },
    { name: "ObservableObject types", pattern: /:\s*[^{]*\bObservableObject\b/, zeroMeans: "none" },
    {
        name: "signposts and perf spans",
        pattern: /OSSignposter|PerfLog\.span|HubMainBusy|RenderProbe/,
        zeroMeans: "nothing here is measured; add a span before you judge a cost",
    },
];

const FILE_FACTS: FileFact[] = [
    {
        name: "main-actor files with the most @Published properties",
        test: (text, lines) => {
            if (!/@MainActor/.test(text)) {
                return undefined;
            }

            const count = lines.filter((l) => l.includes("@Published")).length;
            return count >= 15 ? `${count} @Published` : undefined;
        },
    },
    {
        name: "files that animate a list with withAnimation and no first-load guard",
        test: (text) =>
            /withAnimation\(/.test(text) && /ForEach/.test(text) && !/animates\(/.test(text) ? "" : undefined,
    },
];

const SWIFT_SET: ScanSet = { title: "Swift scan", checks: CHECKS, counts: COUNTS, fileFacts: FILE_FACTS };

if (import.meta.main) {
    runCli(SWIFT_SET, process.argv.slice(2), "usage: bun swift-scan.ts <file or folder>... [--max <n>]");
}
