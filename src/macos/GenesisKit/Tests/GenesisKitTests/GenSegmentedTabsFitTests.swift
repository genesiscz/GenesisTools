import AppKit
import Darwin
import SwiftUI
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// What a tick inside a list costs when segmented tabs sit in the list's top inset, as in the Meetings window's Items
/// pane: every invalidation of the list measures the inset's content again, and a `ViewThatFits` of strips builds and
/// drops each candidate per measurement. Prints the main thread's CPU per tick for each shape of the bar. Skipped
/// unless `SEGMENTED_TABS_COST=1`: it times, it does not assert.
@MainActor
final class GenSegmentedTabsCostTests: XCTestCase {
    final class Tick: ObservableObject {
        @Published var n = 0
    }

    enum Arm: String, CaseIterable {
        /// A plain text in the inset: the floor.
        case none
        /// `GenSegmentedTabs(fillsWidth: true)` alone.
        case fill
        /// The Items bar as it was: counts, titles, then the filling strip, in a `ViewThatFits`.
        case fitting
        /// The Items bar as it is: one strip, picked from the room its slot has.
        case picked
    }

    struct Column: View {
        @ObservedObject var tick: Tick
        let arm: Arm
        @State private var filter = "all"
        @State private var room: CGFloat?

        private func items(counts: Bool) -> [GenSegmentedTabs<String>.Item] {
            [.init("all", "All", count: counts ? 142 : nil),
             .init("questions", "Questions", count: counts ? 9 : nil, hue: .ask),
             .init("suggestions", "Suggestions", count: counts ? 133 : nil, hue: .care)]
        }

        private func tabs(counts: Bool, fills: Bool) -> some View {
            GenSegmentedTabs("Rows shown", items: items(counts: counts), selection: $filter, minSegmentWidth: 0,
                             fillsWidth: fills, size: .small)
        }

        @ViewBuilder private var bar: some View {
            switch arm {
            case .none: Text("Rows shown")
            case .fill: tabs(counts: false, fills: true)
            case .fitting:
                ViewThatFits(in: .horizontal) {
                    tabs(counts: true, fills: false)
                    tabs(counts: false, fills: false)
                    tabs(counts: false, fills: true)
                }
            case .picked:
                let natural = { (counts: Bool) in
                    GenSegmentedTabs.naturalWidth(items: items(counts: counts), selection: filter, minSegmentWidth: 0,
                                                  size: .small, look: .classic)
                }
                let counts = room.map { natural(true) <= $0 } ?? true
                let titles = !counts && (room.map { natural(false) <= $0 } ?? true)
                tabs(counts: counts, fills: !counts && !titles)
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width.rounded(.down) } action: { room = $0 }
            }
        }

        var body: some View {
            // The Meetings window's shape: a split view whose detail column holds the rows list (the bar in its top
            // inset) beside a pane that changes on every tick, as the transcript pane does while a Moment plays.
            NavigationSplitView {
                List { Text("Needs you"); Text("All meetings") }.navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 300)
            } content: {
                List(0..<20, id: \.self) { Text(verbatim: "Meeting \($0)") }.navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 480)
            } detail: {
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                        Text("A review of the backend").font(.title2).padding(12)
                        Divider()
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(0..<300, id: \.self) { Text(verbatim: "Row \($0): a suggestion to review").padding(4) }
                            }
                        }
                        .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: 0) }
                        .safeAreaInset(edge: .top, spacing: 0) {
                            HStack(spacing: 10) {
                                bar.layoutPriority(1)
                                Spacer(minLength: 8)
                                Text("Confirm all…").fixedSize()
                            }
                            .padding(.horizontal, 14).padding(.vertical, 6)
                        }
                        .safeAreaPadding(.bottom, 200)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    Divider()
                    let heard = Int(Double(tick.n) / 4)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(0..<400, id: \.self) { block in
                                Text(verbatim: "Block \(block): a line a speaker said at this time of the meeting.")
                                    .foregroundStyle(block < heard ? .tertiary : .secondary)
                                    .padding(6)
                                    .background(block == heard ? Color.accentColor.opacity(0.14) : .clear)
                            }
                        }
                    }
                    .frame(width: 320)
                    .frame(maxHeight: .infinity)
                }
                .frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private static func cpuMs() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        func ms(_ t: timeval) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_usec) / 1000 }
        return ms(usage.ru_utime) + ms(usage.ru_stime)
    }

    func testCostPerTick() throws {
        guard ProcessInfo.processInfo.environment["SEGMENTED_TABS_COST"] == "1" else {
            throw XCTSkip("set SEGMENTED_TABS_COST=1")
        }
        for width in [1500.0, 1150.0] {
            for arm in Arm.allCases {
                _ = NSApplication.shared
                let tick = Tick()
                let host = NSHostingView(rootView: Column(tick: tick, arm: arm).environment(\.colorScheme, .dark))
                host.sizingOptions = []
                let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: width, height: 900),
                                      styleMask: [.titled, .resizable], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.alphaValue = 0
                window.ignoresMouseEvents = true
                window.contentView = host
                window.order(.below, relativeTo: 0)
                RunLoop.main.run(until: Date().addingTimeInterval(1.0))
                let ticks = 40
                let start = Self.cpuMs()
                for _ in 0..<ticks {
                    tick.n += 1
                    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
                }
                let perTick = (Self.cpuMs() - start) / Double(ticks)
                window.close()
                print(String(format: "segmented-cost width=%.0f arm=%@ cpu/tick=%.2f ms", width, arm.rawValue, perTick))
            }
        }
    }
}

/// A filling strip picks one fit from the width it is offered, by widths it computes from its titles instead of a
/// `ViewThatFits` that builds every candidate. These pin that the computed widths are the widths SwiftUI lays out,
/// and that the pick keeps the order the `ViewThatFits` had.
@MainActor
final class GenSegmentedTabsFitTests: XCTestCase {
    typealias Tabs = GenSegmentedTabs<String>
    private static let sets: [(String, [Tabs.Item])] = [
        ("plain", [.init("items", "Items"), .init("speakers", "Speakers"), .init("transcript", "Transcript")]),
        ("counts", [.init("all", "All", count: 142), .init("questions", "Questions", count: 9, hue: .ask),
                    .init("suggestions", "Suggestions", count: 133, hue: .care)]),
        ("rich", [.init("items", "Items", symbol: "list.bullet", count: 12),
                  .init("speakers", "Speakers", symbol: "person.2"), .init("notes", "Notes", symbol: "note.text")]),
    ]

    private func laidOut(_ view: some View) -> CGFloat {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view.environment(\.colorScheme, .dark))
        return host.fittingSize.width
    }

    func testArrowNavigationSkipsDisabledSegmentsAndDoesNotWrap() {
        let items: [Tabs.Item] = [.init("a", "A"), .init("b", "B", isEnabled: false), .init("c", "C")]
        XCTAssertEqual(Tabs.adjacentItem(in: items, from: "a", direction: 1), "c")
        XCTAssertEqual(Tabs.adjacentItem(in: items, from: "c", direction: -1), "a")
        XCTAssertNil(Tabs.adjacentItem(in: items, from: "a", direction: -1))
        XCTAssertNil(Tabs.adjacentItem(in: items, from: "c", direction: 1))
        XCTAssertNil(Tabs.adjacentItem(in: items, from: "missing", direction: 1))
        XCTAssertNil(Tabs.adjacentItem(in: items, from: "a", direction: 0))
    }

    func testTheNaturalWidthIsTheWidthTheStripTakes() {
        for (name, items) in Self.sets {
            for size in [KitControlSize.small, .regular, .large] {
                for minSegment in [CGFloat(0), 72] {
                    let selection = items[1].id
                    let computed = Tabs.naturalWidth(items: items, selection: selection, minSegmentWidth: minSegment, size: size,
                                                     look: .classic)
                    let drawn = laidOut(Tabs("T", items: items, selection: .constant(selection), minSegmentWidth: minSegment,
                                             size: size))
                    // AppKit and SwiftUI round a symbol's width apart by up to 1 pt; text widths match to the point.
                    let slack = 1.5 + CGFloat(items.filter { $0.symbol != nil }.count)
                    XCTAssertEqual(computed, drawn, accuracy: slack, "\(name) \(size) min \(minSegment)")
                }
            }
        }
    }

    func testAFillingStripsIdealWidthIsTheRoomyWidth() {
        for (name, items) in Self.sets {
            let computed = Tabs.idealWidth(items: items, selection: items[0].id, minSegmentWidth: 72, size: .regular,
                                           inset: KitLook.classic.wellInset, fit: .roomy)
            let drawn = laidOut(Tabs("T", items: items, selection: .constant(items[0].id), fillsWidth: true).fixedSize())
            let slack = 1.5 + CGFloat(items.filter { $0.symbol != nil }.count)
            XCTAssertEqual(computed, drawn, accuracy: slack, name)
        }
    }

    func testTheFillingPickKeepsTheOrderOfTheFits() {
        let needs: [Tabs.Fit: CGFloat] = [.roomy: 300, .compact: 270, .tight: 250, .bare: 200]
        let need = { (fit: Tabs.Fit) in needs[fit] ?? 0 }
        XCTAssertEqual(Tabs.Fit.filling(nil, need: need), .roomy)
        XCTAssertEqual(Tabs.Fit.filling(400, need: need), .roomy)
        XCTAssertEqual(Tabs.Fit.filling(300, need: need), .roomy)
        XCTAssertEqual(Tabs.Fit.filling(299, need: need), .compact)
        XCTAssertEqual(Tabs.Fit.filling(260, need: need), .tight)
        XCTAssertEqual(Tabs.Fit.filling(210, need: need), .bare)
        XCTAssertEqual(Tabs.Fit.filling(120, need: need), .scaled)
        XCTAssertEqual(Tabs.Fit.filling(0, need: need), .scaled)
    }
}
