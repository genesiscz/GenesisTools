import XCTest
@testable import GenesisKit

/// The find panel's model behaviour: remembered options, Enter and
/// Shift+Enter, find in selection, ⌘F taking the selection, and the counts of
/// "find in all open tabs". Real documents on disk, no window.
@MainActor
final class MarkdownFindModelTests: XCTestCase {
    private var dir: URL!
    private var suite: String!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-find-model-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        suite = "md-find-model-\(UUID().uuidString)"
    }

    override func tearDown() async throws {
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ name: String, _ text: String) throws -> URL {
        let url = dir.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func model() -> MarkdownDocumentsModel {
        MarkdownDocumentsModel(defaults: UserDefaults(suiteName: suite)!)
    }

    /// A source-view model with one note open and the panel open.
    private func sourceModel(_ text: String = "alpha beta alpha\nGamma ALPHA\n") throws -> MarkdownDocumentsModel {
        let m = model()
        m.open([try write("notes/plan.md", text)])
        m.setMode(.source)
        m.openFind()
        return m
    }

    func testTheThreeOptionsAreRememberedBetweenLaunches() {
        let first = model()
        XCTAssertEqual(first.findOptions, MarkdownFindOptions())
        first.findOptions.matchCase = true
        first.findOptions.regex = true
        let defaults = UserDefaults(suiteName: suite)!
        XCTAssertTrue(defaults.bool(forKey: "markdownWindow.find.matchCase"))
        XCTAssertFalse(defaults.bool(forKey: "markdownWindow.find.wholeWord"))
        XCTAssertTrue(defaults.bool(forKey: "markdownWindow.find.regex"))

        let next = model()
        XCTAssertEqual(next.findOptions, MarkdownFindOptions(matchCase: true, regex: true))
        // Find in selection is not one of them.
        next.findInSelection = true
        XCTAssertFalse(model().findInSelection)
    }

    func testAnOptionChangeRunsTheSearchAgain() throws {
        let m = try sourceModel()
        m.findQuery = "alpha"
        m.search()
        XCTAssertEqual(m.findCount, 3)
        m.findOptions.matchCase = true
        XCTAssertEqual(m.findCount, 2)
        m.findOptions.wholeWord = true
        m.findQuery = "alph"
        m.search()
        XCTAssertEqual(m.findCount, 0)
    }

    func testEnterWalksForwardAndShiftEnterBack() throws {
        let m = try sourceModel()
        m.findQuery = "alpha"
        m.search()
        XCTAssertEqual(m.findIndex, 1)
        m.submitFind(shift: false)
        XCTAssertEqual(m.findIndex, 2)
        XCTAssertEqual(m.sourceSelection?.range, NSRange(location: 11, length: 5))
        m.submitFind(shift: true)
        XCTAssertEqual(m.findIndex, 1)
        // Back from the first wraps to the last.
        m.submitFind(shift: true)
        XCTAssertEqual(m.findIndex, 3)
        XCTAssertEqual(m.sourceSelection?.range, NSRange(location: 23, length: 5))
        // ⌘G and ⇧⌘G are the same walk.
        m.stepFind(1)
        XCTAssertEqual(m.findIndex, 1)
    }

    func testAnInvalidRegexMarksNothingAndTheCounterSaysWhy() throws {
        let m = try sourceModel()
        m.findOptions.regex = true
        m.findQuery = "alpha("
        m.search()
        XCTAssertEqual(m.findCount, 0)
        XCTAssertEqual(m.findPatternError, "invalid regex")
        XCTAssertEqual(m.findCommand.query, "")
        // A pattern only the page refuses comes back as index -1.
        m.findQuery = "alpha"
        m.search()
        XCTAssertNil(m.findPatternError)
        m.findIndex = -1
        XCTAssertEqual(m.findPatternError, "invalid regex")
    }

    func testTheWebCommandCarriesTheOptionsAndTheScope() throws {
        let m = model()
        m.open([try write("notes/plan.md", "alpha")])
        m.setMode(.preview)
        m.openFind()
        m.findQuery = "alpha"
        m.findOptions.wholeWord = true
        var command = m.findCommand
        XCTAssertEqual(command.query, "alpha")
        XCTAssertEqual(command.options, MarkdownFindOptions(wholeWord: true))
        XCTAssertNil(command.scope)
        XCTAssertEqual(command.scrollbarMarks, GenesisKitMarkdownConfiguration.shared.scrollbarMatchMarks)

        m.setFindInSelection(true)
        command = m.findCommand
        let first = try XCTUnwrap(command.scope)
        // Off and on again takes the selection of that new moment.
        m.setFindInSelection(false)
        XCTAssertNil(m.findCommand.scope)
        m.setFindInSelection(true)
        XCTAssertNotEqual(m.findCommand.scope, first)
        XCTAssertTrue(command.jsOptions.contains("wholeWord:true"))
        XCTAssertTrue(command.jsOptions.contains("scope:\(first)"))
    }

    func testFindInSelectionKeepsToTheReadersSelectionAndReplacesInsideIt() throws {
        let text = "alpha one\nalpha two\nalpha three\n"
        let m = try sourceModel(text)
        let id = try XCTUnwrap(m.selected?.id)
        // The reader selects the middle line.
        let middle = (text as NSString).range(of: "alpha two")
        m.editorSelectionChanged(middle, byUser: true, in: id)
        m.findQuery = "alpha"
        m.search()
        XCTAssertEqual(m.findCount, 3)
        // Find selects a match itself: that selection must not become the scope.
        m.editorSelectionChanged(NSRange(location: 0, length: 5), byUser: false, in: id)

        m.setFindInSelection(true)
        XCTAssertEqual(m.activeSourceScope, middle)
        XCTAssertEqual(m.findCount, 1)
        XCTAssertEqual(m.findIndex, 1)
        XCTAssertEqual(m.sourceSelection?.range, NSRange(location: middle.location, length: 5))

        m.replaceText = "omega-omega"
        m.replaceCurrent()
        XCTAssertEqual(m.selected?.displayText, "alpha one\nomega-omega two\nalpha three\n")
        // The scope grew with the longer replacement and still ends at the line's end.
        XCTAssertEqual(m.activeSourceScope, NSRange(location: middle.location, length: middle.length + 6))

        m.findQuery = "o"
        m.search()
        // The two in "omega-omega" and the one in "two"; the "o" of "one" is outside.
        XCTAssertEqual(m.findCount, 3)
        m.replaceText = "0"
        m.replaceAll()
        XCTAssertEqual(m.selected?.displayText, "alpha one\n0mega-0mega tw0\nalpha three\n")

        // Off: the whole text again.
        m.setFindInSelection(false)
        m.findQuery = "alpha"
        m.search()
        XCTAssertEqual(m.findCount, 2)
    }

    func testDeletingTheLastSelectedMatchKeepsAnEmptyScope() throws {
        for replaceAllFirst in [false, true] {
            let m = try sourceModel("alpha alpha alpha")
            let doc = try XCTUnwrap(m.selected)
            m.editorSelectionChanged(NSRange(location: 6, length: 5), byUser: true, in: doc.id)
            m.findQuery = "alpha"
            m.setFindInSelection(true)
            XCTAssertEqual(m.findCount, 1)
            m.replaceText = ""
            if replaceAllFirst { m.replaceAll() } else { m.replaceCurrent() }
            XCTAssertEqual(doc.displayText, "alpha  alpha")
            XCTAssertTrue(m.findInSelection)
            XCTAssertEqual(m.activeSourceScope, NSRange(location: 6, length: 0))
            m.search()
            XCTAssertEqual(m.findCount, 0)
            m.replaceText = "outside must stay"
            m.replaceCurrent()
            m.replaceAll()
            XCTAssertEqual(doc.displayText, "alpha  alpha")
            m.setFindInSelection(false)
            XCTAssertNil(m.activeSourceScope)
            XCTAssertEqual(m.findCount, 2, "turning selection mode off restores whole-file search")
        }
    }

    /// Split view: the preview marks too, but its tally must not replace the
    /// editor's (it counts the whole page, the editor counts the selection).
    func testInSplitViewTheEditorOwnsTheCounter() throws {
        let m = try sourceModel()
        m.setMode(.split)
        m.findQuery = "alpha"
        m.search()
        XCTAssertEqual(m.findCount, 3)
        m.webFindResult(index: 1, count: 7)
        XCTAssertEqual(m.findCount, 3)
        m.setMode(.preview)
        m.webFindResult(index: 2, count: 7)
        XCTAssertEqual(m.findIndex, 2)
        XCTAssertEqual(m.findCount, 7)
    }

    func testFindInSelectionWithNothingSelectedSearchesEverything() throws {
        let m = try sourceModel()
        m.findQuery = "alpha"
        m.setFindInSelection(true)
        XCTAssertNil(m.activeSourceScope)
        XCTAssertEqual(m.findCount, 3)
        // Closing forgets it.
        m.closeFind()
        XCTAssertFalse(m.findInSelection)
    }

    func testCommandFTakesAOneLineSelectionFromTheEditor() throws {
        let text = "alpha beta alpha\nGamma ALPHA\n"
        let m = model()
        m.open([try write("notes/plan.md", text)])
        m.setMode(.source)
        let id = try XCTUnwrap(m.selected?.id)

        m.editorSelectionChanged(NSRange(location: 6, length: 4), byUser: true, in: id)
        m.openFind()
        XCTAssertEqual(m.findQuery, "beta")
        XCTAssertEqual(m.findCount, 1)

        // The field has the keyboard: ⌘F only selects its text.
        m.findFieldFocused = true
        m.editorSelectionChanged(NSRange(location: 0, length: 5), byUser: true, in: id)
        m.openFind()
        XCTAssertEqual(m.findQuery, "beta")

        // Back in the editor, a selection find made is not the reader's.
        m.findFieldFocused = false
        m.editorSelectionChanged(NSRange(location: 17, length: 5), byUser: false, in: id)
        m.openFind()
        XCTAssertEqual(m.findQuery, "beta")

        // Two lines are a scope, not a query.
        m.editorSelectionChanged(NSRange(location: 6, length: 15), byUser: true, in: id)
        m.openFind()
        XCTAssertEqual(m.findQuery, "beta")

        // With regex on, the seed is escaped.
        m.findOptions.regex = true
        let dotted = try write("notes/dots.md", "see a.b here\n")
        m.open([dotted])
        let dots = try XCTUnwrap(m.selected?.id)
        m.editorSelectionChanged(NSRange(location: 4, length: 3), byUser: true, in: dots)
        m.openFind()
        XCTAssertEqual(m.findQuery, "a\\.b")
        XCTAssertEqual(m.findCount, 1)
    }

    func testCommandFBumpsTheFocusTokenSoTheFieldSelectsItsText() throws {
        let m = try sourceModel()
        let before = m.findFocusToken
        m.openFind()
        XCTAssertEqual(m.findFocusToken, before + 1)
    }

    func testFindInAllOpenTabsCountsEveryTabWithAMatch() throws {
        let m = model()
        m.open([
            try write("notes/plan.md", "# Plan\n\n- [ ] ask alice about the budget\n- budget again\n"),
            try write("notes/empty.md", "nothing here\n"),
            try write("notes/log.md", "Budget review\n"),
        ])
        m.setMode(.preview)
        m.openFind()
        m.findQuery = "budget"
        let hits = m.findAllTabsHits()
        XCTAssertEqual(hits.map(\.title), ["plan", "log"])
        XCTAssertEqual(hits.map(\.count), [2, 1])
        XCTAssertEqual(hits[0].snippet, "- [ ] ask alice about the budget")
        XCTAssertEqual((hits[0].snippet as NSString).substring(with: hits[0].snippetMatch), "budget")
        XCTAssertEqual(hits.filter(\.isSelected).map(\.title), ["log"])

        m.findOptions.matchCase = true
        XCTAssertEqual(m.findAllTabsHits().map(\.title), ["plan"])
        m.findOptions.regex = true
        m.findQuery = "budget("
        XCTAssertEqual(m.findAllTabsHits(), [])
        m.findQuery = ""
        XCTAssertEqual(m.findAllTabsHits(), [])

        // A row selects its tab and runs the search there.
        m.findOptions = MarkdownFindOptions()
        m.findQuery = "budget"
        m.setMode(.source)
        let plan = try XCTUnwrap(m.findAllTabsHits().first)
        m.openFindHit(plan)
        XCTAssertEqual(m.selected?.title, "plan")
        XCTAssertEqual(m.findCount, 2)
    }
}
