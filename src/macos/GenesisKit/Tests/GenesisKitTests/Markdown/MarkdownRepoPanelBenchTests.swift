import AppKit
import Combine
import Darwin
@testable import GenesisKit
import SwiftUI
import Vision
import XCTest

/// The git sidebar's Repository tab as Martin has it (2026-10-25, "so laggy"): the viewer's real window content with
/// the vault's notes as tabs, the file tree, and the git sidebar 560 pt wide on the Repository tab. Each step records
/// the main thread's CPU time from the action until the main thread (and, for work that hops off it, the whole
/// process) is quiet again, the run loop's busy time and longest pass (`MainBusy.Meter`), and the bodies and publishes
/// that ran (`RenderProbe`). Real notes and the repository are only read: git runs with `--no-optional-locks`.
///
///   MARKDOWN_REPO_BENCH=<repository or vault folder> swift test --filter MarkdownRepoPanelBench
///
/// Options: MARKDOWN_REPO_BENCH_TABS (39) or MARKDOWN_REPO_BENCH_TAB_LIST=<file of note paths, the last selected>;
/// MARKDOWN_REPO_BENCH_OUT=<jsonl> (one line per step, appended; a summary over every run in the file is written
/// beside it as <out>.summary.md); MARKDOWN_REPO_BENCH_LABEL (before / after; default "run"); MARKDOWN_REPO_BENCH_PHASES
/// (comma list, default all: floor,open,publish,tabs,filter,sort,refresh,scroll,fold,offmain);
/// MARKDOWN_REPO_BENCH_SAMPLE=<path> runs `/usr/bin/sample` on this process while MARKDOWN_REPO_BENCH_SAMPLE_PHASE
/// (publish) repeats for MARKDOWN_REPO_BENCH_SAMPLE_SECS (8); MARKDOWN_REPO_BENCH_QUERY (analy), _SHOW_MORE (5 pages),
/// _WIDTH / _HEIGHT (2056 x 1290), _GIT_WIDTH (560), _FILES_WIDTH (346), _FILES=0 (no file tree), _WRAP=0, _OPENS (5),
/// _REFRESHES (3), _DEBUG=1 (print what the fold phase reads while it looks for a row).
///
/// The window is hosted at alpha 0 below the desktop, like `MarkdownTreeLagBenchTests`: SwiftUI evaluates and lays
/// out everything, but nothing is drawn, the window is never key and no accessibility client watches it, so the
/// numbers leave out drawing and focus/accessibility upkeep. The fold phase reads the sidebar's picture to find a
/// folder row and its "Show more" button and posts clicks at them; it runs last.
final class MarkdownRepoPanelBenchTests: XCTestCase {
    @MainActor
    func testRepositoryPanelCost() throws {
        let env = ProcessInfo.processInfo.environment
        guard let rootPath = env["MARKDOWN_REPO_BENCH"] else {
            throw XCTSkip("set MARKDOWN_REPO_BENCH to a repository folder (the notes vault reproduces the report)")
        }
        let bench = try RepoPanelBench(env: env, root: URL(fileURLWithPath: rootPath))
        let tab = UserDefaults.standard.object(forKey: RepoPanelBench.tabKey)
        let order = UserDefaults.standard.object(forKey: RepoPanelBench.orderKey)
        let untracked = UserDefaults.standard.object(forKey: RepoPanelBench.untrackedKey)
        defer {
            // The sidebar tab and the panel's order are @AppStorage in the process's defaults: put back what was there.
            for (key, value) in [(RepoPanelBench.tabKey, tab), (RepoPanelBench.orderKey, order), (RepoPanelBench.untrackedKey, untracked)] {
                if let value { UserDefaults.standard.set(value, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
            }
        }
        try bench.run()
    }

    /// Nearest-rank percentiles over the measured steps.
    func testPercentile() {
        XCTAssertEqual(RepoPanelBench.percentile([], 0.5), 0)
        XCTAssertEqual(RepoPanelBench.percentile([5], 0.95), 5)
        XCTAssertEqual(RepoPanelBench.percentile([4, 1, 3, 2], 0.5), 2)
        XCTAssertEqual(RepoPanelBench.percentile(Array(1...20).map(Double.init), 0.95), 19)
    }
}

/// One run of the repository panel bench: a window, its phases, the records.
@MainActor
final class RepoPanelBench {
    static let tabKey = "markdown.config.gitSidebarTab"
    static let orderKey = "genesiskit.gitRepoPanel.order"
    static let untrackedKey = "genesiskit.gitRepoPanel.untracked"

    struct Settle {
        /// Wait until the whole process is quiet too: derived lists and file dates are built off the main thread.
        var processQuiet = false
        var quietSlices = 4
        var minSeconds: TimeInterval = 0
        var cap: TimeInterval = 5
        var until: (() -> Bool)?
        var trackHeight = false
    }

    let env: [String: String]
    let root: URL
    let label: String
    let runID = String(UUID().uuidString.prefix(8))
    let phases: Set<String>
    private var model: MarkdownDocumentsModel!
    private var window: NSWindow!
    private var repo: GitRepoModel!
    private var watches: [AnyCancellable] = []
    private var idleProcessMsPerMs = 0.0
    private var steps: [String: [[String: Any]]] = [:]
    private var phaseOrder: [String] = []

    init(env: [String: String], root: URL) throws {
        self.env = env
        self.root = root
        label = env["MARKDOWN_REPO_BENCH_LABEL"] ?? "run"
        let all = "floor,open,publish,tabs,filter,sort,refresh,scroll,fold,offmain"
        phases = Set((env["MARKDOWN_REPO_BENCH_PHASES"] ?? all).split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) })
    }

    private func int(_ key: String, _ fallback: Int) -> Int { Int(env[key] ?? "") ?? fallback }
    private func double(_ key: String, _ fallback: Double) -> Double { Double(env[key] ?? "") ?? fallback }

    // MARK: Clocks

    static func threadCpuMs() -> Double { Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1e6 }

    static func processCpuMs(_ who: Int32 = RUSAGE_SELF) -> Double {
        var usage = rusage()
        getrusage(who, &usage)
        func ms(_ t: timeval) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_usec) / 1000 }
        return ms(usage.ru_utime) + ms(usage.ru_stime)
    }

    static func load1() -> Double {
        var loads = [Double](repeating: 0, count: 3)
        return getloadavg(&loads, 3) > 0 ? loads[0] : -1
    }

    nonisolated static func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let rank = Int((p * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank, 1), sorted.count) - 1]
    }

    // MARK: Run

    func run() throws {
        let loadBefore = Self.load1()
        try makeWindow()
        print("repo bench: \(model.docs.count) tabs, repository \(repo.root.path), \(repo.status?.entries.count ?? 0) status entries, load \(loadBefore)")
        RenderProbe.enabled = true
        defer { RenderProbe.enabled = false }
        watches = [
            RenderProbe.watch(model, "docs"), RenderProbe.watch(repo, "repo"), RenderProbe.watch(GitRepos.shared, "repos"),
            RenderProbe.watch(model.configuration, "config"),
        ].compactMap { $0 }
        if phases.contains("floor") { floor() }
        if phases.contains("open") { open() } else { showRepositoryTab() }
        if phases.contains("publish") { publish() }
        if phases.contains("tabs") { tabs() }
        if phases.contains("filter") { try filter() }
        if phases.contains("sort") { sort() }
        if phases.contains("refresh") { refresh() }
        if phases.contains("scroll") { scroll("scroll") }
        if phases.contains("fold") { try fold() }
        if phases.contains("offmain") { try offMain() }
        if let path = env["MARKDOWN_REPO_BENCH_SAMPLE"] { try sample(to: path) }
        watches.removeAll()
        window.orderOut(nil)
        window.close()
        try report(loadBefore: loadBefore, loadAfter: Self.load1())
    }

    private func notes() throws -> [URL] {
        if let list = env["MARKDOWN_REPO_BENCH_TAB_LIST"] {
            let paths = try String(contentsOfFile: list, encoding: .utf8).split(separator: "\n").map(String.init).filter { !$0.isEmpty }
            let found = paths.map { URL(fileURLWithPath: $0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
            if !found.isEmpty { return found }
        }
        let limit = int("MARKDOWN_REPO_BENCH_TABS", 39)
        var found: [URL] = []
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants])
        while let url = walker?.nextObject() as? URL, found.count < limit {
            if url.pathExtension == "md" { found.append(url) }
        }
        if found.isEmpty { throw XCTSkip("no markdown notes under \(root.path)") }
        return found
    }

    private func makeWindow() throws {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-repo-bench-\(UUID().uuidString)")!)
        // A configuration of its own: the shared one writes the test process's defaults, which other tests read.
        model.configuration = GenesisKitMarkdownConfiguration(defaults: UserDefaults(suiteName: "md-repo-bench-config-\(UUID().uuidString)")!)
        model.configuration.wrapTabs = env["MARKDOWN_REPO_BENCH_WRAP"] != "0"
        model.filesRoot = root.path
        model.showFiles = env["MARKDOWN_REPO_BENCH_FILES"] != "0"
        model.filesWidth = double("MARKDOWN_REPO_BENCH_FILES_WIDTH", 346)
        model.showGit = true
        model.gitWidth = double("MARKDOWN_REPO_BENCH_GIT_WIDTH", 560)
        UserDefaults.standard.set("file", forKey: Self.tabKey)
        UserDefaults.standard.set(GitChangeOrder.lastUpdate.rawValue, forKey: Self.orderKey)
        UserDefaults.standard.set(true, forKey: Self.untrackedKey)
        model.open(try notes())
        self.model = model
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: double("MARKDOWN_REPO_BENCH_WIDTH", 2056), height: double("MARKDOWN_REPO_BENCH_HEIGHT", 1290)),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        self.window = window
        slices(3)
        // The repository and its first status: the lookup and the read run off the main thread.
        let folder = try XCTUnwrap(model.selected).url.deletingLastPathComponent()
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            if let found = GitRepos.shared.lookup(for: folder).model, found.status != nil {
                repo = found
                break
            }
            slices(0.1)
        }
        guard repo != nil else { throw XCTSkip("no git status for \(folder.path) within 90 s") }
        idleProcessMsPerMs = measureIdleRate()
    }

    private func slice(_ seconds: TimeInterval = 0.016) {
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func slices(_ seconds: TimeInterval) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { slice() }
    }

    /// Settles until the process is quiet, then the process's own CPU per ms at rest (web content, the tree's watcher).
    private func measureIdleRate() -> Double {
        var quiet = 0
        let deadline = Date().addingTimeInterval(30)
        while quiet < 5, Date() < deadline {
            let p0 = Self.processCpuMs()
            slices(0.2)
            quiet = Self.processCpuMs() - p0 < 10 ? quiet + 1 : 0
        }
        let p0 = Self.processCpuMs(), t0 = CFAbsoluteTimeGetCurrent()
        slices(1)
        return (Self.processCpuMs() - p0) / ((CFAbsoluteTimeGetCurrent() - t0) * 1000)
    }

    // MARK: Measuring one step

    @discardableResult
    private func measure(_ phase: String, step: Int, _ settle: Settle = Settle(), extra: [String: Any] = [:], action: () -> Void) -> [String: Any] {
        let bodies = RenderProbe.snapshot()
        let meter = MainBusy.Meter()
        let t0 = CFAbsoluteTimeGetCurrent(), c0 = Self.threadCpuMs(), p0 = Self.processCpuMs()
        meter.start()
        action()
        var lastMain = Self.threadCpuMs(), lastProcess = Self.processCpuMs(), lastTick = CFAbsoluteTimeGetCurrent()
        var quiet = 0
        var settledAt = t0
        var heights: [(Double, CGFloat)] = []
        var capped = false
        while true {
            slice()
            let now = CFAbsoluteTimeGetCurrent(), main = Self.threadCpuMs(), process = Self.processCpuMs()
            let mainQuiet = main - lastMain < 1.5
            let processQuiet = !settle.processQuiet || process - lastProcess < idleProcessMsPerMs * (now - lastTick) * 1000 + 2
            lastMain = main
            lastProcess = process
            lastTick = now
            if settle.trackHeight, let height = sidebarScroll()?.documentView?.frame.height { heights.append(((now - t0) * 1000, height)) }
            if mainQuiet && processQuiet { quiet += 1 } else { quiet = 0; settledAt = now }
            if quiet >= settle.quietSlices, now - t0 >= settle.minSeconds, settle.until?() ?? true { break }
            if now - t0 > settle.cap {
                capped = true
                break
            }
        }
        let reading = meter.stop()
        let ran = RenderProbe.snapshot().compactMapValues { $0 }.reduce(into: [String: Int]()) { result, pair in
            let delta = pair.value - (bodies[pair.key] ?? 0)
            if delta > 0 { result[pair.key] = delta }
        }
        var record: [String: Any] = [
            "label": label, "run": runID, "repo": root.lastPathComponent, "tabs": model.docs.count, "phase": phase, "step": step,
            "mainCpuMs": Self.threadCpuMs() - c0, "busyMs": reading.busyMs, "longestMs": reading.longestMs, "passes": reading.passes,
            "settledMs": (settledAt - t0) * 1000, "wallMs": (CFAbsoluteTimeGetCurrent() - t0) * 1000,
            "processCpuMs": Self.processCpuMs() - p0, "bodies": ran, "capped": capped, "load1": Self.load1(),
            "sidebarHeight": Double(sidebarScroll()?.documentView?.frame.height ?? 0),
        ]
        if let final = heights.last?.1, let first = heights.first?.1, final > first + 44 {
            record["firstRowsMs"] = heights.first { $0.1 >= first + (final - first) * 0.9 }?.0
        }
        record.merge(extra) { $1 }
        append(record)
        return record
    }

    private func append(_ record: [String: Any]) {
        let phase = record["phase"] as? String ?? "?"
        if steps[phase] == nil { phaseOrder.append(phase) }
        steps[phase, default: []].append(record)
        guard let out = env["MARKDOWN_REPO_BENCH_OUT"],
              let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        if !FileManager.default.fileExists(atPath: out) { FileManager.default.createFile(atPath: out, contents: nil) }
        if let handle = FileHandle(forWritingAtPath: out) {
            handle.seekToEndOfFile()
            handle.write(data + Data("\n".utf8))
            try? handle.close()
        }
    }

    // MARK: Finding the panel

    /// The git sidebar's scroll view: the tallest one whose middle lies in the sidebar's column.
    private func sidebarScroll() -> NSScrollView? {
        guard let content = window.contentView else { return nil }
        let left = window.frame.width - CGFloat(model.gitWidth) - 4
        var found: [NSScrollView] = []
        func walk(_ view: NSView) {
            if let scroll = view as? NSScrollView, scroll.convert(scroll.bounds, to: nil).midX > left { found.append(scroll) }
            view.subviews.forEach(walk)
        }
        walk(content)
        return found.max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
    }

    private func filterField() -> NSTextField? {
        guard let content = window.contentView else { return nil }
        var found: NSTextField?
        func walk(_ view: NSView) {
            if found == nil, let field = view as? NSTextField, field.isEditable, field.placeholderString == "Filter" { found = field }
            view.subviews.forEach(walk)
        }
        walk(content)
        return found
    }

    private func scrollTo(_ y: CGFloat) {
        guard let scroll = sidebarScroll() else { return }
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, y)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func showRepositoryTab() {
        UserDefaults.standard.set("repo", forKey: Self.tabKey)
        _ = measure("setup", step: 0, Settle(processQuiet: true, cap: 20)) {}
    }

    /// Slices until the process has been quiet for a quarter second (cap 20 s); records nothing.
    private func settleQuiet(cap: TimeInterval = 20) {
        var quiet = 0
        let deadline = Date().addingTimeInterval(cap)
        while quiet < 5, Date() < deadline {
            let p0 = Self.processCpuMs(), t0 = CFAbsoluteTimeGetCurrent()
            slices(0.05)
            let allowed = idleProcessMsPerMs * (CFAbsoluteTimeGetCurrent() - t0) * 1000 + 3
            quiet = Self.processCpuMs() - p0 < allowed ? quiet + 1 : 0
        }
    }

    // MARK: Phases

    /// The cost of measuring nothing: the settle loop's own floor.
    private func floor() {
        for step in 0..<5 { measure("floor", step: step) {} }
    }

    /// Switching the sidebar to Repository builds the panel from nothing: its file dates and its lists.
    private func open() {
        for step in 0..<int("MARKDOWN_REPO_BENCH_OPENS", 5) {
            UserDefaults.standard.set("file", forKey: Self.tabKey)
            settleQuiet()
            measure("open", step: step, Settle(processQuiet: true, cap: 20, trackHeight: true)) {
                UserDefaults.standard.set("repo", forKey: Self.tabKey)
            }
        }
    }

    /// What a heading report, a dirty flag or any other unrelated model change costs while the panel shows.
    private func publish() {
        settleQuiet()
        for step in 0..<20 { measure("publish", step: step) { model.objectWillChange.send() } }
    }

    private func tabs() {
        settleQuiet()
        guard let plan = MarkdownTreeLagBenchTests.alternatingSelection(ids: model.docs.suffix(2).map(\.id), selections: 10) else {
            print("repo bench: tab switches skipped, fewer than two tabs")
            return
        }
        for (step, id) in plan.enumerated() { measure("tabs", step: step, Settle(cap: 4)) { model.select(id) } }
        // Back on the tab the run started with.
        model.select(plan.count % 2 == 0 ? plan[0] : plan[1])
        model.select(model.docs.last?.id)
        settleQuiet()
    }

    /// A query typed one key at a time (each key measured for at least 150 ms, a typist's pace), then cleared.
    private func filter() throws {
        guard let field = filterField() else {
            print("repo bench: filter skipped, no Filter field in the panel")
            return
        }
        let query = env["MARKDOWN_REPO_BENCH_QUERY"] ?? "analy"
        for round in 0..<2 {
            settleQuiet()
            window.makeFirstResponder(field)
            guard let editor = field.currentEditor() as? NSTextView else {
                print("repo bench: filter skipped, the field took no editor")
                return
            }
            for (index, character) in query.enumerated() {
                measure("filter.key", step: round * query.count + index, Settle(processQuiet: true, minSeconds: 0.15, cap: 5)) {
                    editor.insertText(String(character), replacementRange: NSRange(location: NSNotFound, length: 0))
                }
            }
            measure("filter.clear", step: round, Settle(processQuiet: true, cap: 5)) {
                editor.selectAll(nil)
                editor.deleteBackward(nil)
            }
            window.makeFirstResponder(nil)
        }
    }

    /// The sort button's four orders, twice round.
    private func sort() {
        settleQuiet()
        let orders: [GitChangeOrder] = [.name, .folder, .kind, .lastUpdate]
        for step in 0..<8 {
            let order = orders[step % orders.count]
            measure("sort", step: step, Settle(processQuiet: true, cap: 10), extra: ["order": order.rawValue]) {
                UserDefaults.standard.set(order.rawValue, forKey: Self.orderKey)
            }
        }
    }

    /// What every event in the git folder does: a status read, a new generation (the status itself unchanged), the
    /// panel's dates and lists again.
    private func refresh() {
        settleQuiet()
        for step in 0..<int("MARKDOWN_REPO_BENCH_REFRESHES", 3) {
            let generation = repo.generation
            measure("refresh", step: step, Settle(processQuiet: true, cap: 60, until: { self.repo.generation > generation })) {
                repo.refresh()
            }
        }
    }

    /// The panel scrolled 45 pt at a time to its end and back to the top.
    private func scroll(_ phase: String) {
        scrollTo(0)
        settleQuiet()
        guard let scroll = sidebarScroll() else {
            print("repo bench: \(phase) skipped, no sidebar scroll view")
            return
        }
        var y: CGFloat = 0
        var step = 0
        func bottom() -> CGFloat { max(0, (scroll.documentView?.frame.height ?? 0) - scroll.contentView.bounds.height) }
        while y < bottom(), step < 800 {
            y = min(y + 45, bottom())
            let target = y
            measure(phase, step: step, Settle(quietSlices: 2, cap: 2), extra: ["y": Double(target), "down": true]) { scrollTo(target) }
            step += 1
        }
        while y > 0, step < 1600 {
            y = max(0, y - 45)
            let target = y
            measure(phase, step: step, Settle(quietSlices: 2, cap: 2), extra: ["y": Double(target), "down": false]) { scrollTo(target) }
            step += 1
        }
        print("repo bench: \(phase) \(step) steps over \(Int(scroll.documentView?.frame.height ?? 0)) pt")
    }

    /// The largest untracked folder opened, several "Show more" pages, a scroll through the long list, and the folder
    /// closed and opened again with its pages kept. Ordered by kind, so the largest folder is the first folder row.
    /// SwiftUI builds no accessibility tree without a client, so the rows are found by reading the sidebar's picture
    /// (Vision) and clicked with posted mouse events, outside the measured window.
    private func fold() throws {
        guard let entries = repo.status?.entries,
              let largest = GitChangeList.foldUntracked(entries).groups.max(by: { $0.files.count < $1.files.count }) else {
            print("repo bench: fold skipped, no untracked folder")
            return
        }
        UserDefaults.standard.set(GitChangeOrder.kind.rawValue, forKey: Self.orderKey)
        settleQuiet()
        let name = (largest.folder as NSString).lastPathComponent + "/"
        // The row reads "<chevron> <folder icon> PHP/ Dev 2686 files": the name is one word of the line.
        let isFolderRow: (String) -> Bool = { $0.split(separator: " ").contains { $0 == name } }
        // A first click on the branch name, which does nothing: the window's first click may only wake it.
        if let branch = findText({ $0.contains(repo.status?.branch ?? "\u{0}") }) { click(branch.point) }
        guard let row = findText(isFolderRow) else {
            print("repo bench: fold skipped, the folder row \(largest.folder) was not found in the sidebar")
            if let scroll = sidebarScroll() {
                scrollTo(0)
                settleQuiet(cap: 3)
                print("repo bench: the sidebar reads: " + textLines(in: scroll).map(\.text).joined(separator: " | "))
            }
            return
        }
        measure("fold.open", step: 0, Settle(processQuiet: true, cap: 10), extra: ["files": largest.files.count]) { click(row.point) }
        let pages = int("MARKDOWN_REPO_BENCH_SHOW_MORE", 5)
        var rows = GitRepoPanel.page
        for page in 0..<pages {
            let remaining = largest.files.count - rows
            guard remaining > 0, let more = findText({ $0.contains("Show") && $0.contains("more of \(remaining)") }, from: row.y) else {
                print("repo bench: no Show more button for \(remaining) remaining rows")
                break
            }
            rows += GitRepoPanel.page
            measure("fold.showMore", step: page, Settle(processQuiet: true, cap: 10), extra: ["rows": min(rows, largest.files.count)]) {
                click(more.point)
            }
        }
        scroll("scroll.expanded")
        for step in 0..<3 {
            for phase in ["fold.close", "fold.open"] {
                guard let row = findText(isFolderRow) else { break }
                measure(phase, step: step + (phase == "fold.open" ? 1 : 0), Settle(processQuiet: true, cap: 10),
                        extra: ["files": largest.files.count, "rows": min(rows, largest.files.count)]) { click(row.point) }
            }
        }
        UserDefaults.standard.set(GitChangeOrder.lastUpdate.rawValue, forKey: Self.orderKey)
        settleQuiet()
    }

    /// The first text line in the sidebar that matches, scrolling down from `from` until one is in view (a lazy row
    /// exists only on screen): its middle in window coordinates and the scroll offset it was found at.
    private func findText(_ match: (String) -> Bool, from: CGFloat = 0) -> (point: NSPoint, y: CGFloat)? {
        guard let scroll = sidebarScroll() else { return nil }
        var y = from
        while true {
            scrollTo(y)
            settleQuiet(cap: 3)
            let lines = textLines(in: scroll)
            if let point = lines.filter({ match($0.text) }).max(by: { $0.point.y < $1.point.y })?.point {
                return (point, y)
            }
            if env["MARKDOWN_REPO_BENCH_DEBUG"] == "1" {
                print("repo bench: at \(Int(y)) of \(Int(scroll.documentView?.frame.height ?? 0)): " + lines.map(\.text).filter { $0.contains("ore") || $0.contains("/") && !$0.contains(".") }.joined(separator: " | "))
            }
            let bottom = (scroll.documentView?.frame.height ?? 0) - scroll.contentView.bounds.height
            if y >= bottom { return nil }
            y = min(y + scroll.contentView.bounds.height * 0.8, bottom)
        }
    }

    /// The text lines Vision reads in the scroll view's visible part, each with its middle in window coordinates.
    private func textLines(in scroll: NSScrollView) -> [(text: String, point: NSPoint)] {
        guard let content = window.contentView else { return [] }
        let rect = content.convert(scroll.bounds, from: scroll).integral
        guard let bitmap = content.bitmapImageRepForCachingDisplay(in: rect) else { return [] }
        content.cacheDisplay(in: rect, to: bitmap)
        guard let image = bitmap.cgImage else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string else { return nil }
            let box = observation.boundingBox
            // Vision's box is normalised with its origin at the bottom left, as the content view's own coordinates.
            let inContent = NSPoint(x: rect.minX + box.midX * rect.width, y: rect.minY + box.midY * rect.height)
            let local = content.isFlipped ? NSPoint(x: inContent.x, y: rect.maxY - box.midY * rect.height) : inContent
            return (text, content.convert(local, to: nil))
        }
    }

    /// A click as the reader makes it, handed to this window now. A posted event (`NSApp.postEvent`, then
    /// `nextEvent`) landed at the mirrored height in this window and opened a file row instead; `sendEvent` hits the
    /// point. The test hooks keep the window from taking focus.
    private func click(_ point: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
            window.sendEvent(event)
        }
    }

    // MARK: Off the main thread

    /// The work the panel hands to other threads, run here on the test thread one piece at a time: the status read
    /// (git's own CPU is the child's), its parse, the file dates, the derived lists per order, the tree's marks.
    private func offMain() throws {
        settleQuiet()
        let provider = GenesisKitGT.provider
        let repoRoot = repo.root
        func time(_ phase: String, step: Int, extra: [String: Any] = [:], _ work: () throws -> Void) rethrows {
            let t0 = CFAbsoluteTimeGetCurrent(), c0 = Self.threadCpuMs(), k0 = Self.processCpuMs(RUSAGE_CHILDREN)
            try work()
            var record: [String: Any] = [
                "label": label, "run": runID, "repo": root.lastPathComponent, "tabs": model.docs.count, "phase": phase, "step": step,
                "cpuMs": Self.threadCpuMs() - c0, "childCpuMs": Self.processCpuMs(RUSAGE_CHILDREN) - k0,
                "wallMs": (CFAbsoluteTimeGetCurrent() - t0) * 1000, "load1": Self.load1(),
            ]
            record.merge(extra) { $1 }
            append(record)
        }
        var status: GitRepoStatus?
        for step in 0..<3 {
            try time("off.repoStatus", step: step) { status = try provider.repoStatus(repoRoot, commits: 0) }
        }
        guard let status else { return }
        let entries = status.entries
        let raw = try provider.git(["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
                                   in: repoRoot, input: nil, gitDirectory: nil, environment: nil)
        let text = String(decoding: raw.stdout, as: UTF8.self)
        for step in 0..<3 { time("off.parseStatus", step: step, extra: ["bytes": raw.stdout.count]) { _ = GitQueries.parseStatus(text) } }
        let other = try provider.repoStatus(repoRoot, commits: 0)
        for step in 0..<3 { time("off.statusEquality", step: step) { _ = status == other } }
        let reader = GitChangeDates().readDates
        var dates: [String: Date] = [:]
        for step in 0..<3 { time("off.readDates", step: step, extra: ["paths": entries.count]) { dates = reader(repoRoot, entries.map(\.path)) } }
        var step = 0
        for order in GitChangeOrder.allCases {
            for filter in ["", env["MARKDOWN_REPO_BENCH_QUERY"] ?? "analy"] {
                let inputs = GitRepoPanelLists.Inputs(root: repoRoot, generation: 0, datesVersion: 0, order: order, filter: filter, untracked: true)
                time("off.derive", step: step, extra: ["order": order.rawValue, "filter": filter]) {
                    _ = GitRepoPanelLists.derive(entries, dates: dates, inputs: inputs)
                }
                step += 1
            }
        }
        for step in 0..<2 { time("off.treeMarks", step: step) { _ = status.decorations(under: root) } }
        for step in 0..<2 { time("off.numstat", step: step) { _ = GitQueries(provider: provider).numstat(in: repoRoot) } }
    }

    // MARK: Sampling

    /// `/usr/bin/sample` on this process while one phase repeats, so the main thread's frames can be ranked.
    private func sample(to path: String) throws {
        let phase = env["MARKDOWN_REPO_BENCH_SAMPLE_PHASE"] ?? "publish"
        let seconds = int("MARKDOWN_REPO_BENCH_SAMPLE_SECS", 8)
        UserDefaults.standard.set("repo", forKey: Self.tabKey)
        settleQuiet()
        let sampler = Process()
        sampler.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
        sampler.arguments = [String(getpid()), String(seconds), "-file", path]
        sampler.standardOutput = FileHandle.nullDevice
        sampler.standardError = FileHandle.nullDevice
        try sampler.run()
        slices(0.5)
        let ids = model.docs.suffix(2).map(\.id)
        let orders: [GitChangeOrder] = [.name, .folder, .kind, .lastUpdate]
        var step = 0
        var y: CGFloat = 0
        var down = true
        while sampler.isRunning {
            let name = "sample." + phase
            switch phase {
            case "open":
                UserDefaults.standard.set("file", forKey: Self.tabKey)
                slices(0.1)
                measure(name, step: step, Settle(processQuiet: true, cap: 20)) { UserDefaults.standard.set("repo", forKey: Self.tabKey) }
            case "tabs" where ids.count == 2:
                measure(name, step: step, Settle(cap: 4)) { model.select(ids[step % 2]) }
            case "refresh":
                let generation = repo.generation
                measure(name, step: step, Settle(processQuiet: true, cap: 60, until: { self.repo.generation > generation })) { repo.refresh() }
            case "sort":
                let order = orders[step % orders.count]
                measure(name, step: step, Settle(processQuiet: true, cap: 10)) { UserDefaults.standard.set(order.rawValue, forKey: Self.orderKey) }
            case "scroll":
                let bottom = max(0, (sidebarScroll()?.documentView?.frame.height ?? 0) - (sidebarScroll()?.contentView.bounds.height ?? 0))
                if y >= bottom { down = false } else if y <= 0 { down = true }
                y = down ? min(y + 45, bottom) : max(0, y - 45)
                let target = y
                measure(name, step: step, Settle(quietSlices: 2, cap: 2)) { scrollTo(target) }
            default:
                measure(name, step: step) { model.objectWillChange.send() }
            }
            step += 1
        }
        sampler.waitUntilExit()
        UserDefaults.standard.set(GitChangeOrder.lastUpdate.rawValue, forKey: Self.orderKey)
        print("repo bench: sampled \(phase) for \(seconds) s (\(step) steps) into \(path)")
    }

    // MARK: Report

    private func report(loadBefore: Double, loadAfter: Double) throws {
        var lines = ["repo bench \(label) \(runID): \(model.docs.count) tabs, \(repo.status?.entries.count ?? 0) entries, load \(loadBefore) -> \(loadAfter)"]
        lines += Self.table(phaseOrder.compactMap { phase in steps[phase].map { (phase, $0) } })
        print(lines.joined(separator: "\n"))
        guard let out = env["MARKDOWN_REPO_BENCH_OUT"] else { return }
        // Every run in the file, grouped by label, repository and phase.
        let all = try String(contentsOfFile: out, encoding: .utf8).split(separator: "\n").compactMap { line in
            (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
        }
        var groups: [String: [[String: Any]]] = [:]
        var order: [String] = []
        for record in all {
            let key = "\(record["label"] ?? "?") \(record["repo"] ?? "?") \(record["phase"] ?? "?")"
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(record)
        }
        let runs = Set(all.compactMap { $0["run"] as? String }).count
        let summary = ["# Repository panel bench summary", "", "\(all.count) steps from \(runs) runs in \(out).", ""]
            + Self.table(order.compactMap { key in groups[key].map { (key, $0) } })
        try summary.joined(separator: "\n").write(toFile: out + ".summary.md", atomically: true, encoding: .utf8)
    }

    /// One markdown row per group: median / p95 / max of the CPU, busy and longest-pass ms, the settle and first-rows
    /// medians, and the median body and publish counts per step.
    nonisolated static func table(_ groups: [(String, [[String: Any]])]) -> [String] {
        func values(_ records: [[String: Any]], _ key: String) -> [Double] { records.compactMap { ($0[key] as? NSNumber)?.doubleValue } }
        func stat(_ v: [Double]) -> String {
            v.isEmpty ? "-" : String(format: "%.1f / %.1f / %.1f", percentile(v, 0.5), percentile(v, 0.95), v.max() ?? 0)
        }
        func median(_ v: [Double]) -> String { v.isEmpty ? "-" : String(format: "%.0f", percentile(v, 0.5)) }
        func count(_ records: [[String: Any]], _ name: String) -> [Double] {
            records.map { (($0["bodies"] as? [String: Any])?[name] as? NSNumber)?.doubleValue ?? 0 }
        }
        var rows = [
            "| group | n | cpu ms (med / p95 / max) | busy ms | longest pass ms | settled ms | first rows ms | git.repoPanel | md.gitSidebar | all bodies | publish.docs | publish.repo | wall ms | child cpu ms |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        ]
        for (name, records) in groups {
            let cpu = values(records, "mainCpuMs").isEmpty ? values(records, "cpuMs") : values(records, "mainCpuMs")
            let all = records.map { (($0["bodies"] as? [String: Any]) ?? [:]).filter { !$0.key.hasPrefix("publish.") }.values
                .compactMap { ($0 as? NSNumber)?.doubleValue }.reduce(0, +) }
            rows.append("| \(name) | \(records.count) | \(stat(cpu)) | \(stat(values(records, "busyMs"))) | \(stat(values(records, "longestMs"))) | "
                + "\(median(values(records, "settledMs"))) | \(median(values(records, "firstRowsMs"))) | \(median(count(records, "git.repoPanel"))) | "
                + "\(median(count(records, "md.gitSidebar"))) | \(median(all)) | \(median(count(records, "publish.docs"))) | "
                + "\(median(count(records, "publish.repo"))) | \(median(values(records, "wallMs"))) | \(median(values(records, "childCpuMs"))) |")
        }
        return rows
    }
}
