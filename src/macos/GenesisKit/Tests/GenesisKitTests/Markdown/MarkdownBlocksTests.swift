import XCTest
@testable import GenesisKit

/// The native reading view's block parser (`MarkdownBlocks`).
final class MarkdownBlocksTests: XCTestCase {
    func testMarkdownBlockParsing() {
        let md = """
        ---
        status: open
        ---
        # Title

        Paragraph with **bold** and [[Wiki Link]].

        - item one
        - [ ] open task
        - [x] done task

        > quoted wisdom

        ```swift
        let x = 1
        ```
        """
        let blocks = MarkdownBlocks.parse(md)
        guard case .frontmatter(let keys, _) = blocks[0] else { return XCTFail("frontmatter first") }
        XCTAssertEqual(keys, ["status"])
        guard case .heading(let level, let text, let slug, _) = blocks[1] else { return XCTFail("heading") }
        XCTAssertEqual(level, 1)
        XCTAssertEqual(text, "Title")
        XCTAssertEqual(slug, "title")
        guard case .paragraph = blocks[2] else { return XCTFail("paragraph") }
        guard case .listItem(_, _, _, _, let task1, _) = blocks[3] else { return XCTFail("list") }
        XCTAssertNil(task1)
        guard case .listItem(_, _, _, _, let task2, _) = blocks[4] else { return XCTFail("task") }
        XCTAssertEqual(task2, false)
        guard case .listItem(_, _, _, _, let task3, _) = blocks[5] else { return XCTFail("task done") }
        XCTAssertEqual(task3, true)
        guard case .quote(let q, _) = blocks[6] else { return XCTFail("quote") }
        XCTAssertEqual(q, "quoted wisdom")
        guard case .code(let lang, let code, _) = blocks[7] else { return XCTFail("code") }
        XCTAssertEqual(lang, "swift")
        XCTAssertEqual(code, "let x = 1")
    }

    func testSessionTranscriptMarkdownHasHeadingTableAndCode() {
        // The Session Details window was showing raw `##`, `**`, `|---|` and
        // fences. Same MarkdownBlocks path chat/companion already use.
        let md = """
        ## UAT app-mobile failed

        **Root cause: the macOS build agent dropped mid-checkout.**

        ```
        [Pipeline] checkout
        ERROR: Checkout failed
        ```

        | Build | Started | Result |
        |---|---|---|
        | #8101 | 13:17 | FAILURE |
        """
        let blocks = MarkdownBlocks.parse(md)
        XCTAssertTrue(blocks.contains { if case .heading(let level, let text, _, _) = $0 {
            return level == 2 && text.contains("UAT app-mobile failed")
        } else { return false } })
        XCTAssertTrue(blocks.contains { if case .code(_, let code, _) = $0 {
            return code.contains("Checkout failed")
        } else { return false } })
        XCTAssertTrue(blocks.contains { if case .table(let header, _, let rows, _) = $0 {
            return header == ["Build", "Started", "Result"] && rows.first == ["#8101", "13:17", "FAILURE"]
        } else { return false } })
        XCTAssertTrue(blocks.contains { if case .paragraph(let text, _) = $0 {
            return text.contains("Root cause")
        } else { return false } })
    }

    func testMarkdownTableParsing() {
        let md = """
        Intro paragraph.

        | Mode | Streaming | Notes |
        |:-----|:---------:|------:|
        | Fast | yes | low latency |
        | Safe | no  | durable |

        Trailing paragraph.
        """
        let blocks = MarkdownBlocks.parse(md)
        guard let table = blocks.compactMap({ block -> (h: [String], a: [MarkdownBlocks.ColumnAlign], r: [[String]])? in
            if case .table(let h, let a, let r, _) = block { return (h, a, r) }
            return nil
        }).first else { return XCTFail("expected a table block") }

        XCTAssertEqual(table.h, ["Mode", "Streaming", "Notes"])
        XCTAssertEqual(table.a, [.leading, .center, .trailing])
        XCTAssertEqual(table.r.count, 2)
        XCTAssertEqual(table.r[0], ["Fast", "yes", "low latency"])
        XCTAssertEqual(table.r[1], ["Safe", "no", "durable"])
        // Surrounding paragraphs still parse as paragraphs.
        XCTAssertTrue(blocks.contains { if case .paragraph(let t, _) = $0 { return t == "Intro paragraph." } else { return false } })
        XCTAssertTrue(blocks.contains { if case .paragraph(let t, _) = $0 { return t == "Trailing paragraph." } else { return false } })
    }

    func testTableSeparatorVsHorizontalRule() {
        // A bare `---` is an <hr>, never a table delimiter (no pipe).
        XCTAssertFalse(MarkdownBlocks.isTableSeparator("---"))
        XCTAssertTrue(MarkdownBlocks.isTableSeparator("|---|---|"))
        XCTAssertTrue(MarkdownBlocks.isTableSeparator(":--: | ---"))
        XCTAssertFalse(MarkdownBlocks.isTableSeparator("| data | here |"))
        // Regression: `---` under a non-table line stays a rule block.
        let blocks = MarkdownBlocks.parse("Heading text\n\n---\n\nAfter")
        XCTAssertTrue(blocks.contains { if case .rule = $0 { return true } else { return false } })
        XCTAssertFalse(blocks.contains { if case .table = $0 { return true } else { return false } })
    }

    func testTableCellSplittingAndAlignments() {
        XCTAssertEqual(MarkdownBlocks.splitTableCells("| a | b | c |"), ["a", "b", "c"])
        XCTAssertEqual(MarkdownBlocks.splitTableCells("a | b"), ["a", "b"])
        // Escaped pipe stays inside the cell.
        XCTAssertEqual(MarkdownBlocks.splitTableCells(#"| a \| b | c |"#), [#"a \| b"#, "c"])
        XCTAssertEqual(MarkdownBlocks.parseAlignments("|:--|:-:|--:|"), [.leading, .center, .trailing])
    }

    func testWikilinkToMarkdownLinkConversion() {
        let out = MarkdownBlocks.wikilinksToMarkdownLinks("See [[Target Note|alias]] and [[Plain#Heading]].")
        XCTAssertTrue(out.contains("[alias](genesiswiki:"), out)
        XCTAssertTrue(out.contains("[Plain › Heading](genesiswiki:"), out)
        XCTAssertFalse(out.contains("[["), "all wikilinks converted")
    }

    func testSlugify() {
        XCTAssertEqual(MarkdownBlocks.slugify("Hello World!"), "hello-world")
        XCTAssertEqual(MarkdownBlocks.slugify("A  B — C"), "a-b-c")
    }
}
