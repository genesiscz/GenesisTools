import AppKit
import SwiftUI
import XCTest
@testable import GenesisKitBase

/// The autocomplete field's matching, its list state and the folder completion behind `AutocompleteFolderField`.
@MainActor
final class AutocompleteFieldTests: XCTestCase {
    private let calendars = ["Work", "Home", "Team work", "Homework", "Žluťoučký kůň"].map { AutocompleteValue($0) }

    func testATitleThatStartsWithTheTextComesFirstThenAWordThenTheRest() {
        let ranked = AutocompleteMatch.ranked(calendars, query: "wo").map(\.title)
        XCTAssertEqual(ranked, ["Work", "Team work", "Homework"])
        XCTAssertEqual(AutocompleteMatch.ranked(calendars, query: "").count, calendars.count, "no text lists everything")
        XCTAssertEqual(AutocompleteMatch.ranked(calendars, query: "zlut").map(\.title), ["Žluťoučký kůň"], "accents do not count")
        XCTAssertEqual(AutocompleteMatch.ranked(calendars, query: "x"), [])
    }

    func testTheTypedPartIsFoundInTheTitlesOwnCharacters() throws {
        let title = "Team Work"
        let range = try XCTUnwrap(AutocompleteMatch.range(in: title, of: "wor"))
        XCTAssertEqual(String(title[range]), "Wor")
        XCTAssertNil(AutocompleteMatch.range(in: title, of: "  "))
    }

    func testDownMarksTheFirstRowAndStopsAtTheLastAndEscapeThenDownOpensAgain() {
        let model = AutocompleteModel<AutocompleteValue>()
        model.focus(true)
        model.move(1, count: 3)
        XCTAssertEqual(model.marked, 0)
        model.move(1, count: 3)
        model.move(1, count: 3)
        model.move(1, count: 3)
        XCTAssertEqual(model.marked, 2, "the mark stops at the last row")
        model.move(-1, count: 3)
        XCTAssertEqual(model.marked, 1)
        model.dismiss()
        XCTAssertTrue(model.dismissed)
        XCTAssertNil(model.marked)
        model.move(1, count: 3)
        XCTAssertFalse(model.dismissed, "Down opens a list Escape closed")
        model.move(-1, count: 3)
        XCTAssertEqual(model.marked, 2, "Up on an unmarked list marks the last row")
    }

    func testATakenValueClosesTheListAndTabKeepsItOpen() {
        let model = AutocompleteModel<AutocompleteValue>()
        XCTAssertFalse(model.isOpen, "no keyboard, no list")
        model.focus(true)
        XCTAssertTrue(model.isOpen)
        model.took(.click)
        XCTAssertFalse(model.isOpen, "a click on a row closes the list")
        model.changedOutside()
        XCTAssertFalse(model.isOpen, "the caller clearing the taken text does not open it again")
        model.typed()
        XCTAssertTrue(model.isOpen, "typing opens it again")
        model.took(.returnKey)
        XCTAssertFalse(model.isOpen, "Return closes it")
        model.move(1, count: 3)
        XCTAssertTrue(model.isOpen, "Down opens it again")
        model.marked = 1
        model.took(.tab)
        XCTAssertTrue(model.isOpen, "Tab completes and goes on, so the folder field lists the next level")
        XCTAssertNil(model.marked)
        model.dismiss()
        XCTAssertFalse(model.isOpen, "Escape, a lost keyboard or a field scrolled out of sight close it")
        model.focus(true)
        model.focus(false)
        XCTAssertFalse(model.isOpen, "the field lost the keyboard")
    }

    // MARK: The floating list

    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 875)

    func testTheFloatingListGoesUnderTheFieldWithTheLeftEdgesEqual() {
        let field = CGRect(x: 100, y: 500, width: 300, height: 22)
        let frame = AutocompletePlacement.frame(field: field, visible: screen, size: CGSize(width: 300, height: 150))
        XCTAssertEqual(frame, CGRect(x: 100, y: 500 - 4 - 150, width: 300, height: 150))
    }

    func testTheFloatingListOpensAboveWhenTheRoomBelowIsTooSmall() {
        let field = CGRect(x: 100, y: 100, width: 300, height: 22)
        let frame = AutocompletePlacement.frame(field: field, visible: screen, size: CGSize(width: 300, height: 150))
        XCTAssertEqual(frame.minY, 122 + 4, "the room below (96 pt) is too small for 150 pt")
        XCTAssertEqual(frame.minX, 100)
        let fits = AutocompletePlacement.frame(field: field, visible: screen, size: CGSize(width: 300, height: 90))
        XCTAssertEqual(fits.maxY, 100 - 4, "a list that fits below stays below")
    }

    func testTheFloatingListIsNeverNarrowerThan220AndStaysOnTheScreen() {
        let narrow = CGRect(x: 40, y: 500, width: 120, height: 22)
        XCTAssertEqual(AutocompletePlacement.frame(field: narrow, visible: screen, size: CGSize(width: 0, height: 80)).width, 220)
        let atTheRightEdge = CGRect(x: 1300, y: 500, width: 120, height: 22)
        let right = AutocompletePlacement.frame(field: atTheRightEdge, visible: screen, size: CGSize(width: 0, height: 80))
        XCTAssertEqual(right.maxX, screen.maxX, "pulled back onto the screen")
        XCTAssertEqual(right.width, 220)
        let leftOfTheScreen = CGRect(x: -50, y: 500, width: 300, height: 22)
        XCTAssertEqual(AutocompletePlacement.frame(field: leftOfTheScreen, visible: screen, size: CGSize(width: 0, height: 80)).minX, 0)
    }

    func testWhenNeitherSideHasRoomTheListOpensOnTheSideWithMoreRoom() {
        let small = CGRect(x: 0, y: 0, width: 800, height: 300)
        let low = AutocompletePlacement.frame(field: CGRect(x: 10, y: 100, width: 300, height: 22), visible: small,
                                              size: CGSize(width: 0, height: 250))
        XCTAssertEqual(low.minY, 126, "174 pt above against 96 below")
        let high = AutocompletePlacement.frame(field: CGRect(x: 10, y: 200, width: 300, height: 22), visible: small,
                                               size: CGSize(width: 0, height: 250))
        XCTAssertEqual(high.maxY, 196, "196 pt below against 74 above")
    }

    func testAFieldScrolledEvenPartlyOutOfItsScrollViewHasNoList() {
        let clip = CGRect(x: 0, y: 0, width: 400, height: 300)
        XCTAssertTrue(AutocompletePlacement.isVisible(CGRect(x: 10, y: 10, width: 200, height: 22), in: [clip]))
        XCTAssertTrue(AutocompletePlacement.isVisible(CGRect(x: 10, y: 10, width: 200, height: 22), in: []), "no scroll view")
        XCTAssertFalse(AutocompletePlacement.isVisible(CGRect(x: 10, y: -5, width: 200, height: 22), in: [clip]))
        XCTAssertFalse(AutocompletePlacement.isVisible(CGRect(x: 10, y: 10, width: 200, height: 22),
                                                       in: [clip, CGRect(x: 0, y: 20, width: 400, height: 100)]),
                       "an outer scroll view cuts it")
    }

    /// Nothing in the page moves: with the list floating, the field is as tall open as closed. The in-page list is the
    /// control: it makes the field taller.
    func testTheFieldHasTheSameHeightWithTheFloatingListOpenOrClosed() {
        func height(_ presentation: AutocompletePresentation, open: Bool) -> CGFloat {
            let field = AutocompleteField("Add a calendar", text: .constant("wo"), items: calendars,
                                          preview: open ? AutocompletePreview(marked: 0) : nil,
                                          presentation: presentation) { _ in }
            return NSHostingView(rootView: field.frame(width: 300)).fittingSize.height
        }
        let closed = height(.floating, open: false)
        XCTAssertGreaterThan(closed, 10)
        XCTAssertEqual(height(.floating, open: true), closed)
        XCTAssertGreaterThan(height(.inPage, open: true), closed + 40, "the in-page list pushes the page down")
    }

    /// The panel in a real window that never reaches the screen: a child of the field's window, under the field, made
    /// on the first open, closed by a lost keyboard, the app going to the background and a scroll, opened again each
    /// time, and gone with the field.
    func testTheFloatingPanelIsAChildOfTheFieldsWindowAndClosesByItself() throws {
        let window = NSWindow(contentRect: NSRect(x: 200, y: 300, width: 400, height: 300), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.isReleasedWhenClosed = false
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 1000))
        let field = NSTextField(frame: NSRect(x: 30, y: 900, width: 120, height: 22))
        document.addSubview(field)
        scroll.documentView = document
        window.contentView = scroll
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 700))
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }

        let list = AutocompleteFloatingList()
        var closes = 0
        list.onClose = { closes += 1 }
        list.attach(field)
        XCTAssertNil(list.panel, "no panel for a field whose list never opened")
        let content = AnyView(Color.gray.frame(height: 60))

        func open() throws -> AutocompleteListPanel {
            list.update(content, reduceMotion: true)
            let panel = try XCTUnwrap(list.panel)
            XCTAssertTrue(list.isShown)
            XCTAssertTrue(window.childWindows?.contains(panel) == true, "a child of the field's window")
            return panel
        }
        func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }

        let panel = try open()
        let fieldOnScreen = window.convertToScreen(field.convert(field.bounds, to: nil))
        XCTAssertEqual(list.listFrame.minX, fieldOnScreen.minX, accuracy: 0.5, "left edges equal")
        XCTAssertEqual(list.listFrame.maxY, fieldOnScreen.minY - AutocompletePlacement.gap, accuracy: 0.5, "under the field")
        XCTAssertEqual(list.listFrame.width, 220, "never narrower than 220 pt")
        XCTAssertEqual(list.listFrame.height, 60, accuracy: 0.5, "as tall as its content")
        XCTAssertEqual(panel.frame, list.listFrame, "the shadow must not add an invisible window that intercepts page clicks")
        XCTAssertTrue(panel.hasShadow, "the window server draws outside the interactive panel bounds")
        XCTAssertEqual(panel.frame.maxY, list.listFrame.maxY, accuracy: 0.5, "no room toward the field: it never covers it")
        XCTAssertEqual(panel.alphaValue, 0, "a child shares its window's alpha: this window is off screen")
        XCTAssertFalse(panel.canBecomeKey)

        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: window)
        settle()
        XCTAssertFalse(list.isShown, "the window stopped being key")
        XCTAssertEqual(closes, 1)
        XCTAssertTrue(window.childWindows?.isEmpty ?? true)

        XCTAssertTrue(try open() === panel, "one panel per field, opened again")
        NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: NSApp)
        settle()
        XCTAssertFalse(list.isShown, "the app went to the background")
        XCTAssertEqual(closes, 2)

        _ = try open()
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 660))
        settle()
        XCTAssertTrue(list.isShown, "a scroll that keeps the field in sight moves the list with it")
        let moved = window.convertToScreen(field.convert(field.bounds, to: nil))
        XCTAssertEqual(list.listFrame.maxY, moved.minY - AutocompletePlacement.gap, accuracy: 0.5)
        XCTAssertEqual(panel.frame.maxY, list.listFrame.maxY, accuracy: 0.5)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 400))
        settle()
        XCTAssertFalse(list.isShown, "the field scrolled out of sight")
        XCTAssertEqual(closes, 3)
        list.update(content, reduceMotion: true)
        XCTAssertFalse(list.isShown, "a field out of sight does not open its list")
        XCTAssertEqual(closes, 4)

        scroll.contentView.scroll(to: NSPoint(x: 0, y: 700))
        settle()
        _ = try open()
        list.update(nil, reduceMotion: true)
        XCTAssertFalse(list.isShown, "Escape or a taken value hide it")
        XCTAssertEqual(closes, 4, "a close the field asked for is not reported back")

        _ = try open()
        list.tearDown()
        XCTAssertNil(list.panel, "the panel goes with the field")
        XCTAssertTrue(window.childWindows?.isEmpty ?? true)
    }

    func testALazyListIsReadOnceAndAFailureKeepsItsSentenceUntilRetry() async throws {
        let model = AutocompleteModel<AutocompleteValue>()
        let reads = Counter()
        let source = AutocompleteSource<AutocompleteValue>.lazyItems {
            await reads.add()
            if await reads.value == 1 { throw AutocompleteFailure("The list could not be read.") }
            return [AutocompleteValue("Work")]
        }
        model.need(source, text: "")
        try await waitUntil { if case .failed = model.phase { return true } else { return false } }
        XCTAssertEqual(model.phase, .failed("The list could not be read."))
        model.need(source, text: "w")
        let afterFailure = await reads.value
        XCTAssertEqual(afterFailure, 1, "a failed read is not asked again by typing, only by Retry")
        model.retry(source, text: "")
        try await waitUntil { model.phase == .loaded }
        XCTAssertEqual(model.answered?.map(\.title), ["Work"])
        model.need(source, text: "wo")
        let total = await reads.value
        XCTAssertEqual(total, 2, "a read list is kept")
    }

    func testASearchIsAskedPerTextAndAnOlderCallIsCancelled() async throws {
        let model = AutocompleteModel<AutocompleteValue>()
        let asked = Counter()
        let source = AutocompleteSource<AutocompleteValue>.search { text in
            await asked.add()
            return [AutocompleteValue("answer for \(text)")]
        }
        model.need(source, text: "a")
        model.need(source, text: "ab")
        try await waitUntil { model.phase == .loaded }
        XCTAssertEqual(model.answered?.map(\.title), ["answer for ab"])
        let count = await asked.value
        XCTAssertEqual(count, 1, "the first text was replaced within the pause, so only the second was asked")
    }

    // MARK: Folders

    private func scratchHome() throws -> String {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("autocomplete-folder-\(UUID().uuidString)")
        for name in ["Notes/acme", "Notes/Meetings", "Projects", ".config", "Viewer.app"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true)
        }
        FileManager.default.createFile(atPath: root.appendingPathComponent("notes.txt").path, contents: Data())
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root.path
    }

    func testATypedPathSplitsIntoTheFolderToListAndTheStartOfAName() {
        let home = "/Users/alice"
        XCTAssertEqual(FolderCompletion.split("", home: home), .init(folder: home + "/", prefix: "", typedParent: "~/"))
        XCTAssertEqual(FolderCompletion.split("~", home: home), .init(folder: home + "/", prefix: "", typedParent: "~/"))
        XCTAssertEqual(FolderCompletion.split("~/No", home: home), .init(folder: "/Users/alice/", prefix: "No", typedParent: "~/"))
        XCTAssertEqual(FolderCompletion.split("/tmp/x", home: home), .init(folder: "/tmp/", prefix: "x", typedParent: "/tmp/"))
        XCTAssertEqual(FolderCompletion.absolute("~/Notes/", home: home), "/Users/alice/Notes")
        XCTAssertEqual(FolderCompletion.absolute("/", home: home), "/")
    }

    func testFoldersCompleteFromTheHomeFolderAndHiddenOnesOnlyAfterADot() throws {
        let home = try scratchHome()
        XCTAssertEqual(try FolderCompletion.folders(for: "~/", home: home).map(\.title), ["~/Notes", "~/Projects"],
                       "no file, no package, no hidden folder")
        XCTAssertEqual(try FolderCompletion.folders(for: "~/no", home: home).map(\.title), ["~/Notes"])
        XCTAssertEqual(try FolderCompletion.folders(for: "~/Notes/", home: home).map(\.title), ["~/Notes/acme", "~/Notes/Meetings"])
        XCTAssertEqual(try FolderCompletion.folders(for: "~/.", home: home).map(\.title), ["~/.config"])
        XCTAssertEqual(try FolderCompletion.folders(for: "~/Missing/", home: home), [], "a folder that is not there has no folders")
    }

    func testAFolderMacOSKeepsFromTheAppIsASentenceNotAnEmptyList() {
        let denied = NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError,
                             userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM))])
        let failure = FolderCompletion.failure(denied, folder: "/Users/alice/Documents", typed: "~/Documents/")
        XCTAssertTrue(failure.sentence.hasPrefix("macOS does not let this app read “Documents”."), failure.sentence)
        let other = FolderCompletion.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(EIO)), folder: "/Volumes/X", typed: "/Volumes/X/")
        XCTAssertTrue(other.sentence.hasPrefix("The folders in “X” could not be read"), other.sentence)
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !condition() {
            guard Date() < deadline else { return XCTFail("timed out") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

private actor Counter {
    private(set) var value = 0
    func add() { value += 1 }
}
