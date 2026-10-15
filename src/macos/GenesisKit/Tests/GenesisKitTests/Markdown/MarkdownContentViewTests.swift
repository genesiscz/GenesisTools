import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The native renderer both apps share (`MarkdownContentView`): the bot HTML it cleans, the fences it
/// closes, the units a host's find marks, and the style each caller starts from.
@MainActor
final class MarkdownContentViewTests: XCTestCase {
    // MARK: Parsing (moved from GenesisTools' MarkdownShimTests with its renderer)

    func testReviewBotHTMLBecomesTextAndListItemsAreTheirOwnBlocks() {
        // The shape of an eve-bot thread body, which the PR threads panel once printed with its tags.
        let body = """
        **Include the transcript location in the insights cache identity**

        <details><summary>🧩 Analysis</summary>

        Grep evidence: `const key`
        </details>
        <!-- eve:state {"a":1} -->

        - [ ] open item
        - [x] done item
        * plain item

        > quoted line

        | a | b |
        |---|---|
        | 1 | 2 |

        ---
        Line<br>two and <b>bold</b> and Array<Int>
        """
        let blocks = MarkdownContentView.searchBlocks(body)
        let text = blocks.joined(separator: "\n")

        XCTAssertFalse(text.contains("<details>"))
        XCTAssertFalse(text.contains("</summary>"))
        XCTAssertFalse(text.contains("eve:state"))
        XCTAssertTrue(blocks.contains("▸ 🧩 Analysis"))
        XCTAssertTrue(blocks.contains("Grep evidence: const key"), "the closing tag line does not end up in the paragraph")
        XCTAssertTrue(blocks.contains("open item"))
        XCTAssertTrue(blocks.contains("done item"))
        XCTAssertTrue(blocks.contains("plain item"))
        XCTAssertTrue(blocks.contains("quoted line"))
        XCTAssertEqual(Array(blocks.drop { $0 != "A" }.prefix(4)), ["A", "B", "1", "2"], "a table is a unit per cell, the header in capitals")
        XCTAssertTrue(blocks.contains(""), "the rule is its own block")
        XCTAssertTrue(blocks.contains("Line two and bold and Array<Int>"))
    }

    /// Only a fence of the opener's character, at least as long and with nothing after it, closes a block.
    func testCodeFenceClosesOnlyOnItsOwnKind() {
        let body = """
        ````markdown
        ```swift
        let a = 1
        ```
        - not a bullet
        ````
        ~~~
        <b>kept</b>
        ~~~
        after
        """
        XCTAssertEqual(MarkdownContentView.searchBlocks(body), ["```swift\nlet a = 1\n```\n- not a bullet", "<b>kept</b>", "after"])
        let vault = MarkdownBlocks.parse(body)
        XCTAssertEqual(vault.count, 3, "the vault's native pane reads the same three blocks: \(vault)")
    }

    func testAWindowsNoteKeepsItsParagraphsWhole() {
        XCTAssertEqual(MarkdownBlocks.parseUncached("one\r\ntwo\r\n\r\nthree"), [
            .paragraph(text: "one\ntwo", index: 0),
            .paragraph(text: "three", index: 1),
        ])
    }

    // MARK: Find units

    func testUnitsAreOnePerBlockAndOnePerTableCell() {
        let blocks = MarkdownBlocks.parseUncached("Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- item")
        XCTAssertEqual(MarkdownRenderCache.firstUnits(blocks), [0, 1, 5], "the 2 × 2 table holds units 1 to 4")
    }

    /// The view and `searchBlocks` must agree unit by unit, or a find's n-th match marks the wrong text.
    func testTheViewMarksExactlyTheUnitsSearchBlocksLists() {
        final class Seen { var units: [Int: String] = [:] }
        let seen = Seen()
        let marks = MarkdownFindMarks(id: "test", mark: { text, unit in seen.units[unit] = String(text.characters) }, anchor: { _ in nil })
        let markdown = "# Title\n\nIntro **bold** and [[Note|a note]].\n\n- one\n- [x] two\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nlet a = 1\n```"
        let host = NSHostingView(rootView: MarkdownContentView(markdown: markdown).environment(\.markdownFindMarks, marks).frame(width: 500))
        host.frame = NSRect(x: 0, y: 0, width: 500, height: 800)
        host.layoutSubtreeIfNeeded()

        let expected = MarkdownContentView.searchBlocks(markdown)
        XCTAssertEqual(seen.units.keys.sorted(), Array(0..<expected.count))
        for (unit, text) in seen.units {
            XCTAssertEqual(text, expected[unit], "unit \(unit)")
        }
        XCTAssertEqual(expected[1], "Intro bold and a note.", "a wikilink shows its alias")
    }

    func testAWikilinkStaysTextWhenTheStyleSaysSo() {
        let off = MarkdownStyle().with { $0.wikilinks = false }
        XCTAssertEqual(MarkdownContentView.searchBlocks("See [[Note]].", style: off), ["See [[Note]]."])
        XCTAssertEqual(MarkdownContentView.searchBlocks("See [[Note]]."), ["See Note."])
    }

    func testInlineCodeGetsItsFill() {
        let styled = MarkdownContentView.inline("a `code` b", codeBackground: .red)
        let filled = styled.runs.filter { $0.backgroundColor != nil }.map { String(styled[$0.range].characters) }
        XCTAssertEqual(filled, ["code"])
    }

    // MARK: Styles

    /// Genesis.app calls `MarkdownContentView(markdown:)` (the canvas draft) and the presets: they keep
    /// the vault's look, with code selectable and scrolling sideways under its language.
    func testTheDefaultStyleIsTheVaultLook() {
        let style = MarkdownStyle()
        XCTAssertEqual(style, .vault)
        XCTAssertEqual(style.bodySize, 13)
        XCTAssertEqual(style.textColor, .settingsText)
        XCTAssertEqual(style.accentColor, .neonAmber)
        XCTAssertEqual(style.codeColor, .neonCyan)
        XCTAssertEqual(style.headingSizes, [22, 18, 15, 13, 13, 13])
        XCTAssertEqual(style.codeFontSize, 11)
        XCTAssertFalse(style.codeWraps)
        XCTAssertTrue(style.codeShowsLanguage)
        XCTAssertFalse(style.codeCopyButton)
        XCTAssertEqual(style.selection, .codeOnly)
        XCTAssertTrue(style.wikilinks)
        XCTAssertTrue(style.cleansHTML)
        XCTAssertNil(style.inlineCodeBackground)
        XCTAssertEqual(MarkdownStyle.chat.bodySize, 13.5)
        XCTAssertEqual(MarkdownStyle.companion.headingScale, 0.82)
        XCTAssertEqual(MarkdownStyle.companionUser.blockSpacing, 6)
    }

    /// Both apps hand the transcript's style over through `GenesisKitHost.transcriptMarkdown`.
    func testTheTranscriptStyleCarriesTheTranscriptsValuesAndLeavesSelectionToTheRow() {
        let transcript = TranscriptMarkdownStyle.sessionTranscript
        let style = MarkdownStyle(transcript)
        XCTAssertEqual(style.bodySize, transcript.bodySize)
        XCTAssertEqual(style.textColor, transcript.textColor)
        XCTAssertEqual(style.accentColor, transcript.accentColor)
        XCTAssertEqual(style.codeBackground, transcript.codeBackground)
        XCTAssertEqual(style.blockSpacing, transcript.blockSpacing)
        XCTAssertEqual(style.headingScale, transcript.headingScale)
        XCTAssertEqual(style.selection, .none, "the row turns selection on under the pointer")
        XCTAssertTrue(style.codeWraps, "no sideways scroller per block in every row")
        XCTAssertNil(style.codeFontSize, "code follows the transcript's body size")
    }
}
