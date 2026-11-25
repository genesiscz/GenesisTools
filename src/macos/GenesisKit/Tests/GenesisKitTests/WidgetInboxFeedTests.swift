import AppKit
import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

@MainActor
final class WidgetInboxFeedTests: XCTestCase {
    private let alpha = WidgetInboxRender.session("alpha", project: "Orchard")
    private let beta = WidgetInboxRender.session("beta", project: "Meadow")
    private let gamma = WidgetInboxRender.session("gamma", project: "Meadow")

    /// D1 from A, a note from B, a todo from C, then D5 and D6 from A. The two returns to A are separate headers.
    private var items: [WidgetInboxItem] {
        [
            .init(id: "decision:d1", sourceId: "d1", kind: "decision", key: alpha.key,
                  at: 5000, needsAnswer: true, title: "Pick a basket", number: 1),
            .init(message: .init(text: "The pears are ready."), id: "answer:m", sourceId: "m",
                  kind: "answer", key: beta.key, at: 4000, needsAnswer: false, title: "Delivery note", tag: "message"),
            .init(id: "todo:t", sourceId: "t", kind: "todo", key: gamma.key, at: 3000,
                  needsAnswer: false, title: "Sort the crates"),
            .init(id: "decision:d5", sourceId: "d5", kind: "decision", key: alpha.key,
                  at: 2000, needsAnswer: true, title: "Choose a shelf", number: 5),
            .init(id: "decision:d6", sourceId: "d6", kind: "decision", key: alpha.key,
                  at: 1000, needsAnswer: true, title: "Choose a label", number: 6),
        ]
    }

    private func makeModel(order: String = "feed", view: String = "sessions", headers: String = "groups",
                           runs: String = "session") throws -> WidgetModel {
        var prefs = WidgetPreferences.hubDefaults
        prefs.inboxGrouping = order
        prefs.previewView = view
        prefs.inboxFeedHeaders = headers
        prefs.inboxFeedRuns = runs
        prefs.previewFilter = "active"
        return try WidgetInboxRender.model(sessions: [alpha, beta, gamma], items: items, preferences: prefs)
    }

    func testD1NoteTodoD5D6FormFourConsecutiveSessionRuns() {
        let runs = WidgetInboxFeed.runs(items.reversed(), by: "session") { _ in nil }
        XCTAssertEqual(runs.map(\.runKey), [alpha.key, beta.key, gamma.key, alpha.key])
        XCTAssertEqual(runs.map { $0.items.count }, [1, 1, 1, 2])
        XCTAssertEqual(runs.map(\.id), [alpha.key + "|decision:d1", beta.key + "|answer:m",
                                        gamma.key + "|todo:t", alpha.key + "|decision:d5"])
        XCTAssertEqual(runs.flatMap(\.items), items)
    }

    func testProjectRunsCoalesceNeighboursAndWaitingNeverChangesTheChronology() throws {
        let model = try makeModel()
        defer { model.stop() }
        let runs = WidgetInboxFeed.runs(model.inboxOverviewItems, by: "project") { model.session(forKey: $0.key)?.project }
        XCTAssertEqual(runs.map(\.runKey), ["project/Orchard", "project/Meadow", "project/Orchard"])
        XCTAssertEqual(runs.map { $0.items.count }, [1, 2, 2])
        XCTAssertEqual(runs.flatMap(\.items), items, "The newer note comes before the two older waiting decisions")
        XCTAssertEqual(model.inboxFeeds["needs"].map { $0.items.map(\.sourceId) }, [["d1", "d5", "d6"]])
        let headers = runs.map { WidgetFeedRunHeader(run: $0, model: model) }
        XCTAssertEqual(headers.map(\.counts), ["", "2 items", "2 items · 2 waiting"])
        XCTAssertEqual(headers.first?.inboxTooltip, "Open the whole inbox of Alpha")
        XCTAssertNil(headers[1].openInbox, "The project covers two different session inboxes")
        XCTAssertNil(headers[1].provider)
        XCTAssertEqual(model.inboxFeeds["unread"].flatMap(\.items).map(\.id), ["answer:m"],
                       "The task is shown under All, but never contributes to the unread badge.")
    }

    func testExternalMessagesUseTheirSenderAndEqualTimesUseTheItemID() {
        var note = items[1]
        note.message?.origin = "External"
        note.at = items[0].at
        note.count = 3
        XCTAssertEqual(WidgetInboxOverview.summary([note]), "3 items · from 1 sender")
        XCTAssertEqual(WidgetInboxOverview.summary([note, items[0]]), "4 items · 1 waiting for your answer · from 1 session and 1 sender")
        XCTAssertEqual(WidgetInboxOverview.summary([note], hidden: 2), "3 items · from 1 sender · 2 more items in their sessions",
                       "entries the per-session limit left out are named, so a missing entry has a reason")
        for mode in ["session", "project"] {
            let runs = WidgetInboxFeed.runs([items[0], note], by: mode) { _ in "" }
            XCTAssertEqual(runs.map(\.runKey), ["sender/External", alpha.key])
            XCTAssertEqual(runs.first?.items.first?.id, "answer:m")
        }
    }

    func testNewItemsKeepThePreviousFirstRunAndRowsInPlaceUntilRevealed() {
        let old = WidgetInboxFeed.runs(items, by: "session") { _ in nil }
        var arrival = items[0]
        arrival.id = "decision:new"
        arrival.at += 1
        let fresh = WidgetInboxFeed.runs(items + [arrival], by: "session") { _ in nil }
        let held = WidgetFeedReadingPlace.split(fresh, at: items[0])
        XCTAssertEqual(held.pending, 1)
        XCTAssertEqual(held.runs, old)
        XCTAssertEqual(WidgetFeedReadingPlace.split(fresh, at: nil).runs.first?.items.first, arrival)
    }

    func testReplacingTheWindowAdoptsItsHeadAndHoldsTheNextArrival() {
        let replaced = WidgetInboxFeed.runs(Array(items.prefix(2)), by: "session") { _ in nil }
        let first = WidgetFeedReadingPlace.split(replaced, at: items[2])
        XCTAssertEqual(first.replacement, items[0])
        XCTAssertEqual(first.pending, 0)
        var next = items[0]
        next.id = "decision:next"
        next.at += 1
        let updated = WidgetInboxFeed.runs([next] + Array(items.prefix(2)), by: "session") { _ in nil }
        let held = WidgetFeedReadingPlace.split(updated, at: first.replacement)
        XCTAssertEqual(held.runs, replaced)
        XCTAssertEqual(held.pending, 1)
        XCTAssertNil(held.replacement)
    }

    func testMultiSessionProjectHeadersKeepRowSessionNamesAndHaveNoSessionShortcut() throws {
        let model = try makeModel()
        defer { model.stop() }
        let runs = WidgetInboxFeed.runs(items, by: "project") { model.session(forKey: $0.key)?.project }
        let run = try XCTUnwrap(runs.first { $0.sessionCount == 2 })
        let header = WidgetFeedRunHeader(run: run, model: model)
        XCTAssertEqual(header.subtitle, "2 sessions")
        XCTAssertNil(header.openInbox)
        let rows = WidgetFeedRow.rows([run], headers: model.preferences.inboxFeedHeaders).compactMap { row -> String? in
            guard case .item(let item, let context) = row, context == .projectHeader else { return nil }
            return model.session(forKey: item.key)?.title
        }
        XCTAssertEqual(rows, ["Beta", "Gamma"])
    }

    func testALoneRunKeepsItsRowIdentityWhenItGainsAHeader() throws {
        let lone = WidgetInboxFeed.runs([items[3]], by: "session") { _ in nil }
        let pair = WidgetInboxFeed.runs([items[3], items[4]], by: "session") { _ in nil }
        let before = WidgetFeedRow.rows(lone, headers: "groups")
        let after = WidgetFeedRow.rows(pair, headers: "groups")
        XCTAssertEqual(before.map(\.id), ["item/decision:d5"])
        XCTAssertEqual(after.map(\.id), ["header/" + pair[0].id, "item/decision:d5", "item/decision:d6"])
        guard case .item(_, let inline) = before[0], case .item(_, let grouped) = after[1] else { return XCTFail("rows") }
        XCTAssertEqual(inline, .inlineSource)
        XCTAssertEqual(grouped, .sessionHeader)
        XCTAssertEqual(WidgetFeedRow.rows(lone, headers: "all").map(\.id), ["header/" + lone[0].id, "item/decision:d5"])
    }

    func testTheOverviewShowsSingletonSourcesInTheirRowsAndGroupedItemsUnderOneHeader() throws {
        let size = CGSize(width: 460, height: 640)
        for order in ["session", "feed"] {
            let model = try makeModel(order: order)
            defer { model.stop() }
            let list = WidgetInboxOverview(model: model, viewport: { content in AnyView(ScrollView { content }) })
            let lines = try WidgetInboxRender.draw(list, size: size, name: order == "feed" ? "feed-after" : "feed-before")
            if order == "session" {
                XCTAssertTrue(lines.joined().contains("Alpha"), lines.description)
            } else {
                assertOrder(["Pick a basket", "Orchard", "Delivery note", "Meadow", "Sort the crates", "Meadow",
                             "Orchard", "Choose a shelf", "Choose a label"], in: lines)
            }
        }
    }

    func testEveryHeaderAndMixedProjectRowsKeepTheirSessionNames() throws {
        let model = try makeModel(headers: "all", runs: "project")
        defer { model.stop() }
        let list = WidgetInboxOverview(model: model, viewport: { content in AnyView(ScrollView { content }) })
        let lines = try WidgetInboxRender.draw(list, size: .init(width: 460, height: 640), name: "feed-project")
        assertOrder(["Orchard", "Pick a basket", "Meadow", "2 sessions", "Delivery note", "Beta",
                     "Sort the crates", "Gamma", "Orchard", "Choose a shelf", "Choose a label"], in: lines)
    }

    func testOverviewFilterAndOrderStayVisibleAfterScrollingANarrowFeed() throws {
        let rows = (0..<30).map { index in
            WidgetInboxItem(id: "answer:\(index)", sourceId: String(index), kind: "answer", key: alpha.key,
                            at: Double(30 - index) * 1000, needsAnswer: false, title: "Sample basket \(index)")
        }
        let model = try WidgetInboxRender.model(sessions: [alpha], items: rows)
        defer { model.stop() }
        let list = WidgetInboxOverview(model: model, viewport: { content in AnyView(ScrollView { content }) })
        let lines = try WidgetInboxRender.draw(list, size: CGSize(width: 324, height: 330), name: "feed-scrolled") { _, host in
            let scroll = try XCTUnwrap(Self.itemScroll(in: host))
            let document = try XCTUnwrap(scroll.documentView)
            // The lazy stack refines its document height as the last rows come into view.
            for _ in 0..<4 {
                let bottom = max(0, document.bounds.height - scroll.contentView.bounds.height)
                scroll.contentView.scroll(to: NSPoint(x: 0, y: bottom))
                scroll.reflectScrolledClipView(scroll.contentView)
                WidgetInboxRender.settle()
                if abs(document.bounds.height - scroll.contentView.bounds.height - scroll.contentView.bounds.origin.y) < 1 {
                    break
                }
            }
        }
        let text = lines.joined(separator: " ")
        for label in ["Waiting", "Unread", "Newest", "Sample basket 29"] {
            XCTAssertTrue(text.contains(label), text)
        }
    }

    func testCountBadgesOpenTheirOwnTabAndTheNormalEntryUsesTheSavedFilter() throws {
        let model = try makeModel()
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        let surface = WidgetSurfaceID(edge: .right)
        for filter in ["unread", "needs"] {
            model.toggleInboxOverview(on: surface, filter: filter)
            XCTAssertEqual(model.overviewFilterPick, filter)
            XCTAssertTrue(model.inboxOverview)
            XCTAssertEqual(model.preferences.overviewFilter, "all")
        }
        model.expanded = nil
        model.toggleInboxOverview(on: surface)
        XCTAssertNil(model.overviewFilterPick)
    }

    func testMarkAllReadCanBeUndoneAndOnlyClearsThroughTheOriginalClick() async throws {
        let model = try makeModel()
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        let initialSelectionSaved = await model.waitForShutdownMutations()
        XCTAssertTrue(initialSelectionSaved)
        var calls: [WidgetJSON] = []
        model.actionRunner = { value in calls.append(value); return ["ok": true] }
        model.markAllRead()
        XCTAssertNotNil(model.readThrough)
        model.undoMarkAllRead()
        model.commitMarkAllRead()
        XCTAssertNil(model.readThrough)
        let undoSettled = await model.waitForShutdownMutations()
        XCTAssertTrue(undoSettled)
        XCTAssertTrue(calls.isEmpty)
        model.markAllRead()
        let cutoff = try XCTUnwrap(model.readThrough)
        model.commitMarkAllRead()
        let drained = await model.waitForShutdownMutations()
        XCTAssertTrue(drained)
        XCTAssertEqual(calls, [["action": "inbox-clear", "at": .number(cutoff)]])
    }

    /// The Open Widget shortcut keeps the entry the reader opened in the hover list: it opens in its session.
    func testTheShortcutOpensTheHoverListsOpenEntryInItsSession() throws {
        let model = try makeModel()
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        let entry = try XCTUnwrap(model.inboxOverviewItems.first { $0.id == items[1].id })
        model.togglePreviewEntry(entry)
        model.openFromShortcut(on: WidgetSurfaceID(edge: .right))
        XCTAssertEqual(model.selectedCardID, entry.id)
        XCTAssertEqual(model.section, "Inbox")
        XCTAssertFalse(model.previewEntryOpen)
    }

    func testHoverSegmentsKeepTheSessionFilterWhenItemsIsSelected() throws {
        let model = try makeModel()
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        XCTAssertEqual(model.previewSegment, "active")
        model.choosePreviewSegment("items")
        XCTAssertEqual(model.previewView, "items")
        XCTAssertEqual(model.previewFilter, "active")
        XCTAssertEqual(model.previewSegment, "items")
        model.togglePreviewEntry(items[1])
        XCTAssertTrue(model.previewEntryOpen)
        XCTAssertTrue(model.dialogOpen)
        model.choosePreviewSegment("needs-you")
        XCTAssertFalse(model.previewEntryOpen)
        XCTAssertEqual(model.previewView, "sessions")
        XCTAssertEqual(model.previewFilter, "needs-you")
        model.choosePreviewSegment("items")
        XCTAssertEqual(model.previewFilter, "needs-you")
        model.choosePreviewSegment("active")
        XCTAssertEqual(model.previewView, "sessions")
        XCTAssertEqual(model.previewFilter, "active")
    }

    func testTheHoverListDrawsSessionRowsOrCompactFeedItemsAndKeepsItsFooter() throws {
        let size = CGSize(width: 480, height: 480)
        let surface = WidgetSurfaceID(edge: .right)
        let roster = try makeModel()
        defer { roster.stop() }
        let before = try WidgetInboxRender.draw(AgentWidgetPreview(model: roster, surface: surface), size: size)
            .joined(separator: " ")
        for word in ["Active too", "Alpha", "Beta", "Gamma", "3 sessions"] {
            XCTAssertTrue(before.localizedCaseInsensitiveContains(word), before)
        }
        XCTAssertFalse(before.contains("Whole inbox"), before)

        let model = try makeModel(view: "items")
        defer { model.stop() }
        var top: [String] = []
        let bottom = try WidgetInboxRender.draw(AgentWidgetPreview(model: model, surface: surface), size: size) { _, host in
            top = TreeDrawnText.placed(in: host).sorted { $0.middle < $1.middle }.map(\.text)
            let scroll = try XCTUnwrap(Self.itemScroll(in: host))
            // The hosting document is flipped. Move its clip to the last row even if there is no first responder.
            if let document = scroll.documentView {
                scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, document.bounds.height - scroll.contentView.bounds.height)))
                scroll.reflectScrolledClipView(scroll.contentView)
            }
        }
        XCTAssertTrue(top.joined(separator: " ").contains("Items"), top.description)
        assertOrder(["Pick a basket", "Orchard", "Delivery note", "Meadow", "Sort the crates"], in: top)
        assertOrder(["Sort the crates", "Meadow", "Orchard", "Choose a shelf", "Choose a label"], in: bottom)
        let text = (top + bottom).joined(separator: " ")
        XCTAssertFalse(text.localizedCaseInsensitiveContains("Working"), text)
        XCTAssertTrue(text.contains("3 sessions"), text)
    }

    func testPreviewTabsFitAtTheMinimumWidthInBothModes() throws {
        let size = CGSize(width: WidgetModel.previewWidthRange.lowerBound, height: 480)
        for mode in ["sessions", "items"] {
            let model = try makeModel(view: mode)
            model.livePreviewWidth = size.width
            defer { model.stop() }
            let lines = try WidgetInboxRender.draw(AgentWidgetPreview(model: model, surface: .init(edge: .right)), size: size)
            for label in ["Waiting for you", "Active too", "Items"] {
                XCTAssertTrue(lines.joined(separator: " ").contains(label), "\(mode): \(lines)")
            }
        }
    }

    func testClosingTheLastHoverHoldDismissesOnlyIfThePointerIsStillOut() throws {
        let model = try makeModel(view: "items")
        defer { model.stop() }
        let surface = WidgetSurfaceID(edge: .right)
        model.hoveredSurface = surface
        model.togglePreviewEntry(items[1])
        model.dialogOpen = true
        model.hover(surface, inside: false)
        model.closePreviewEntry()
        XCTAssertEqual(model.hoveredSurface, surface)
        model.dialogOpen = false
        WidgetInboxRender.waitFor("hover to dismiss after the dialog") { model.hoveredSurface == nil }

        model.hoveredSurface = surface
        model.dialogOpen = true
        model.hover(surface, inside: false)
        model.hover(surface, inside: true)
        model.dialogOpen = false
        WidgetInboxRender.settle()
        XCTAssertEqual(model.hoveredSurface, surface)
    }

    private static func itemScroll(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.lazy.compactMap { itemScroll(in: $0) }.first
    }

    func testTheHoverListOpensAnAnswerInPlace() throws {
        let answer = WidgetInboxItem(reply: .init(question: "When do we pick?", text: "Pick the pears today."),
                                    id: "answer:a", sourceId: "a", kind: "answer", key: alpha.key,
                                    at: 6000, needsAnswer: false, title: "When do we pick?")
        var prefs = WidgetPreferences.hubDefaults
        prefs.previewFilter = "active"
        let model = try WidgetInboxRender.model(sessions: [alpha, beta, gamma], items: [answer] + items, preferences: prefs)
        defer { model.stop() }
        let view = AgentWidgetPreview(model: model, surface: .init(edge: .right))
        let size = CGSize(width: 480, height: 480)
        _ = try WidgetInboxRender.draw(view, size: size, name: "hover-before")
        model.actionRunner = { _ in ["ok": true] }
        model.choosePreviewSegment("items")
        let lines = try WidgetInboxRender.draw(view, size: size, name: "hover-after") { _, _ in
            model.togglePreviewEntry(answer)
        }
        XCTAssertTrue(lines.contains("Answer"), lines.description)
        XCTAssertTrue(lines.joined(separator: " ").contains("Pick the pears today"), lines.description)
        XCTAssertTrue(lines.joined(separator: " ").contains("Open in its session"), lines.description)
    }

    /// Decision 30 a: the Items list also lists the messages and answers already read, grey and below the unread ones
    /// (a newer read message too), for the setting's hours. No count has them, and one still opens with its text.
    func testItemsListsReadMessagesBelowTheUnreadOnesAndCountsNone() throws {
        let readNote = WidgetInboxItem(message: .init(text: "The apples are in."), id: "answer:r1", sourceId: "r1",
                                       kind: "answer", key: beta.key, at: 4500, needsAnswer: false,
                                       title: "Apples delivered", tag: "message", read: true)
        let readAnswer = WidgetInboxItem(reply: .init(question: "Which crate?", text: "The red one."), id: "answer:r2",
                                         sourceId: "r2", kind: "answer", key: alpha.key, at: 900, needsAnswer: false,
                                         title: "Which crate?", read: true)
        var prefs = WidgetPreferences.hubDefaults
        prefs.previewView = "items"
        XCTAssertEqual(prefs.previewReadHours, 24, "the default keeps a day of read items")
        let model = try WidgetInboxRender.model(sessions: [alpha, beta, gamma], items: [items[1]],
                                                read: [readNote, readAnswer], preferences: prefs)
        defer { model.stop() }
        XCTAssertEqual(model.inboxFeeds.all.flatMap(\.items).map(\.id), ["answer:m"])
        XCTAssertEqual(model.inboxFeeds.read.flatMap(\.items).map(\.id), ["answer:r1", "answer:r2"])
        XCTAssertEqual(model.inboxFeeds["unread"].flatMap(\.items).map(\.id), ["answer:m"])
        XCTAssertEqual(model.inbox.unread, 1, "the read items add nothing to the unread count")
        XCTAssertEqual(model.inboxCount, 1, "nor to what Mark all read acts on")
        XCTAssertFalse(readNote.isUnreadEntry)
        XCTAssertEqual(WidgetInboxOverview.kindLabel(readNote), "Message")
        XCTAssertEqual(WidgetInboxOverview.kindLabel(readAnswer), "Answer")
        XCTAssertEqual(WidgetInboxOverview.kindLabel(items[1]), "New message")

        let view = AgentWidgetPreview(model: model, surface: .init(edge: .right))
        let size = CGSize(width: 480, height: 560)
        var placed: [String] = []
        _ = try WidgetInboxRender.draw(view, size: size, name: "hover-read-items") { _, host in
            placed = TreeDrawnText.placed(in: host).sorted { $0.middle < $1.middle }.map(\.text)
        }
        assertOrder(["Delivery note", "last 24 hours", "2 items", "Apples delivered", "Which crate?"], in: placed)

        model.actionRunner = { _ in ["ok": true] }
        model.togglePreviewEntry(readNote)
        try WidgetInboxRender.receive(model, sessions: [alpha, beta, gamma], items: [items[1]],
                                      read: [readNote, readAnswer], preferences: prefs)
        XCTAssertEqual(model.previewItem(id: readNote.id), readNote, "a new snapshot keeps the open read item")
        let opened = try WidgetInboxRender.draw(view, size: size).joined(separator: " ")
        XCTAssertTrue(opened.contains("The apples are in."), opened)

        prefs.previewReadHours = 0
        let none = try WidgetInboxRender.model(sessions: [alpha, beta, gamma], items: [items[1]], read: [readNote],
                                               preferences: prefs)
        defer { none.stop() }
        XCTAssertTrue(none.inboxFeeds.read.isEmpty, "None lists no read items")
    }

    func testTheReadWindowNamesItsHoursAndOffersAStoredValue() {
        XCTAssertEqual(WidgetReadItemsHeader.window(24), "24 hours")
        XCTAssertEqual(WidgetReadItemsHeader.window(1), "1 hour")
        XCTAssertEqual(WidgetReadItemsHeader.window(72), "3 days")
        XCTAssertEqual(WidgetReadItemsHeader.choices(current: 24), [0, 6, 24, 72, 168])
        XCTAssertEqual(WidgetReadItemsHeader.choices(current: 12), [0, 6, 12, 24, 72, 168])
        XCTAssertEqual(WidgetReadItemsHeader.choices(current: 0), [0, 6, 24, 72, 168])
    }

    /// A session named after its only item (an agent result) names it once, in the row; another title stays in the header.
    func testARunHeaderDoesNotRepeatItsOnlyItemsTitle() throws {
        let named = WidgetInboxRender.session("crates", project: "Meadow")
        let item = WidgetInboxItem(id: "result:r", sourceId: "r", kind: "result", key: named.key, at: 1000,
                                   needsAnswer: false, title: named.title)
        let model = try WidgetInboxRender.model(sessions: [named, gamma], items: [item], preferences: .hubDefaults)
        defer { model.stop() }
        let run = WidgetFeedRun(id: "r", runKey: named.key, items: [item])
        XCTAssertNil(WidgetFeedRunHeader(run: run, model: model).subtitle)
        XCTAssertEqual(WidgetFeedRunHeader(run: run, model: model).counts, "", "one item says what it is in its own row")
        var other = item
        other.title = "Sort the crates"
        let otherRun = WidgetFeedRun(id: "o", runKey: named.key, items: [other])
        XCTAssertEqual(WidgetFeedRunHeader(run: otherRun, model: model).subtitle, named.title)
    }

    /// A session's inbox row and the inbox of every session draw one head: for one decision both values name the same
    /// title, kind, waiting state and time, and each keeps its own identifier.
    func testACardAndItsItemDrawTheSameHead() {
        let card = WidgetCard(id: "decision:d1", kind: "decision", sessionKey: alpha.key, sourceId: "d1", at: 5000,
                              title: "Pick a basket", body: "", status: "open", number: 1,
                              choices: [.init(id: "a", title: "Wicker", recommended: true)], attachments: [], refs: [],
                              read: false)
        let fromItem = WidgetRowHeadValue(item: WidgetModel.inboxItem(card), source: nil)
        let fromCard = WidgetRowHeadValue(card: card, staged: false)
        XCTAssertEqual(fromItem.title, "Decision 1: Pick a basket")
        XCTAssertEqual(fromCard.title, fromItem.title)
        XCTAssertEqual(fromCard.kind, fromItem.kind)
        XCTAssertTrue(fromCard.needsAnswer)
        XCTAssertEqual(fromCard.needsAnswer, fromItem.needsAnswer)
        XCTAssertEqual(fromCard.at, fromItem.at)
        XCTAssertEqual(fromCard.dotLit, fromItem.dotLit, "an unread waiting decision has its dot in both")
        XCTAssertEqual(fromItem.identifierPrefix, "widget.overview.row.")
        XCTAssertEqual(fromCard.identifierPrefix, "widget.inbox.row.")
    }

    /// The screenshot bug of 2026-11-25: a one-letter pick staged from the hover list's Items tab had no Send and no
    /// Unstage there, only "Open in its session". The open entry sends and unstages it in place.
    func testAStagedPickInTheHoverItemsHasItsOwnSendAndUnstage() throws {
        var staged = WidgetInboxItem(id: "decision:d1", sourceId: "d1", kind: "decision", key: alpha.key, at: 5000,
                                     needsAnswer: true, title: "Pick a basket", number: 1,
                                     options: ["a) Wicker", "b) Crate", "c) Sack"])
        staged.draftOption = "b"
        var prefs = WidgetPreferences.hubDefaults
        prefs.previewView = "items"
        let model = try WidgetInboxRender.model(sessions: [alpha], items: [staged], preferences: prefs)
        defer { model.stop() }
        var calls: [WidgetJSON] = []
        model.actionRunner = { value in calls.append(value); return ["ok": true] }
        model.togglePreviewEntry(staged)
        let send = DecisionAnswering.sendTitle("b", multiple: false)
        let (window, host) = Self.clickableHost(AgentWidgetPreview(model: model, surface: .init(edge: .right)),
                                                size: CGSize(width: 480, height: 560))
        defer { window.close() }
        WidgetInboxRender.settle()
        let drawn = Self.recognized(host)
        XCTAssertTrue(drawn.contains { $0.text.contains("Crate") }, "the entry is open: \(drawn.map(\.text))")
        do {
            guard let unstage = drawn.first(where: { $0.text == "Unstage" }) else {
                return XCTFail("no Unstage in \(drawn.map(\.text))")
            }
            Self.click(unstage.box, in: window, host: host)
            WidgetInboxRender.settle()
            XCTAssertTrue(model.heldDecisionIDs.contains("d1"), "Unstage holds the discard, with its Undo note")
            model.undoHeldDiscard()
            WidgetInboxRender.settle()
            guard let button = Self.recognized(host).first(where: { $0.text.contains(send) }) else {
                return XCTFail("no \(send) in \(Self.recognized(host).map(\.text))")
            }
            Self.click(button.box, in: window, host: host)
            WidgetInboxRender.settle()
            XCTAssertTrue(model.sendingDecisionIDs.contains("d1") || !calls.isEmpty, "Send reaches sendStaged")
        }
    }

    /// An incomplete inbox is a read that failed: the hover list offers Try again, as the expanded view's Reconnect.
    func testAnIncompleteInboxOffersTryAgainInTheHoverList() throws {
        var prefs = WidgetPreferences.hubDefaults
        prefs.previewView = "items"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.fixture." + UUID().uuidString))
        let model = WidgetModel(binaryPath: "/usr/bin/true",
            stateRoot: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: UUID().uuidString, observeExternalChanges: false))
        defer { model.stop() }
        let summary = WidgetInboxSummary(unread: 0, needsAnswer: 0, complete: false, truncated: false, sessions: [])
        let state = WidgetState(version: 1, revision: 1, preferences: prefs, assets: [:], drafts: [:], outgoing: [])
        let snapshot = WidgetSnapshot(notifications: summary, version: 1, state: state, sessions: [alpha], cards: [],
                                      manifests: [:], errors: [])
        model.receive([try XCTUnwrap(String(bytes: try JSONEncoder().encode(snapshot), encoding: .utf8))])
        XCTAssertFalse(model.inbox.complete)
        let lines = try WidgetInboxRender.draw(AgentWidgetPreview(model: model, surface: .init(edge: .right)),
                                               size: CGSize(width: 480, height: 480)).joined(separator: " ")
        XCTAssertTrue(lines.contains("Inbox status unavailable"), lines)
        XCTAssertTrue(lines.contains("Try again"), lines)
    }

    /// A window that takes window-local clicks, so a test presses a drawn button without the pointer.
    static func clickableHost(_ view: some View, size: CGSize) -> (NSWindow, NSView) {
        let contents = view.padding(8).frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(NativeThemePalette.graphiteBase).environment(\.colorScheme, .dark)
        let host = NSHostingView(rootView: contents)
        let window = NSPanel(contentRect: NSRect(x: -10000, y: -10000, width: size.width, height: size.height),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.contentView = host
        window.order(.below, relativeTo: 0)
        window.displayIfNeeded()
        host.layoutSubtreeIfNeeded()
        return (window, host)
    }

    /// Each drawn line with its box in the view's own points, bottom-left origin.
    static func recognized(_ host: NSView) -> [(text: String, box: CGRect)] {
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return [] }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let image = bitmap.cgImage else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { line in
            guard let text = line.topCandidates(1).first?.string else { return nil }
            let box = line.boundingBox
            return (text, CGRect(x: box.minX * host.bounds.width, y: box.minY * host.bounds.height,
                                 width: box.width * host.bounds.width, height: box.height * host.bounds.height))
        }
    }

    static func click(_ box: CGRect, in window: NSWindow, host: NSView) {
        let location = host.convert(NSPoint(x: box.midX, y: host.isFlipped ? host.bounds.height - box.midY : box.midY),
                                    to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
            window.sendEvent(event)
        }
    }

    private func assertOrder(_ labels: [String], in lines: [String], file: StaticString = #filePath, line: UInt = #line) {
        let text = lines.joined(separator: " ")
        var rest = text[...]
        for label in labels {
            guard let range = rest.range(of: label, options: .caseInsensitive) else {
                XCTFail("Missing or out of order: \(label) in \(text)", file: file, line: line)
                return
            }
            rest = rest[range.upperBound...]
        }
    }
}
