import AppKit
import SwiftUI
import XCTest
@testable import GenesisTools

/// An Activity row whose event keeps its id but moves to another time (a session's "last turn", a PR's
/// "updated") must show the new time in the hour group it now sits in. The list paints the disk cache first and
/// the fresh page after it, so every such event moves once per load (2026-10-10: "22:07 say hi · 1h ago" under
/// 23:00, its fresh time 23:07).
@MainActor
final class HubTimelineRowIdentityTests: XCTestCase {
    private final class Feed: ObservableObject {
        @Published var events: [TimelineEvent] = []
    }

    /// What each row's body last drew, by event id.
    private nonisolated(unsafe) static var drawn: [String: String] = [:]

    private struct Row: View {
        let event: TimelineEvent

        var body: some View {
            let label = event.at
            let _ = HubTimelineRowIdentityTests.record(event.id, label)
            Text(verbatim: "\(label) \(event.title)").frame(height: 20)
        }
    }

    nonisolated static func record(_ id: String, _ label: String) {
        drawn[id] = label
    }

    /// The Activity list's shape: day sections with pinned headers, hour headers, and the rows of each hour.
    private struct List: View {
        @ObservedObject var feed: Feed

        var body: some View {
            let days = TimelineDay.group(feed.events)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(days) { day in
                        Section {
                            ForEach(day.hours) { hour in
                                Text(verbatim: "hour \(hour.hour)").frame(height: 20)
                                // The production list's row: its identity, find row and transition.
                                ForEach(hour.events, id: \.rowID) { event in
                                    Row(event: event)
                                        .findRow(event.rowID)
                                        .transition(SWR.rowTransition)
                                }
                            }
                        } header: {
                            Text(verbatim: "day \(day.day)").frame(height: 20)
                        }
                    }
                }
            }
        }
    }

    private func event(_ id: String, at: String, title: String) throws -> TimelineEvent {
        let json = """
        { "id": "\(id)", "kind": "session.turn", "at": "\(at)", "title": "\(title)", "detail": null, "project": "app", "repo": null }
        """
        return try JSONDecoder().decode(TimelineEvent.self, from: Data(json.utf8))
    }

    func testAnEventThatMovesToAnotherHourShowsItsNewTime() throws {
        Self.drawn = [:]
        let feed = Feed()
        // The cached page: "say hi" last turned at 22:07, among rows of the 23:00 and 22:00 hours.
        feed.events = [
            try event("turn:a", at: "2026-10-10T21:10:28Z", title: "genesis-tools-native"),
            try event("pr:b", at: "2026-10-10T21:04:24Z", title: "fix(emails)"),
            try event("turn:say-hi", at: "2026-10-10T20:07:52Z", title: "say hi"),
            try event("turn:c", at: "2026-10-10T20:00:05Z", title: "col-279041"),
        ]
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: List(feed: feed))
        // Never visible: alpha 0, below the desktop, ignores the mouse, the app is not activated.
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }

        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        XCTAssertEqual(Self.drawn["turn:say-hi"], "2026-10-10T20:07:52Z")

        // The fresh page: "say hi" took another turn at 23:07, so it moves up into the 23:00 hour, the way
        // `HubTimelineModel.apply` lands a small refresh (animated).
        withAnimation(SWR.animation) {
            feed.events = [
                try! event("turn:a", at: "2026-10-10T21:10:28Z", title: "genesis-tools-native"),
                try! event("turn:say-hi", at: "2026-10-10T21:07:52Z", title: "say hi"),
                try! event("pr:b", at: "2026-10-10T21:04:24Z", title: "fix(emails)"),
                try! event("turn:c", at: "2026-10-10T20:00:05Z", title: "col-279041"),
            ]
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))

        XCTAssertEqual(Self.drawn["turn:say-hi"], "2026-10-10T21:07:52Z", "the moved row still draws its old time")
    }

    /// The positive control: a row that changes but stays in its hour is drawn again as it is.
    func testAnEventThatStaysInItsHourShowsItsNewTitle() throws {
        Self.drawn = [:]
        let feed = Feed()
        feed.events = [
            try event("turn:a", at: "2026-10-10T21:10:28Z", title: "genesis-tools-native"),
            try event("turn:b", at: "2026-10-10T21:02:00Z", title: "old title"),
        ]
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: List(feed: feed))
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }

        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        feed.events = [
            try event("turn:a", at: "2026-10-10T21:10:28Z", title: "genesis-tools-native"),
            try event("turn:b", at: "2026-10-10T21:05:00Z", title: "new title"),
        ]
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))

        XCTAssertEqual(Self.drawn["turn:b"], "2026-10-10T21:05:00Z")
    }
}
