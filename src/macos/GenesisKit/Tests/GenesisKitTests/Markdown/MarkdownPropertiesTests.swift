import XCTest
@testable import GenesisKit

/// Frontmatter as Obsidian's Properties: typed rows in file order, and a
/// write-back that only touches the rows the reader changed.
final class MarkdownPropertiesTests: XCTestCase {
    private let note = """
    ---
    ado: [302921, 302922]
    created: 2026-09-08 12:26
    tags: [web-app, tech-debt, cleanup]
    due: 2026-10-01
    at: 2026-10-01T09:30
    rating: 4.5
    done: false
    title: "Repo: cleanup"
    aliases:
      - Cleanup
      - "Repo cleanup"
    empty:
    ---
    # Heading

    body
    """

    func testSplitSeparatesTheBlockFromTheBody() {
        let (yaml, body) = MarkdownFrontmatter.split(note)
        XCTAssertEqual(yaml?.hasPrefix("ado:"), true)
        XCTAssertEqual(body, "# Heading\n\nbody")
        XCTAssertNil(MarkdownFrontmatter.split("# no block\n---\n").yaml)
        XCTAssertNil(MarkdownFrontmatter.split("---\nnever closed\n").yaml)
    }

    func testRowsKeepFileOrderAndInferObsidianTypes() {
        let rows = MarkdownFrontmatter.properties(in: note)
        XCTAssertEqual(rows.map(\.key), ["ado", "created", "tags", "due", "at", "rating", "done", "title", "aliases", "empty"])
        XCTAssertEqual(rows.map(\.kind), [.list, .text, .tags, .date, .datetime, .number, .checkbox, .text, .list, .text])
        XCTAssertEqual(rows[0].items, ["302921", "302922"])
        XCTAssertTrue(rows[0].inline)
        XCTAssertEqual(rows[1].value, "2026-09-08 12:26")
        XCTAssertEqual(rows[7].value, "Repo: cleanup")
        XCTAssertEqual(rows[8].items, ["Cleanup", "Repo cleanup"])
        XCTAssertFalse(rows[8].inline)
        XCTAssertEqual(rows[9].value, "")
    }

    func testUntouchedRowsRoundTripByteForByte() {
        let rows = MarkdownFrontmatter.properties(in: note)
        XCTAssertEqual(MarkdownFrontmatter.replacing(properties: rows, in: note), note)
    }

    func testEditingOneValueChangesOnlyThatLine() {
        var rows = MarkdownFrontmatter.properties(in: note)
        rows[5].value = "5"
        let out = MarkdownFrontmatter.replacing(properties: rows, in: note)
        XCTAssertEqual(out, note.replacingOccurrences(of: "rating: 4.5", with: "rating: 5"))
    }

    func testListsSerializeInTheirOriginalStyleAndTextIsQuotedWhenYamlNeedsIt() {
        var rows = MarkdownFrontmatter.properties(in: note)
        rows[2].items.append("new")          // inline stays inline
        rows[8].items.append("a: b")         // block stays block, only this item needs quotes
        rows[8].items.append("12")
        rows[7].value = "plain"
        rows[9].value = "2026-01-01"         // a text row whose value looks like a date is quoted
        let out = MarkdownFrontmatter.replacing(properties: rows, in: note)
        XCTAssertTrue(out.contains("tags: [web-app, tech-debt, cleanup, new]\n"))
        XCTAssertTrue(out.contains("aliases:\n  - Cleanup\n  - Repo cleanup\n  - \"a: b\"\n  - 12\n"))
        XCTAssertTrue(out.contains("title: plain\n"))
        XCTAssertTrue(out.contains("empty: \"2026-01-01\"\n"))
        // And it parses back to the same rows.
        let again = MarkdownFrontmatter.properties(in: out)
        XCTAssertEqual(again, rows)
    }

    func testAddRemoveAndRenameRows() {
        var rows = MarkdownFrontmatter.properties(in: note)
        rows.removeAll { $0.key == "empty" }
        rows[0].key = "work-items"
        rows.append(MarkdownProperty(key: "status", kind: .text, value: "open"))
        rows.append(MarkdownProperty(key: "flag", kind: .checkbox, value: "true"))
        rows.append(MarkdownProperty(key: "nothing", kind: .list))
        let out = MarkdownFrontmatter.replacing(properties: rows, in: note)
        XCTAssertFalse(out.contains("empty:"))
        XCTAssertTrue(out.hasPrefix("---\nwork-items: [302921, 302922]\n"))
        XCTAssertTrue(out.hasSuffix("status: open\nflag: true\nnothing: []\n---\n# Heading\n\nbody"))
    }

    func testNoRowsRemovesTheBlockAndAFileWithoutOneGetsOne() {
        XCTAssertEqual(MarkdownFrontmatter.replacing(properties: [], in: note), "# Heading\n\nbody")
        let added = MarkdownFrontmatter.replacing(properties: [MarkdownProperty(key: "tags", kind: .tags, items: ["x"])], in: "# Only\n")
        XCTAssertEqual(added, "---\ntags:\n  - x\n---\n\n# Only\n")
        XCTAssertEqual(MarkdownFrontmatter.properties(in: added).first?.kind, .tags)
    }

    func testBridgeJSONAndBack() throws {
        let rows = MarkdownFrontmatter.properties(in: note)
        let json = MarkdownFrontmatter.json(rows)
        let any = try JSONSerialization.jsonObject(with: Data(json.utf8))
        XCTAssertEqual(MarkdownFrontmatter.properties(fromBridge: any), rows)
        XCTAssertNil(MarkdownFrontmatter.properties(fromBridge: "nope"))
    }

    func testCommentsQuotedKeysAndOddValuesSurvive() {
        let yaml = "# a comment\n\"a: b\": 1 # trailing\nweird: {x: 1}\nlink: \"[[Other Note]]\"\nquoted: 'it''s'"
        let rows = MarkdownFrontmatter.parse(yaml: yaml)
        XCTAssertEqual(rows.map(\.key), ["a: b", "weird", "link", "quoted"])
        XCTAssertEqual(rows[0].kind, .number)
        XCTAssertEqual(rows[0].value, "1")
        XCTAssertEqual(rows[1].value, "{x: 1}")
        XCTAssertEqual(rows[2].value, "[[Other Note]]")
        XCTAssertEqual(rows[3].value, "it's")
        XCTAssertEqual(MarkdownFrontmatter.lines(for: rows[2]), ["link: \"[[Other Note]]\""])
        XCTAssertEqual(MarkdownFrontmatter.lines(for: rows[0]), ["\"a: b\": 1"])
    }

    /// Editing one property must not delete what the subset does not model:
    /// a block scalar's text, comments, blank lines, a nested map.
    func testEditingARowKeepsBlockScalarsCommentsAndNestedValues() {
        let doc = """
        ---
        # owner: ops
        description: |
          First line of prose.

          Second paragraph: with a colon.
        status: open # triage
        author:
          name: Alice
          team: web

        rating: 3
        ---
        body
        """
        var rows = MarkdownFrontmatter.properties(in: doc)
        XCTAssertEqual(rows.map(\.key), ["description", "status", "author", "rating"])
        XCTAssertEqual(rows[0].kind, .text)
        XCTAssertEqual(rows[0].value, "First line of prose.\n\nSecond paragraph: with a colon.")
        // Nothing changed: byte for byte.
        XCTAssertEqual(MarkdownFrontmatter.replacing(properties: rows, in: doc), doc)

        rows[3].value = "4"
        let out = MarkdownFrontmatter.replacing(properties: rows, in: doc)
        XCTAssertEqual(out, doc.replacingOccurrences(of: "rating: 3", with: "rating: 4"))

        // An edited multi-line text stays a block scalar and reads back the same.
        rows[0].value = "One.\n\nTwo."
        let edited = MarkdownFrontmatter.replacing(properties: rows, in: doc)
        XCTAssertTrue(edited.contains("description: |\n  One.\n\n  Two.\nstatus: open # triage\n"))
        XCTAssertEqual(MarkdownFrontmatter.properties(in: edited)[0].value, "One.\n\nTwo.")
        XCTAssertTrue(edited.hasPrefix("---\n# owner: ops\n"))
    }
}
