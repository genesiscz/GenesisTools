// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/SessionTranscriptScrollTests.swift at 2026-09-25T23:59:22+02:00 at commit hash 390e9f2d2faf35c9dc24ea585b796b2ebea45dc1
import AppKit
import SwiftUI
import XCTest
// GenesisTools adaptation: this app's module, which holds the kit types too.
@testable import GenesisTools

/// Scrolling the Session Details transcript, driven in a window nobody sees.
///
/// Martin, 2026-09-25: scrolling the transcript of a running session at "Inputs + output" stuttered.
/// The window here is real, because a `List` realises rows only in a window that is ordered in, but
/// it never shows: alpha 0, below the desktop, ignores the mouse, and the app is never activated, so
/// a run takes focus from no one. Wheel events go through the app's event queue and
/// `NSApp.sendEvent`, the way `NSApp.run` delivers them.
///
/// - The behaviour tests always run: a vertical wheel gesture over a tool output scrolls the
///   transcript, and a horizontal one scrolls the output sideways and leaves the transcript alone.
///   GenesisTools adaptation: and a click opens a tool call to its whole output, also one that
///   arrived while the transcript was on screen.
/// - `testScrollCost` prints what scrolling costs (`SCROLLPERF` lines: main-thread CPU per frame and
///   how many row bodies ran) and runs only with `SESSION_SCROLL_PERF=1`. `SESSION_SCROLL_SECTIONS`
///   sizes the invented session (40 prompts by default); `SESSION_SCROLL_ENVELOPE=<tools ai sessions
///   tail --json output>` measures a real one instead, with its session file for the full results.
@MainActor
final class SessionTranscriptScrollTests: XCTestCase {
    // MARK: Behaviour

    func testVerticalWheelOverAToolOutputScrollsTheTranscript() throws {
        let session = try InventedSession.make(sections: 6)
        let rig = Rig(session.list(), size: NSSize(width: 900, height: 700))
        defer { rig.close() }
        rig.settle(1.5)
        let list = try XCTUnwrap(rig.transcript, "no transcript scroll view")
        rig.scrollTranscript(to: (list.documentView?.frame.height ?? 0) / 2)
        rig.settle(0.6)

        // A mouse wheel: every notch over a tool output scrolls the transcript.
        var block = try XCTUnwrap(rig.visibleCodeBlocks().first, "no tool output on screen")
        var before = list.contentView.bounds.origin.y
        rig.notches(at: rig.center(of: block), dx: 0, dy: -3, count: 4)
        rig.settle(0.3)
        XCTAssertGreaterThan(abs(list.contentView.bounds.origin.y - before), 6, "a mouse wheel over a tool output must move the transcript")

        // A trackpad gesture reaches the transcript's own scroll view, which moves on its first event
        // and then tracks the gesture itself. Real events keep feeding that tracking; a test's queue
        // does not, so only the first step shows here.
        block = try XCTUnwrap(rig.visibleCodeBlocks().first, "no tool output on screen")
        before = list.contentView.bounds.origin.y
        rig.gesture(at: rig.center(of: block), dx: 0, dy: -24, steps: 8)
        rig.settle(0.3)
        XCTAssertGreaterThan(abs(list.contentView.bounds.origin.y - before), 10, "a trackpad scroll over a tool output must move the transcript")
        XCTAssertEqual(block.offset, 0, "a vertical scroll must not move the output sideways")
    }

    func testHorizontalWheelOverAToolOutputScrollsTheOutputOnly() throws {
        let session = try InventedSession.make(sections: 6)
        let rig = Rig(session.list(), size: NSSize(width: 900, height: 700))
        defer { rig.close() }
        rig.settle(1.5)
        let list = try XCTUnwrap(rig.transcript, "no transcript scroll view")
        rig.scrollTranscript(to: (list.documentView?.frame.height ?? 0) / 2)
        rig.settle(0.6)

        let block = try XCTUnwrap(rig.visibleCodeBlocks().first { $0.contentWidth > $0.bounds.width + 40 }, "no wide tool output on screen")
        let listBefore = list.contentView.bounds.origin.y
        rig.gesture(at: rig.center(of: block), dx: -24, dy: 0, steps: 8)
        rig.settle(0.3)

        XCTAssertGreaterThan(block.offset, 40, "a horizontal scroll must move the output sideways")
        XCTAssertEqual(list.contentView.bounds.origin.y, listBefore, accuracy: 0.5, "a horizontal scroll must leave the transcript where it is")
        // Clicks still reach the text under it: the wheel view answers hit tests only for the wheel.
        let center = block.convert(NSPoint(x: block.bounds.midX, y: block.bounds.midY), to: block.superview)
        rig.deliverOtherEvent()
        XCTAssertNil(block.hitTest(center), "the wheel view must not take clicks")
    }

    // GenesisTools adaptation: Martin, 2026-09-28: "when i open the tool details it should 1. show me the
    // entire input … 2. show me the entire output but it just keeps the height the same".

    /// A click on a closed tool call at "Tool inputs" opens it to its whole output: the row grows to
    /// hold it, the rows below move down by as much, and the call stays where it was clicked (the
    /// transcript opened at its latest turn used to pin its end and push the call up by its output).
    func testOpeningAToolRowGrowsItToItsWholeOutput() throws {
        let session = try InventedSession.make(sections: 3)
        let rig = Rig(session.list(verbosity: .inputs), size: NSSize(width: 700, height: 700))
        defer { rig.close() }
        rig.settle(1.5)
        let list = try XCTUnwrap(rig.transcript, "no transcript scroll view")
        let table = try XCTUnwrap(list.documentView as? NSTableView, "the transcript is not a table")
        let rows = session.tableRows()
        XCTAssertEqual(table.numberOfRows, rows.count, "the table's rows are not the list's rows")
        let visible = list.contentView.bounds
        let row = try XCTUnwrap(rows.indices.first { index in
            guard let id = rows[index], session.tool(id)?.name == "Bash" else { return false }
            let rect = table.rect(ofRow: index)
            return rect.minY > visible.minY + 40 && rect.maxY < visible.midY
        }, "no closed Bash call in the top half of the list")
        let output = try XCTUnwrap(session.fullOutputLines(rows[row]), "no output in the session file")
        let viewport = list.contentView.bounds.origin.y

        try rig.opensWholeOutput(row: row, lines: output, in: table)
        XCTAssertEqual(list.contentView.bounds.origin.y, viewport, accuracy: 0.5, "the clicked call must stay where it was")
    }

    /// The same for a call that arrived while the transcript was on screen, the way a running session's
    /// turns come in. AppKit drops the height listener of every row on screen at each insert, so such a
    /// call kept its closed height and drew its output over the rows below
    /// (`TranscriptScrollAnchor.remeasureVisibleRows`).
    func testARowOnScreenWhenTurnsArriveStillOpensToItsOutput() throws {
        let session = try InventedSession.make(sections: 3)
        let rig = Rig(Streaming(session: session), size: NSSize(width: 560, height: 700))
        defer { rig.close() }
        rig.settle(4.5)
        let list = try XCTUnwrap(rig.transcript, "no transcript scroll view")
        let table = try XCTUnwrap(list.documentView as? NSTableView, "the transcript is not a table")
        let rows = session.tableRows()
        XCTAssertEqual(table.numberOfRows, rows.count, "not every streamed row arrived")
        let arrived = Set(session.document.sections.last?.rows.map(\.id) ?? [])
        let row = try XCTUnwrap(rows.indices.first { rows[$0].map { arrived.contains($0) && session.tool($0)?.name == "Bash" } ?? false },
                                "no streamed Bash call")
        rig.scrollTranscript(to: table.rect(ofRow: row).minY - 150)
        rig.settle(0.8)
        let output = try XCTUnwrap(session.fullOutputLines(rows[row]), "no output in the session file")

        try rig.opensWholeOutput(row: row, lines: output, in: table)
    }

    // MARK: Cost

    func testScrollCost() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SESSION_SCROLL_PERF"] == "1" else {
            throw XCTSkip("set SESSION_SCROLL_PERF=1 to measure")
        }
        let session: InventedSession
        if let path = environment["SESSION_SCROLL_ENVELOPE"] {
            session = try InventedSession.real(envelopePath: path)
        } else {
            session = try InventedSession.make(sections: Int(environment["SESSION_SCROLL_SECTIONS"] ?? "") ?? 40)
        }
        let rig = Rig(session.screen(), size: NSSize(width: 1180, height: 820))
        defer { rig.close() }
        rig.settle(2.5)
        let list = try XCTUnwrap(rig.transcript, "no transcript scroll view")
        let height = list.documentView?.frame.height ?? 0
        print("SCROLLPERF label=\(session.label) rows=\(session.rowCount) tools=\(session.toolCount) contentHeight=\(Int(height))")
        print("SCROLLPERF hierarchy list=\(type(of: list)) doc=\(list.documentView.map { "\(type(of: $0))" } ?? "nil") blocks=\(rig.visibleCodeBlocks().map { "\(type(of: $0))" }.prefix(2))")

        // 1. Frames: the clip view moves 90 pt per frame from the top to the bottom, the way a fast
        //    flick does, and each frame gets 8 ms of run loop for the work it scheduled.
        rig.scrollTranscript(to: 0)
        rig.settle(1.0)
        RenderProbe.enabled = true
        _ = RenderProbe.take()
        var frames: [FrameCost] = []
        var y: CGFloat = 0
        while y < (list.documentView?.frame.height ?? 0) - list.contentView.bounds.height {
            y += 90
            frames.append(rig.frame(to: y))
        }
        let firstPass = RenderProbe.take()
        report("down-first", frames, counts: firstPass, extra: "end=\(Int(list.contentView.bounds.origin.y))")

        // 2. The same path again: every row has been seen once, so caches are warm.
        rig.scrollTranscript(to: 0)
        rig.settle(1.0)
        _ = RenderProbe.take()
        frames = []
        y = 0
        while y < (list.documentView?.frame.height ?? 0) - list.contentView.bounds.height {
            y += 90
            frames.append(rig.frame(to: y))
        }
        report("down-warm", frames, counts: RenderProbe.take(), extra: "end=\(Int(list.contentView.bounds.origin.y))")

        // 3. Wheel gestures with the pointer over a tool output, then over a reply or header.
        rig.scrollTranscript(to: (list.documentView?.frame.height ?? 0) / 3)
        rig.settle(1.0)
        if let block = rig.visibleCodeBlocks().first {
            wheelRun("wheel-over-output", rig: rig, at: rig.center(of: block))
        }
        rig.scrollTranscript(to: (list.documentView?.frame.height ?? 0) / 3)
        rig.settle(1.0)
        wheelRun("wheel-over-text", rig: rig, at: NSPoint(x: 60, y: list.convert(NSPoint(x: 0, y: list.bounds.midY), to: nil).y))
        RenderProbe.enabled = false
    }

    /// What an idle Session Details window of a running session renders per second: first on its own
    /// (its clocks), then under a parent that re-renders once a second with the same data, the way the
    /// window's pane does on each monitor publish.
    func testIdleCost() throws {
        guard ProcessInfo.processInfo.environment["SESSION_SCROLL_PERF"] == "1" else {
            throw XCTSkip("set SESSION_SCROLL_PERF=1 to measure")
        }
        let session = try InventedSession.make(sections: 12)
        let active = Date().addingTimeInterval(-5)
        let seconds = 20.0

        let idle = Rig(session.screen(lastActivity: active), size: NSSize(width: 1180, height: 820))
        idle.settle(2.5)
        RenderProbe.enabled = true
        _ = RenderProbe.take()
        var cpu = idle.mainCPU()
        idle.settle(seconds)
        reportIdle("idle", RenderProbe.take(), seconds: seconds, cpu: idle.mainCPU() - cpu)
        idle.close()

        let republished = Rig(Republisher { _ in session.screen(lastActivity: active) }, size: NSSize(width: 1180, height: 820))
        republished.settle(2.5)
        _ = RenderProbe.take()
        cpu = republished.mainCPU()
        republished.settle(seconds)
        reportIdle("parent-rerender-1s", RenderProbe.take(), seconds: seconds, cpu: republished.mainCPU() - cpu)
        republished.close()
        RenderProbe.enabled = false
    }

    private func reportIdle(_ label: String, _ counts: [String: Int], seconds: Double, cpu: Double) {
        let perSecond = counts.sorted { $0.key < $1.key }.map { String(format: "%@=%.2f/s", $0.key, Double($0.value) / seconds) }.joined(separator: " ")
        print("SCROLLPERF \(label) seconds=\(Int(seconds)) mainCPU=\(String(format: "%.2f", cpu / seconds))ms/s \(perSecond.isEmpty ? "nothing counted" : perSecond)")
    }

    /// What wheel gestures at `point` cost. `moved` counts only the first step of each gesture that
    /// reaches the transcript: its scroll view then tracks the gesture itself, from events a test's
    /// queue never feeds.
    private func wheelRun(_ label: String, rig: Rig, at point: NSPoint) {
        guard let list = rig.transcript else { return }
        _ = RenderProbe.take()
        let start = list.contentView.bounds.origin.y
        var costs: [FrameCost] = []
        // Five gestures of 24 changed events each, 8 ms apart: 120 events.
        for _ in 0..<5 {
            costs += rig.timedGesture(at: point, dx: 0, dy: -18, steps: 24)
            rig.settle(0.1)
        }
        let moved = list.contentView.bounds.origin.y - start
        report(label, costs, counts: RenderProbe.take(), extra: "moved=\(Int(moved))")
    }

    private func report(_ label: String, _ frames: [FrameCost], counts: [String: Int], extra: String = "") {
        guard !frames.isEmpty else {
            print("SCROLLPERF \(label) no frames")
            return
        }
        func stats(_ values: [Double]) -> String {
            let sorted = values.sorted()
            let p50 = sorted[sorted.count / 2]
            let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
            let total = values.reduce(0, +)
            return String(format: "total=%.1f p50=%.2f p95=%.2f max=%.2f", total, p50, p95, sorted.last ?? 0)
        }
        let cpu = frames.map(\.cpu)
        let over8 = cpu.filter { $0 > 8.3 }.count
        let over16 = cpu.filter { $0 > 16.7 }.count
        let counted = counts.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        print("SCROLLPERF \(label) frames=\(frames.count) cpu[\(stats(cpu))] sync[\(stats(frames.map(\.sync)))] over8ms=\(over8) over16ms=\(over16) \(extra) \(counted)")
    }
}

// GenesisTools adaptation: the last section arrives one row at a time while the list is on screen, each
// tool call first running and then finished, the way the hub's live tail brings a working session in.
private struct Streaming: View {
    let session: InventedSession
    @State private var step = 0

    private var document: TranscriptDocument {
        var document = session.document
        let last = document.sections.count - 1
        let rows = document.sections[last].rows
        let shown = min(rows.count, step / 2 + 1)
        document.sections[last].rows = rows.prefix(shown).enumerated().map { index, row in
            guard index == shown - 1, step % 2 == 0, case .tool(let line) = row.kind else { return row }
            let running = TranscriptToolLine(
                toolId: line.toolId, name: line.name, displayName: line.displayName, symbol: line.symbol,
                keyArgument: line.keyArgument, input: line.input, result: nil, status: .pending, exitCode: nil,
                resultChars: nil, duration: nil
            )
            return TranscriptRow(id: row.id, kind: .tool(running), at: row.at, clock: row.clock, searchText: row.searchText, showsAuthor: row.showsAuthor)
        }
        return document
    }

    var body: some View {
        SessionTranscriptList(
            document: document,
            provider: AIProviders.meta(for: session.envelope.provider),
            modelName: "opus",
            loadState: .loaded,
            hasEarlier: false,
            loadingEarlier: false,
            windowNote: nil,
            onLoadEarlier: {},
            preset: TranscriptPreset(verbosity: .inputs),
            services: session.services
        )
        .environment(\.colorScheme, .dark)
        .task {
            // Two steps a row (running, then finished), the last one finishing it.
            let total = session.document.sections.last?.rows.count ?? 0
            while !Task.isCancelled, step < total * 2 - 1 {
                try? await Task.sleep(nanoseconds: 120_000_000)
                step += 1
            }
        }
    }
}

/// Re-renders its content once a second with nothing changed, like a host on a model publish.
private struct Republisher<Content: View>: View {
    let content: (Int) -> Content
    @State private var tick = 0

    var body: some View {
        content(tick)
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    tick += 1
                }
            }
    }
}

// MARK: - Rig

private struct FrameCost {
    /// Main-thread CPU of the move, layout and display, in ms.
    var sync: Double
    /// Main-thread CPU of the whole frame, including the run loop slice after it, in ms.
    var cpu: Double
}

@MainActor
private final class Rig {
    let window: NSWindow

    init<V: View>(_ view: V, size: NSSize) {
        _ = NSApplication.shared
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        SessionDetailScreenChrome.apply(to: window)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.alphaValue = 0
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.transient, .ignoresCycle, .stationary]
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        // It stays where ordering in puts it (a titled window is constrained onto a screen, measured at
        // 0,0): a scroll event's location passes through screen coordinates, and one far off every
        // display arrives at the wrong point in the window. Alpha 0 below the desktop, it never shows.
        window.orderFrontRegardless()
    }

    func close() {
        window.orderOut(nil)
        window.close()
    }

    /// Runs what `NSApp.run` would for `seconds`.
    func settle(_ seconds: TimeInterval) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            pump(until: min(end, Date().addingTimeInterval(0.01)))
        }
    }

    /// Queued events through `NSApp.sendEvent`, then the run loop until `deadline`.
    func pump(until deadline: Date) {
        while let event = NSApp.nextEvent(matching: .any, until: nil, inMode: .default, dequeue: true) {
            NSApp.sendEvent(event)
        }
        repeat {
            RunLoop.main.run(mode: .default, before: deadline)
        } while Date() < deadline
    }

    /// The transcript `List`'s scroll view: the one around a table, or the tallest vertical one.
    var transcript: NSScrollView? {
        let all = views { $0 is NSScrollView }.compactMap { $0 as? NSScrollView }
        if let table = all.first(where: { $0.documentView is NSTableView }) { return table }
        return all.filter { $0.frame.width > 300 }.max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
    }

    /// The tool outputs on screen, by the view that takes their wheel events.
    func visibleCodeBlocks() -> [SidewaysWheel.WheelView] {
        guard let list = transcript, let document = list.documentView else { return [] }
        let visible = list.contentView.bounds
        return views { $0 is SidewaysWheel.WheelView && $0.isDescendant(of: document) }
            .compactMap { $0 as? SidewaysWheel.WheelView }
            .filter { block in
                let frame = document.convert(block.bounds, from: block)
                return frame.height > 30 && visible.insetBy(dx: 0, dy: 40).contains(NSPoint(x: frame.midX, y: frame.midY))
            }
    }

    func center(of view: NSView) -> NSPoint {
        view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
    }

    func scrollTranscript(to y: CGFloat) {
        guard let list = transcript else { return }
        list.contentView.scroll(to: NSPoint(x: 0, y: max(0, y)))
        list.reflectScrolledClipView(list.contentView)
    }

    /// One display frame of a scroll to `y`.
    func frame(to y: CGFloat) -> FrameCost {
        let start = threadCPU()
        scrollTranscript(to: y)
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let sync = threadCPU() - start
        pump(until: Date().addingTimeInterval(0.008))
        return FrameCost(sync: sync, cpu: threadCPU() - start)
    }

    /// A trackpad gesture: began, `steps` changed events, ended, all at `point` (window coordinates).
    func gesture(at point: NSPoint, dx: Int32, dy: Int32, steps: Int) {
        _ = timedGesture(at: point, dx: dx, dy: dy, steps: steps)
    }

    /// The same gesture, one event per 8 ms frame, with each frame's main-thread cost.
    func timedGesture(at point: NSPoint, dx: Int32, dy: Int32, steps: Int) -> [FrameCost] {
        var costs: [FrameCost] = []
        let phases: [(CGScrollPhase, Int32, Int32)] = [(.began, dx, dy)] + Array(repeating: (.changed, dx, dy), count: steps) + [(.ended, 0, 0)]
        for (phase, x, y) in phases {
            guard let event = wheelEvent(at: point, dx: x, dy: y, phase: phase) else { continue }
            let start = threadCPU()
            NSApp.postEvent(event, atStart: false)
            pump(until: Date())
            let sync = threadCPU() - start
            pump(until: Date().addingTimeInterval(0.008))
            costs.append(FrameCost(sync: sync, cpu: threadCPU() - start))
        }
        return costs
    }

    /// Makes a non-wheel event the app's current event, as a click or a key press would.
    func deliverOtherEvent() {
        guard let event = NSEvent.otherEvent(
            with: .applicationDefined,
            location: .zero,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            subtype: 0,
            data1: 0,
            data2: 0
        ) else { return }
        NSApp.postEvent(event, atStart: false)
        pump(until: Date())
    }

    /// `count` mouse-wheel notches of `dx`/`dy` lines at `point`.
    func notches(at point: NSPoint, dx: Int32, dy: Int32, count: Int) {
        for _ in 0..<count {
            guard let event = wheelEvent(at: point, dx: dx, dy: dy, phase: nil) else { continue }
            NSApp.postEvent(event, atStart: false)
            pump(until: Date().addingTimeInterval(0.008))
        }
    }

    /// A scroll event at `point` in this window: a trackpad one in `phase`, or a mouse-wheel notch
    /// (lines, no phase) when `phase` is nil. Built from a mouse event, because only an event made
    /// with a window number carries a window-local location: a scroll `CGEvent` given a window
    /// reports (-1, height + 1) as its `locationInWindow` whatever its screen location (measured).
    private func wheelEvent(at point: NSPoint, dx: Int32, dy: Int32, phase: CGScrollPhase?) -> NSEvent? {
        guard let mouse = NSEvent.mouseEvent(
            with: .mouseMoved,
            location: point,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 0,
            pressure: 0
        ), let cg = mouse.cgEvent else { return nil }
        cg.type = .scrollWheel
        let notch = phase == nil
        cg.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: Int64(notch ? dy : dy.signum()))
        cg.setIntegerValueField(.scrollWheelEventDeltaAxis2, value: Int64(notch ? dx : dx.signum()))
        cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(notch ? dy * 10 : dy))
        cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(notch ? dx * 10 : dx))
        cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(dy))
        cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Double(dx))
        cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: notch ? 0 : 1)
        cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase?.rawValue ?? 0))
        cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 0)
        return NSEvent(cgEvent: cg)
    }

    // GenesisTools adaptation: clicks the header of the closed tool call in `row`, then checks the row grew
    // to hold all `lines` of its output, the rows below moved down by as much, and the output is drawn
    // inside the row (a row that kept its height drew it over the next ones).
    func opensWholeOutput(row: Int, lines: Int, in table: NSTableView, file: StaticString = #filePath, line: UInt = #line) throws {
        let before = table.rect(ofRow: row)
        let nextBefore = table.rect(ofRow: row + 1)
        click(at: table.convert(NSPoint(x: before.minX + 120, y: before.minY + 11), to: nil))
        settle(1.2)

        let after = table.rect(ofRow: row)
        let nextAfter = table.rect(ofRow: row + 1)
        // 11.5 pt monospaced lines with 1.5 pt spacing: a little over 15 pt each.
        XCTAssertGreaterThan(after.height, before.height + CGFloat(lines) * 14, "the opened call must grow to its \(lines) output lines", file: file, line: line)
        XCTAssertEqual(nextAfter.minY, after.maxY, accuracy: 1, "the next row must start where the opened one ends", file: file, line: line)
        XCTAssertEqual(nextAfter.minY - nextBefore.minY, after.height - before.height, accuracy: 1, "the rows below must move down by the growth", file: file, line: line)
        let output = try XCTUnwrap(codeBlocks(in: table).last { $0.minY >= before.minY && $0.minY < after.maxY }, "no output drawn in the opened row", file: file, line: line)
        XCTAssertGreaterThan(output.height, CGFloat(lines) * 14, "the output must show every line, not the first ten", file: file, line: line)
        XCTAssertLessThanOrEqual(output.maxY, after.maxY + 1, "the output must fit inside its row", file: file, line: line)

        // A second click on the header closes it again, and the rows below come back up.
        click(at: table.convert(NSPoint(x: before.minX + 120, y: before.minY + 11), to: nil))
        settle(0.8)
        XCTAssertEqual(table.rect(ofRow: row).height, before.height, accuracy: 1, "the closed call must shrink back", file: file, line: line)
        XCTAssertEqual(table.rect(ofRow: row + 1).minY, nextBefore.minY, accuracy: 1, "the rows below must come back up", file: file, line: line)
    }

    // GenesisTools adaptation: a plain left click at `point` (window coordinates), delivered the way the
    // wheel events are.
    func click(at point: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(
                with: type,
                location: point,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 0,
                clickCount: 1,
                pressure: type == .leftMouseDown ? 1 : 0
            ) else { continue }
            NSApp.postEvent(event, atStart: false)
        }
        pump(until: Date().addingTimeInterval(0.05))
    }

    // GenesisTools adaptation: the drawn tool outputs under `table`, as frames in its coordinates, top first.
    func codeBlocks(in table: NSTableView) -> [NSRect] {
        views { $0 is SidewaysWheel.WheelView && $0.isDescendant(of: table) }
            .map { table.convert($0.bounds, from: $0) }
            .sorted { $0.minY < $1.minY }
    }

    private func views(_ match: (NSView) -> Bool) -> [NSView] {
        guard let root = window.contentView?.superview ?? window.contentView else { return [] }
        var found: [NSView] = []
        var stack = [root]
        while let view = stack.popLast() {
            if match(view) { found.append(view) }
            stack.append(contentsOf: view.subviews)
        }
        return found
    }

    /// Main-thread CPU so far, in ms (the tests run on the main thread).
    func mainCPU() -> Double {
        threadCPU()
    }

    private func threadCPU() -> Double {
        var time = timespec()
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time)
        return Double(time.tv_sec) * 1000 + Double(time.tv_nsec) / 1_000_000
    }
}

// MARK: - Sessions

/// A long invented session (a coding agent fixing a build: shell calls with long outputs, reads,
/// edits and replies), written as a `tools ai sessions tail` envelope plus the session file the
/// rows load their full results from. Or a real envelope and its session file.
@MainActor
private struct InventedSession {
    let label: String
    let envelope: TranscriptEnvelope
    let native: SessionNativeLog?
    let document: TranscriptDocument

    var rowCount: Int { document.sections.reduce(0) { $0 + $1.rows.count } }
    var toolCount: Int { document.toolCount }

    private static func services(_ envelope: TranscriptEnvelope, _ native: SessionNativeLog?) -> TranscriptServices {
        TranscriptServices(sessionId: envelope.sessionId, cwd: "/Users/dev/projects/atlas", nativeLog: native, changes: nil, showChange: nil)
    }

    static func real(envelopePath: String) throws -> InventedSession {
        let envelope = try SessionTranscriptClient.decode(Data(contentsOf: URL(fileURLWithPath: envelopePath)))
        let native = SessionNativeLog.scan(path: envelope.filePath)
        let document = TranscriptDocument.build(envelope.turns, turnOffset: envelope.windowStart, native: native?.summary)
        return InventedSession(label: "real", envelope: envelope, native: native, document: document, services: services(envelope, native))
    }

    static func make(sections: Int) throws -> InventedSession {
        let sessionId = "3b7e0c2a-91d4-4f6e-8a55-\(String(format: "%012d", sections))"
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("scroll-session-\(UUID().uuidString).jsonl")
        var turns: [[String: Any]] = []
        var lines: [String] = []
        var tool = 0
        var clock = Date(timeIntervalSince1970: 1_790_000_000)
        func stamp() -> String {
            clock.addTimeInterval(7)
            return ISO8601DateFormatter().string(from: clock)
        }
        func json(_ object: Any) -> String {
            String(decoding: (try? JSONSerialization.data(withJSONObject: object)) ?? Data(), as: UTF8.self)
        }

        for section in 0..<sections {
            let prompt = "Step \(section + 1): the build of the atlas package fails after the dependency bump. Run the tests, read the failures and fix the parser module."
            let at = stamp()
            turns.append(["id": "u\(section)", "role": "user", "at": at, "text": prompt, "tools": []])
            lines.append(json(["type": "user", "uuid": "u\(section)", "timestamp": at, "message": ["role": "user", "content": prompt]]))

            for call in 0..<8 {
                tool += 1
                let id = "tool\(tool)"
                let kind = call % 4
                let name = kind == 2 ? "Read" : kind == 3 && call == 7 ? "Edit" : "Bash"
                var input: [String: Any]
                var preview: String
                let output: String
                switch name {
                case "Read":
                    let path = "/Users/dev/projects/atlas/src/parser/module\(call).swift"
                    input = ["file_path": path]
                    preview = path
                    output = (1...(40 + (tool * 13) % 160)).map { "\($0)\tlet token\($0) = scanner.next(kind: .identifier, fallback: \"value \($0)\") // keeps the parser state in step with the lexer" }.joined(separator: "\n")
                case "Edit":
                    let path = "/Users/dev/projects/atlas/src/parser/Lexer.swift"
                    input = [
                        "file_path": path,
                        "old_string": (0..<12).map { "    let value\($0) = try scanner.scan(.number)" }.joined(separator: "\n"),
                        "new_string": (0..<12).map { "    let value\($0) = try scanner.scan(.number, allowing: .underscores)" }.joined(separator: "\n"),
                    ]
                    preview = path
                    output = "The file \(path) has been updated."
                default:
                    let command = call == 1
                        ? "swift test --filter ParserTests 2>&1 | tee /tmp/atlas-test.log\nrg -n 'error:' /tmp/atlas-test.log | head -40"
                        : "swift build -c debug --product atlas 2>&1 | tail -\(60 + call * 20)"
                    input = ["command": command, "description": "Build and test"]
                    preview = command
                    output = (1...(20 + (tool * 37) % 260)).map { line in
                        line % 9 == 0
                            ? "/Users/dev/projects/atlas/Sources/Parser/Module\(line % 7).swift:\(line * 3):17: error: cannot convert value of type 'Token<Identifier>' to expected argument type 'Token<Literal>' in call to 'scan(_:allowing:)'"
                            : "[\(line)/\(20 + (tool * 37) % 260)] Compiling Parser Module\(line % 7).swift (\(line * 11) ms)"
                    }.joined(separator: "\n")
                }
                let callAt = stamp()
                turns.append([
                    "id": "a\(tool)", "role": "assistant", "at": callAt, "text": "",
                    "tools": [["id": id, "name": name, "inputPreview": preview, "result": String(output.prefix(2000)), "isError": false]],
                ])
                lines.append(json([
                    "type": "assistant", "uuid": "a\(tool)", "timestamp": callAt,
                    "message": [
                        "model": "claude-opus-5-5", "id": "msg_\(tool)", "role": "assistant",
                        "content": [["type": "tool_use", "id": id, "name": name, "input": input]],
                        "usage": ["input_tokens": 1200, "output_tokens": 300, "cache_read_input_tokens": 40000],
                    ],
                ]))
                lines.append(json([
                    "type": "user", "uuid": "r\(tool)", "timestamp": callAt,
                    "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": id, "content": output, "is_error": false]]],
                ]))
            }

            let reply = """
            The parser failed because the lexer now returns **literal tokens** for numbers with underscores. I changed `scan(_:allowing:)` and the tests pass:

            ```swift
            let value = try scanner.scan(.number, allowing: .underscores)
            ```

            - \(section * 3 + 1) tests ran, none failed.
            - The build takes 41 s, as before.
            """
            let replyAt = stamp()
            turns.append(["id": "r-end\(section)", "role": "assistant", "at": replyAt, "text": reply, "tools": []])
        }

        try lines.joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)
        let envelopeObject: [String: Any] = [
            "provider": "claude", "sessionId": sessionId, "filePath": file.path, "byteSize": 1_000_000,
            "truncated": false, "nextOffset": turns.count, "turns": turns, "terminated": NSNull(),
        ]
        let envelope = try SessionTranscriptClient.decode(JSONSerialization.data(withJSONObject: envelopeObject))
        let native = SessionNativeLog.scan(path: file.path)
        let document = TranscriptDocument.build(envelope.turns, turnOffset: envelope.windowStart, native: native?.summary)
        return InventedSession(label: "invented-\(sections)", envelope: envelope, native: native, document: document, services: services(envelope, native))
    }

    /// One per session, as a host keeps it: rows compare services by identity.
    let services: TranscriptServices

    // GenesisTools adaptation: the transcript row id of each table row, nil for the rows the list adds
    // (its top marker, each section's header and end marker, the spacer at the bottom).
    func tableRows() -> [String?] {
        var ids: [String?] = [nil]
        for section in document.sections {
            ids.append(nil)
            ids += section.rows.map { Optional($0.id) }
            ids.append(nil)
        }
        ids.append(nil)
        return ids
    }

    // GenesisTools adaptation: the tool call of a row id.
    func tool(_ rowId: String) -> TranscriptToolLine? {
        for section in document.sections {
            for row in section.rows where row.id == rowId {
                if case .tool(let line) = row.kind { return line }
            }
        }
        return nil
    }

    // GenesisTools adaptation: how many lines the call of a row id printed, from the session file.
    func fullOutputLines(_ rowId: String?) -> Int? {
        guard let rowId, let line = tool(rowId), let result = native?.detail(for: line.toolId)?.fullResult else { return nil }
        return result.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    /// The transcript alone, at "Inputs + output".
    // GenesisTools adaptation: `verbosity`, so a test can open a closed tool call.
    func list(verbosity: TranscriptVerbosity = .outputs) -> some View {
        SessionTranscriptList(
            document: document,
            provider: AIProviders.meta(for: envelope.provider),
            modelName: "opus",
            loadState: .loaded,
            hasEarlier: false,
            loadingEarlier: false,
            windowNote: nil,
            onLoadEarlier: {},
            preset: TranscriptPreset(verbosity: verbosity),
            services: services
        )
        .environment(\.colorScheme, .dark)
    }

    /// The whole Session Details screen (header, transcript, sidebar), at "Inputs + output".
    /// `lastActivity` makes it a running session that was active then.
    func screen(lastActivity: Date? = nil) -> some View {
        var info = SessionDetailInfo(sessionId: envelope.sessionId, title: "Fix the parser after the dependency bump", provider: AIProviders.meta(for: envelope.provider))
        info.account = "work"
        info.model = "opus"
        info.cwd = "/Users/dev/projects/atlas"
        info.liveness = .running
        info.startedAt = document.firstAt
        info.lastActivityAt = lastActivity ?? document.lastAt
        info.turnCount = envelope.nextOffset
        info.toolCount = document.toolCount
        info.errorCount = document.errorCount
        return SessionDetailScreen(
            info: info,
            digest: SessionActivityDigest.build(envelope.turns),
            document: document,
            loadState: .loaded,
            preset: TranscriptPreset(verbosity: .outputs),
            services: services,
            actions: SessionDetailActions()
        ) {
            EmptyView()
        }
    }
}
