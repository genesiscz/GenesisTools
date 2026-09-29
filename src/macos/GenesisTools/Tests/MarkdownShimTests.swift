import XCTest
@testable import GenesisTools

final class MarkdownShimTests: XCTestCase {
    func testReviewBotHTMLBecomesTextAndListsBecomeBullets() {
        // The shape of an eve-bot thread body, which the PR threads panel printed with its tags.
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
        XCTAssertTrue(text.contains("▸ 🧩 Analysis"))
        XCTAssertTrue(text.contains("☐ open item"))
        XCTAssertTrue(text.contains("☑ done item"))
        XCTAssertTrue(text.contains("• plain item"))
        XCTAssertTrue(blocks.contains("quoted line"))
        XCTAssertTrue(blocks.contains("| a | b |\n| 1 | 2 |"))
        XCTAssertTrue(blocks.contains(""), "the rule is its own block")
        XCTAssertTrue(text.contains("Line two and bold and Array<Int>"))
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
        let blocks = MarkdownContentView.searchBlocks(body)

        XCTAssertEqual(blocks, ["```swift\nlet a = 1\n```\n- not a bullet", "<b>kept</b>", "after"])
    }
}
