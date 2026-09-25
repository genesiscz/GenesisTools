import SwiftUI
import XCTest
@testable import GenesisTools

/// The panel find's match model (Hub/HubPanelFind.swift): case and accents, several matches in one
/// row, markdown matched block by block, next and previous wrapping, the current match kept when the
/// data reloads, the highlight marks, and which panel ⌘F goes to.
final class HubPanelFindTests: XCTestCase {
    private let rows = [
        PanelFindRow(id: "a", fields: [PanelFindField("title", "Fix the Cache"), PanelFindField("detail", "cache hit, cache miss")]),
        PanelFindRow(id: "b", fields: [PanelFindField("title", "Odhlašování z ČEZ")]),
        PanelFindRow(id: "c", fields: [PanelFindField("title", "nothing here")], container: "section-1"),
    ]

    // MARK: Matching

    func testIgnoresCaseAndAccentsByDefault() {
        XCTAssertEqual(PanelFind.ranges(of: "cache", in: "Cache CACHE cache", caseSensitive: false).count, 3)
        XCTAssertEqual(PanelFind.ranges(of: "odhlasovani", in: "Odhlašování z ČEZ", caseSensitive: false).count, 1)
        XCTAssertEqual(PanelFind.ranges(of: "cez", in: "Odhlašování z ČEZ", caseSensitive: false).count, 1)
    }

    func testMatchCaseIsExact() {
        XCTAssertEqual(PanelFind.ranges(of: "cache", in: "Cache CACHE cache", caseSensitive: true).count, 1)
        XCTAssertEqual(PanelFind.ranges(of: "cez", in: "Odhlašování z ČEZ", caseSensitive: true).count, 0)
    }

    func testBlankQueryFindsNothing() {
        XCTAssertTrue(PanelFind.ranges(of: "  ", in: "a  b", caseSensitive: false).isEmpty)
        XCTAssertTrue(PanelFind.matches(of: "", in: rows, caseSensitive: false).isEmpty)
    }

    func testSeveralMatchesPerRowComeInRowFieldTextOrder() {
        let found = PanelFind.matches(of: "cache", in: rows, caseSensitive: false)
        XCTAssertEqual(found.map { "\($0.row).\($0.field).\($0.occurrence)" }, ["a.title.0", "a.detail.0", "a.detail.1"])
    }

    func testMatchesDoNotOverlap() {
        XCTAssertEqual(PanelFind.ranges(of: "aa", in: "aaaa", caseSensitive: false).count, 2)
    }

    func testMatchCarriesTheRowContainer() {
        let found = PanelFind.matches(of: "here", in: rows, caseSensitive: false)
        XCTAssertEqual(found.first?.container, "section-1")
        XCTAssertEqual(found.first?.anchor, "c|title", "a plain field is its own scroll target")
    }

    func testMarkdownIsMatchedBlockByBlockOnItsShownText() {
        let markdown = "First **bold** word.\n\n# Heading bold\n\n```\nlet bold = 1\n```"
        let row = PanelFindRow(id: "pr", fields: [PanelFindField("desc", markdown, markdown: true)])
        let found = PanelFind.matches(of: "bold word", in: [row], caseSensitive: false)
        XCTAssertEqual(found.map(\.block), [0], "the ** markers are not part of the shown text")
        let every = PanelFind.matches(of: "bold", in: [row], caseSensitive: false)
        XCTAssertEqual(every.map(\.field), ["desc", "desc", "desc"])
        XCTAssertEqual(every.map(\.block), [0, 1, 2])
        XCTAssertEqual(every.last?.anchor, "pr|desc#2")
        XCTAssertEqual(MarkdownContentView.searchBlocks(markdown), ["First bold word.", "Heading bold", "let bold = 1"])
    }

    // MARK: Next and previous

    func testStepWrapsAtBothEnds() {
        XCTAssertEqual(PanelFind.step(nil, count: 3, forward: true), 0)
        XCTAssertEqual(PanelFind.step(nil, count: 3, forward: false), 2)
        XCTAssertEqual(PanelFind.step(0, count: 3, forward: true), 1)
        XCTAssertEqual(PanelFind.step(2, count: 3, forward: true), 0, "next after the last is the first")
        XCTAssertEqual(PanelFind.step(0, count: 3, forward: false), 2, "previous before the first is the last")
        XCTAssertNil(PanelFind.step(1, count: 0, forward: true))
        XCTAssertEqual(PanelFind.step(7, count: 3, forward: true), 0, "a stale index starts over")
    }

    func testReloadKeepsTheSameMatch() {
        let before = PanelFind.matches(of: "cache", in: rows, caseSensitive: false)
        let current = before[2]
        let reloaded = [PanelFindRow(id: "new", fields: [PanelFindField("title", "cache")])] + rows
        let after = PanelFind.matches(of: "cache", in: reloaded, caseSensitive: false)
        XCTAssertEqual(PanelFind.carry(current, previousIndex: 2, into: after, sameMatch: true), 3)
    }

    func testReloadFallsBackToTheSameRowThenThePosition() {
        let current = PanelFindMatch(row: "a", field: "detail", occurrence: 1)
        let shorter = [PanelFindRow(id: "a", fields: [PanelFindField("detail", "one cache")]), PanelFindRow(id: "z", fields: [PanelFindField("t", "cache")])]
        let after = PanelFind.matches(of: "cache", in: shorter, caseSensitive: false)
        XCTAssertEqual(PanelFind.carry(current, previousIndex: 2, into: after, sameMatch: true), 0)
        let gone = PanelFind.matches(of: "cache", in: [PanelFindRow(id: "z", fields: [PanelFindField("t", "cache cache")])], caseSensitive: false)
        XCTAssertEqual(PanelFind.carry(current, previousIndex: 5, into: gone, sameMatch: true), 1, "clamped to the last")
    }

    func testANewQueryStaysInTheRowOrStartsAtTheFirst() {
        let current = PanelFindMatch(row: "b", field: "title", occurrence: 0)
        let found = PanelFind.matches(of: "e", in: rows, caseSensitive: false)
        XCTAssertEqual(found[PanelFind.carry(current, previousIndex: 3, into: found, sameMatch: false) ?? -1].row, "b")
        let elsewhere = PanelFind.matches(of: "miss", in: rows, caseSensitive: false)
        XCTAssertEqual(PanelFind.carry(current, previousIndex: 3, into: elsewhere, sameMatch: false), 0)
        XCTAssertNil(PanelFind.carry(current, previousIndex: 0, into: [], sameMatch: false))
    }

    // MARK: Highlight

    func testHighlightMarksEveryMatchAndTheCurrentOneSolid() {
        let highlight = PanelFindHighlight(query: "cache", caseSensitive: false, current: PanelFindMatch(row: "a", field: "detail", occurrence: 1))
        let marked = highlight.attributed("cache hit, cache miss", row: "a", field: "detail")
        let runs = marked.runs.map { (String(marked[$0.range].characters), $0[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self]) }
        XCTAssertEqual(runs.map(\.0), ["cache", " hit, ", "cache", " miss"])
        XCTAssertEqual(runs[0].1, PanelFindHighlight.matchBackground)
        XCTAssertNil(runs[1].1)
        XCTAssertEqual(runs[2].1, PanelFindHighlight.currentBackground)
        let otherRow = highlight.attributed("cache hit, cache miss", row: "b", field: "detail")
        XCTAssertFalse(otherRow.runs.contains { $0[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] == PanelFindHighlight.currentBackground })
    }

    func testAOneLineTextStartsNearItsCurrentMatch() {
        let text = "feat(hub): worktree cleanup lists merged worktrees with sizes and the panel"
        let highlight = PanelFindHighlight(query: "panel", caseSensitive: false, current: PanelFindMatch(row: "r", field: "title", occurrence: 0))
        let shown = highlight.attributed(text, row: "r", field: "title", singleLine: true)
        let plain = String(shown.characters)
        XCTAssertTrue(plain.hasPrefix("…"), plain)
        XCTAssertTrue(plain.hasSuffix("the panel"))
        let current = shown.runs.filter { $0[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] == PanelFindHighlight.currentBackground }
        XCTAssertEqual(current.map { String(shown[$0.range].characters) }, ["panel"])
        XCTAssertEqual(String(highlight.attributed(text, row: "r", field: "title").characters), text, "wrapping text stays whole")
        XCTAssertEqual(String(highlight.attributed(text, row: "other", field: "title", singleLine: true).characters), text, "only the current row moves")
    }

    func testAOneLineCutKeepsTheCurrentOccurrenceAfterEarlierOnes() {
        let text = "cache one, cache two, and a long stretch of words before the last cache here"
        let highlight = PanelFindHighlight(query: "cache", caseSensitive: false, current: PanelFindMatch(row: "r", field: "t", occurrence: 2))
        let shown = highlight.attributed(text, row: "r", field: "t", singleLine: true)
        let runs = shown.runs.filter { $0[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] != nil }
        XCTAssertEqual(runs.map { String(shown[$0.range].characters) }, ["cache"], "the two earlier matches are cut off")
        XCTAssertEqual(runs.first?[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self], PanelFindHighlight.currentBackground)
    }

    func testHighlightFindsMatchesInStyledMarkdownText() throws {
        var styled = try AttributedString(markdown: "a **Cache** and `cache`", options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        PanelFindHighlight(query: "cache", caseSensitive: false, current: nil).mark(&styled, row: nil, field: nil, block: nil)
        let marked = styled.runs.filter { $0[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] != nil }.map { String(styled[$0.range].characters) }
        XCTAssertEqual(marked, ["Cache", "cache"])
    }

    // MARK: Which panel takes ⌘F

    private let wide = PanelFindRouting.Candidate(rect: CGRect(x: 0, y: 0, width: 800, height: 600), activeAt: nil)
    private let inner = PanelFindRouting.Candidate(rect: CGRect(x: 500, y: 0, width: 300, height: 300), activeAt: nil)

    func testTheClickedPanelWinsAndTheInnermostOne() {
        XCTAssertEqual(PanelFindRouting.pick([wide, inner], click: CGPoint(x: 600, y: 100), responder: nil), 1)
        XCTAssertEqual(PanelFindRouting.pick([wide, inner], click: CGPoint(x: 100, y: 100), responder: nil), 0)
    }

    func testTheResponderCountsOnlyWhenItIsSmallerThanThePanel() {
        let field = CGRect(x: 520, y: 10, width: 100, height: 20)
        XCTAssertEqual(PanelFindRouting.pick([wide, inner], click: nil, responder: field), 1)
        let hostingView = CGRect(x: 0, y: 0, width: 1000, height: 700)
        XCTAssertEqual(PanelFindRouting.pick([wide, inner], click: nil, responder: hostingView), 0, "falls back to the largest")
        XCTAssertEqual(PanelFindRouting.pick([wide, inner], click: nil, responder: inner.rect), 1, "a web view fills its own panel")
    }

    func testAClickOutsideEveryPanelFallsBackToTheOneUsedLast() {
        let used = PanelFindRouting.Candidate(rect: inner.rect, activeAt: 10)
        let older = PanelFindRouting.Candidate(rect: wide.rect, activeAt: 5)
        XCTAssertEqual(PanelFindRouting.pick([older, used], click: CGPoint(x: 900, y: 900), responder: nil), 1)
        XCTAssertNil(PanelFindRouting.pick([], click: nil, responder: nil))
    }
}
