import AppKit
import SwiftUI

// MARK: - Settings store

/// Where the hub keeps its layout: panel widths, open panes, pane order, groups, filters.
///
/// A live hub uses the standard domain. A `--snapshot` or `--bench` run works on a scratch copy of
/// the hub's keys, so a scripted resize or pane change never rewrites the layout the live hub
/// restores next time.
enum HubDefaults {
    static let scratchSuite = "com.genesiscz.genesistools.hub-scratch"
    private(set) static var store: UserDefaults = .standard
    private(set) static var isolated = false

    static func isolate() {
        guard !isolated, let scratch = UserDefaults(suiteName: scratchSuite) else { return }
        scratch.removePersistentDomain(forName: scratchSuite)
        let prefixes = ["panel.", "hub.", "groups.", "sessionTranscript."]
        for (key, value) in UserDefaults.standard.dictionaryRepresentation()
        where prefixes.contains(where: key.hasPrefix) {
            scratch.set(value, forKey: key)
        }
        store = scratch
        isolated = true
    }
}

// MARK: - Resize benchmark

/// `GenesisTools --hub --bench <out.json> [--session <id>] [--panes transcript,changes] [--width <pt>]`
///
/// Replays the resizes a person does by hand, off screen (alpha 0, never active), and writes how
/// long the main thread was busy after each step:
/// - `sidebar`: the session list's resize handle, dragged narrower than its minimum, then wider
///   than the window has room for, then back;
/// - `files`: the file list inside the Changes pane, the same way;
/// - `window`: the window itself, down to 900 pt and back;
/// - `split`: the divider between two panes;
/// - `fold`: PRs mode only, the largest PR group folded and unfolded, 0.7 s apart (`busy` is the
///   main thread's whole awake time in that window, the SwiftUI update and every layout after it);
/// - `activity`: Activity mode (`--mode timeline`) only, the rail's kind and project filters clicked;
/// - `inbox`, `inbox.back`: the mode switch to the Inbox and back (by default in Activity mode only);
/// - `open` (opt-in): sessions opened one after another, with how far the transcript sits from its latest turn.
///
/// `GENESIS_HUB_BENCH_AX=1` adds an accessibility client (`HubBenchAccessibilityClient`), which the
/// live hub always has; the click scenarios measured 2 to 18 times higher with it (2026-09-25).
///
/// Every drag step carries ±3 pt of jitter, as a hand does. Steps are spaced so the run loop
/// sleeps in between; `busy` is the step interval minus that spacing, so it holds SwiftUI's update,
/// AppKit layout and drawing. Probes count how often a layout flips (the diff header between one
/// and two rows, the root overflowing the window), which is what reads as flicker.
enum HubBench {
    static let panelDrag = Notification.Name("hub.bench.panelDrag")
    /// A scripted click on a group header: the object is `GroupFold`.
    static let groupFold = Notification.Name("hub.bench.groupFold")

    struct GroupFold {
        let list: String
        let key: String
    }

    /// A scripted drag for `ResizableSidePanel`: the `change` translations match a DragGesture's.
    enum DragPhase {
        case change(CGFloat)
        case end
    }

    struct PanelDrag {
        let key: String
        let phase: DragPhase
    }

    private(set) static var active = false
    private static var probes: [String: [Int]] = [:]

    /// A layout fact at this moment; consecutive equal values are folded, so the count of entries
    /// minus one is the number of flips.
    static func note(_ label: String, _ value: Int) {
        guard active else { return }
        if probes[label]?.last != value {
            probes[label, default: []].append(value)
        }
    }

    @MainActor private static var current: Runner?

    /// The table with the most rows under `view`: the transcript's List when a session is open.
    static func largestTable(in view: NSView?) -> NSTableView? {
        guard let view else { return nil }
        var best = view as? NSTableView
        for child in view.subviews {
            if let found = largestTable(in: child), found.numberOfRows > (best?.numberOfRows ?? -1) {
                best = found
            }
        }
        return best
    }

    /// For a snapshot's log: the transcript's rows on screen (`drawn` leaves out its 1 pt markers)
    /// and in the list, so a padding change can be judged by how much of a session fits.
    @MainActor
    static func transcriptRowsLine(in window: NSWindow) -> String? {
        guard let table = largestTable(in: window.contentView), table.numberOfRows > 0 else { return nil }
        let range = table.rows(in: table.visibleRect)
        let drawn = (range.location..<range.location + range.length).filter { table.rect(ofRow: $0).height > 2 }.count
        return "transcript rows on screen \(range.length) (\(drawn) drawn) of \(table.numberOfRows), \(Int(table.visibleRect.height)) pt"
    }

    @MainActor
    static func run(window: NSWindow, model: HubModel, output: String) {
        active = true
        probes = [:]
        let runner = Runner(window: window, output: output, model: model)
        current = runner
        runner.start()
    }

    /// The watchdog's way out: write what was measured so far, marked partial.
    @MainActor
    static func finishEarly() -> Bool {
        guard let current else { return false }
        current.finish(partial: true)
        return true
    }

    // MARK: Runner

    @MainActor
    private final class Runner {
        private struct Step {
            let scenario: String
            let action: () -> Void
            /// How long the run loop runs after the step before the next one.
            var delay: Double = Runner.spacing
        }

        /// Pause after each step so the run loop commits layout and draws before the next one.
        nonisolated private static let spacing: Double = 0.008

        private let window: NSWindow
        private let output: String
        private let model: HubModel
        private var steps: [Step] = []
        private var index = 0
        private var lastStart: CFAbsoluteTime = 0
        private var lastScenario: String?
        private var busy: [String: [Double]] = [:]
        private var order: [String] = []
        private var seed: UInt64 = 0x9E37_79B9_7F4A_7C15

        init(window: NSWindow, output: String, model: HubModel) {
            self.window = window
            self.output = output
            self.model = model
        }

        func start() {
            // GENESIS_HUB_BENCH_ONLY=sidebar,window runs just those, e.g. while `sample` watches.
            let only = Set((ProcessInfo.processInfo.environment["GENESIS_HUB_BENCH_ONLY"] ?? "").split(separator: ",").map(String.init))
            let wants = { (name: String) in only.isEmpty || only.contains(name) }
            if wants("sidebar") { addPanelSweep(scenario: "sidebar", key: "hub.sidebar", path: [0, -150, 420, 0]) }
            if wants("files"), model.panes.contains(.changes) {
                addPanelSweep(scenario: "files", key: "review.files", path: [0, -260, 150, 0])
            }
            if wants("window") { addWindowSweep() }
            if wants("split") { addSplitSweep() }
            if wants("fold"), model.mode == .prs { addFoldSweep() }
            if wants("activity"), model.mode == .timeline { addActivitySweep() }
            // From another mode (a session's transcript open), opt-in: GENESIS_HUB_BENCH_ONLY=inbox.
            if model.mode == .timeline ? wants("inbox") : model.mode != .inbox && only.contains("inbox") { addInboxSwitch() }
            // Opt-in only (not in the default run): it scrolls the transcript, which loads rows.
            if only.contains("scroll"), model.panes.contains(.transcript) { addTranscriptScroll() }
            if only.contains("open"), model.mode == .sessions, model.panes.contains(.transcript) { addTranscriptOpen() }
            PerfLog.mark("hub.bench start: \(steps.count) steps, panes \(model.panes.map(\.rawValue).joined(separator: ","))")
            guard ProcessInfo.processInfo.environment["GENESIS_HUB_BENCH_AX"] == "1" else {
                tick()
                return
            }
            let count = HubBenchAccessibilityClient.start()
            PerfLog.mark("hub.bench accessibility client: read \(count) elements, trusted=\(AXIsProcessTrusted())")
            tick()
        }

        /// `activity`: Activity mode's rail, clicked the way a reader does, 0.7 s apart: a kind hidden and
        /// shown again, then the busiest project picked and every project again (`busy` is the main
        /// thread's whole awake time after the click: the state change, the list's update and every
        /// layout after it). `GENESIS_HUB_BENCH_ACTIVITY_ROUNDS` sets the rounds (default 3).
        private func addActivitySweep() {
            let timeline = model.timeline
            order.append("activity")
            PerfLog.mark("hub.bench activity: \(timeline.events.count) events, \(timeline.projects.count) projects")
            let rounds = ProcessInfo.processInfo.environment["GENESIS_HUB_BENCH_ACTIVITY_ROUNDS"].flatMap(Int.init) ?? 3
            let kinds = TimelineKind.allCases.map(\.rawValue)
            for round in 0..<rounds {
                let kind = kinds[round % kinds.count]
                let clicks: [() -> Void] = [
                    { timeline.hidden.insert(kind) },
                    { timeline.hidden.remove(kind) },
                    { timeline.project = timeline.projects.first?.name },
                    { timeline.project = nil },
                ]
                for click in clicks {
                    steps.append(Step(scenario: "activity", action: click, delay: 0.7))
                }
            }
        }

        /// `inbox`: the mode switch to the Inbox and back to the starting mode, 1.5 s apart; the first switch
        /// also waits for the Inbox's own load, which lands inside that window.
        private func addInboxSwitch() {
            order += ["inbox", "inbox.back"]
            let model = model
            let from = model.mode
            for _ in 0..<3 {
                steps.append(Step(scenario: "inbox", action: { model.setMode(.inbox) }, delay: 1.5))
                steps.append(Step(scenario: "inbox.back", action: { model.setMode(from) }, delay: 1.5))
            }
        }

        private func jitter() -> CGFloat {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return CGFloat(Int((seed >> 33) % 7) - 3)
        }

        private func addPanelSweep(scenario: String, key: String, path: [CGFloat]) {
            order.append(scenario)
            for (from, to) in zip(path, path.dropFirst()) {
                let direction: CGFloat = to >= from ? 1 : -1
                var value = from
                while (to - value) * direction > 0 {
                    value += 6 * direction
                    let translation = value + jitter()
                    steps.append(Step(scenario: scenario) {
                        NotificationCenter.default.post(name: HubBench.panelDrag, object: PanelDrag(key: key, phase: .change(translation)))
                    })
                }
            }
            steps.append(Step(scenario: scenario) {
                NotificationCenter.default.post(name: HubBench.panelDrag, object: PanelDrag(key: key, phase: .end))
            })
        }

        private func addWindowSweep() {
            order.append("window")
            let window = self.window
            let original = window.frame
            var widths: [CGFloat] = []
            var width = original.width
            while width > 900 { width -= 24; widths.append(width) }
            while width < original.width { width += 24; widths.append(min(width, original.width)) }
            // A hand drag of the window edge brackets these steps with will/didEndLiveResize;
            // `setFrame` sends neither, so the bench signals them the way AppKit would.
            steps.append(Step(scenario: "window") { HubLiveResize.shared.begin("window") })
            for width in widths {
                steps.append(Step(scenario: "window") {
                    var frame = window.frame
                    frame.size.width = width
                    window.setFrame(frame, display: true)
                })
            }
            steps.append(Step(scenario: "window") { HubLiveResize.shared.end("window") })
        }

        private func addSplitSweep() {
            order.append("split")
            // The split view exists only once the panes are laid out; resolve it lazily per step.
            var base: CGFloat?
            let offsets = stride(from: 0, through: -200, by: -8).map { CGFloat($0) }
                + stride(from: -200, through: 200, by: 8).map { CGFloat($0) }
                + stride(from: 200, through: 0, by: -8).map { CGFloat($0) }
            // A divider drag is a mouse-down … mouse-up; HubLiveResize sees it through the mouse.
            steps.append(Step(scenario: "split") { HubLiveResize.shared.begin("split") })
            for offset in offsets {
                steps.append(Step(scenario: "split") { [weak self] in
                    guard let self, let split = Self.splitView(in: self.window.contentView), split.subviews.count > 1 else { return }
                    let start = base ?? split.subviews[0].frame.maxX
                    base = start
                    split.setPosition(start + offset + self.jitter(), ofDividerAt: 0)
                })
            }
            steps.append(Step(scenario: "split") { HubLiveResize.shared.end("split") })
        }

        private func addFoldSweep() {
            let counts = Dictionary(grouping: model.prs.prs, by: \.project).mapValues(\.count)
            // GENESIS_HUB_BENCH_FOLD_KEY=none posts nothing at all: the idle floor to subtract. (Folding a
            // key that names no group still republished the list, which is not idle.)
            guard let group = ProcessInfo.processInfo.environment["GENESIS_HUB_BENCH_FOLD_KEY"]
                ?? counts.max(by: { $0.value < $1.value })?.key else { return }
            order.append("fold")
            PerfLog.mark("hub.bench fold: \(group) (\(counts[group] ?? 0) PRs of \(model.prs.prs.count))")
            // GENESIS_HUB_BENCH_FOLDS=40 gives `sample` a longer window.
            let folds = ProcessInfo.processInfo.environment["GENESIS_HUB_BENCH_FOLDS"].flatMap(Int.init) ?? 10
            for _ in 0..<folds {
                steps.append(Step(scenario: "fold", action: {
                    guard group != "none" else { return }
                    NotificationCenter.default.post(name: HubBench.groupFold, object: GroupFold(list: "prs.repos", key: group))
                }, delay: 0.7))
            }
        }

        /// `scroll`: the transcript list from its last row to its first, 15 rows every 0.15 s, the way a
        /// reader flicks up a long session. Each step realises the rows it passes, so their tool-change
        /// rows ask for their diffs; `GENESIS_HUB_BENCH_SCROLL_STEPS` sets the count (default 40).
        private func addTranscriptScroll() {
            order.append("scroll")
            let steps = ProcessInfo.processInfo.environment["GENESIS_HUB_BENCH_SCROLL_STEPS"].flatMap(Int.init) ?? 40
            var row: Int?
            for _ in 0..<steps {
                self.steps.append(Step(scenario: "scroll", action: { [weak self] in
                    guard let self, let table = HubBench.largestTable(in: self.window.contentView), table.numberOfRows > 0 else { return }
                    let next = max(0, (row ?? table.numberOfRows - 1) - 15)
                    row = next
                    table.scrollRowToVisible(next)
                }, delay: 0.15))
            }
        }

        /// The window's AppKit views by class at the end of the run, the 12 most common. Every NSView under
        /// SwiftUI is a platform responder, which SwiftUI walks on each accessibility focus update.
        private static func viewCensus(_ root: NSView?) -> [String: Any] {
            var counts: [String: Int] = [:]
            var total = 0
            func visit(_ view: NSView) {
                total += 1
                counts[String(describing: type(of: view)), default: 0] += 1
                view.subviews.forEach(visit)
            }
            if let root { visit(root) }
            let top = counts.sorted { $0.value > $1.value }.prefix(12).map { "\($0.value) \($0.key)" }
            return ["total": total, "top": top]
        }

        /// `open` (opt-in, sessions mode): up to three other recent sessions opened one after another, 5 s
        /// each. A transcript opens on its latest turns and fills the earlier ones in behind them. Every
        /// 50 ms the probe `transcript.fromBottom.<n>` records how far the viewport's end sits from the
        /// content's end (0: the latest turn in view); a reader at the latest turn should see it stay 0
        /// through the fill, and every flip after the first settle is a jump on screen.
        private func addTranscriptOpen() {
            let sessions = Array(model.sessions.filter { $0.id != model.selectedID }.prefix(3))
            order.append("open")
            PerfLog.mark("hub.bench open: \(sessions.map { $0.sessionId.prefix(8) }.joined(separator: " "))")
            for (n, session) in sessions.enumerated() {
                steps.append(Step(scenario: "open", action: { [weak self] in self?.model.select(session.id) }, delay: 0.05))
                for _ in 0..<100 {
                    steps.append(Step(scenario: "open", action: { [weak self] in
                        guard let self, let table = HubBench.largestTable(in: self.window.contentView), let clip = table.enclosingScrollView?.contentView else {
                            return
                        }
                        HubBench.note("transcript.fromBottom.\(n)", Int((table.frame.height - clip.bounds.maxY).rounded()))
                        HubBench.note("transcript.rows.\(n)", table.numberOfRows)
                    }, delay: 0.05))
                }
            }
        }


        private static func splitView(in view: NSView?) -> NSSplitView? {
            guard let view else { return nil }
            if let split = view as? NSSplitView { return split }
            for child in view.subviews {
                if let found = splitView(in: child) { return found }
            }
            return nil
        }

        // Main-thread awake time, from two run-loop observers: one that fires first after the loop
        // wakes, one that fires last before it sleeps (after SwiftUI's update and Core Animation's
        // commit). A wall-clock interval cannot tell work from a timer the OS postponed.
        private var observers: [CFRunLoopObserver] = []
        private var awakeSince: CFAbsoluteTime?
        private var awake: Double = 0
        private var wall: [String: [Double]] = [:]

        private func installObservers() {
            let wake = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.awakeSince = CFAbsoluteTimeGetCurrent() }
            }
            let sleep = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { [weak self] _, _ in
                MainActor.assumeIsolated {
                    guard let self, let since = self.awakeSince else { return }
                    self.awake += CFAbsoluteTimeGetCurrent() - since
                    self.awakeSince = nil
                }
            }
            for observer in [wake, sleep].compactMap({ $0 }) {
                CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
                observers.append(observer)
            }
        }

        private func tick() {
            if observers.isEmpty { installObservers() }
            let now = CFAbsoluteTimeGetCurrent()
            if let since = awakeSince {
                awake += now - since
                awakeSince = now
            }
            if let lastScenario {
                busy[lastScenario, default: []].append(awake * 1000)
                wall[lastScenario, default: []].append((now - lastStart) * 1000)
            }
            awake = 0
            guard index < steps.count else {
                finish(partial: false)
                return
            }
            let step = steps[index]
            index += 1
            lastScenario = step.scenario
            lastStart = CFAbsoluteTimeGetCurrent()
            step.action()
            DispatchQueue.main.asyncAfter(deadline: .now() + step.delay) { [weak self] in
                self?.tick()
            }
        }

        func finish(partial: Bool) {
            var scenarios: [[String: Any]] = []
            for name in order {
                let samples = busy[name] ?? []
                guard !samples.isEmpty else {
                    scenarios.append(["name": name, "steps": 0, "note": "skipped: nothing to resize"])
                    continue
                }
                let sorted = samples.sorted()
                func pct(_ p: Double) -> Double {
                    sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
                }
                let round1 = { (value: Double) in (value * 10).rounded() / 10 }
                scenarios.append([
                    "name": name,
                    "steps": samples.count,
                    "busyMs": [
                        "p50": round1(pct(0.5)), "p90": round1(pct(0.9)), "p95": round1(pct(0.95)),
                        "p99": round1(pct(0.99)), "max": round1(sorted.last ?? 0),
                        "mean": round1(samples.reduce(0, +) / Double(samples.count)),
                    ],
                    "framesOver16ms": samples.filter { $0 > 16.7 }.count,
                    "framesOver33ms": samples.filter { $0 > 33.3 }.count,
                    "wallMsMean": round1((wall[name] ?? []).reduce(0, +) / Double(max(1, wall[name]?.count ?? 0))),
                    // Click scenarios have a few steps; each one is worth reading, the first in particular.
                    "samplesMs": samples.count <= 24 ? samples.map(round1) : [],
                ])
            }
            var probeReport: [String: Any] = [:]
            for (label, values) in HubBench.probes {
                probeReport[label] = ["flips": max(0, values.count - 1), "values": Array(values.prefix(60))]
            }
            let report: [String: Any] = [
                "partial": partial,
                "stepsRun": index,
                "stepsPlanned": steps.count,
                "date": ISO8601DateFormatter().string(from: Date()),
                "session": model.selected?.sessionId ?? "",
                "panes": model.panes.map(\.rawValue),
                "window": ["width": Int(window.frame.width), "height": Int(window.frame.height)],
                "scenarios": scenarios,
                "probes": probeReport,
                "views": Self.viewCensus(window.contentView),
            ]
            if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                FileManager.default.createFile(atPath: output, contents: data)
            }
            PerfLog.mark("hub.bench done → \(output)")
            exit(0)
        }
    }
}


/// `GENESIS_HUB_BENCH_AX=1`: the bench is its own assistive client, the way dictation, a window manager
/// or `tools control` is one in a live session. It reads the whole accessibility tree through the AX
/// API (the path an outside app takes), then asks for the focused element every 0.5 s. From the first
/// read on, SwiftUI keeps accessibility nodes for the window and updates their focus after every
/// change, which a bench with no client never pays: the Activity filter click cost 90 ms of main
/// thread in a bench and about a second in the live hub, whose stall stacks were that focus update.
/// A call on the app's own pid is answered in the calling thread, and SwiftUI answers only on the
/// main thread, so the client runs there. Needs the Accessibility grant (a process started from a
/// trusted terminal has it).
@MainActor
enum HubBenchAccessibilityClient {
    private static var poll: Timer?

    /// Reads the tree and starts the focus poll; returns how many elements the read visited.
    static func start() -> Int {
        let app = AXUIElementCreateApplication(getpid())
        var count = 0
        func walk(_ element: AXUIElement, depth: Int) {
            guard depth > 0, count < 50_000 else { return }
            count += 1
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
                  let children = value as? [AXUIElement] else { return }
            for child in children {
                walk(child, depth: depth - 1)
            }
        }
        walk(app, depth: 40)
        poll = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            var focused: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused)
        }
        return count
    }
}

// MARK: - Snapshot focus

/// A `--snapshot` waits until the diff it shows has loaded (a PR's review is rebuilt once its
/// detail arrives), then opens `--file` when one was asked for, so the capture shows the lines
/// that carry the comments instead of the first file of the diff.
enum HubSnapshotFocus {
    @MainActor
    static func whenReady(review: @escaping @MainActor () -> ReviewModel?, file: String?, style: DiffViewOptions.Style? = nil,
                          deadline: Date = Date().addingTimeInterval(30), then done: @escaping () -> Void) {
        var stableSince: Date?
        func check() {
            let current = review()
            // A PR's diff also waits for its live threads, so the capture shows them on their lines.
            let ready = current.map { !$0.loading && !$0.files.isEmpty && ($0.pr?.settled ?? true) } ?? false
            if ready {
                stableSince = stableSince ?? Date()
            } else {
                stableSince = nil
            }
            // One second without a reload: a PR's scope change starts a second load right after the first.
            if let since = stableSince, Date().timeIntervalSince(since) >= 1, let current {
                if let style { current.setStyle(style) }
                if let file, let match = current.files.first(where: { $0.path == file || $0.path.hasSuffix("/" + file) }) {
                    current.showsOneFile = true
                    current.select(match.id)
                    current.sidebarScrollTarget = match.id
                }
                done()
                return
            }
            guard Date() < deadline else {
                FileHandle.standardError.write(Data("hub snapshot: the diff did not settle; capturing as is\n".utf8))
                done()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { MainActor.assumeIsolated { check() } }
        }
        check()
    }
}
