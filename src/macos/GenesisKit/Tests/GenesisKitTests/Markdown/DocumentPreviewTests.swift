import XCTest
@testable import GenesisKit

/// The markdown window opens json, yaml, toml, csv, log and txt as tabs. Each used to reach
/// the markdown renderer as-is, so a minified JSON cache file rendered as one paragraph of
/// reflowed prose. Every file here is invented.
final class DocumentPreviewTests: XCTestCase {
    private func url(_ name: String) -> URL { URL(fileURLWithPath: "/tmp/\(name)") }

    func testRealMarkdownIsReturnedUntouched() {
        let text = "# Heading\n\nSome *prose* with `code`.\n"
        for name in ["notes.md", "notes.markdown", "notes.mdx"] {
            XCTAssertEqual(DocumentPreview.presentation(for: url(name)), .markdown)
            XCTAssertEqual(DocumentPreview.markdown(for: url(name), text: text), text)
        }

        // An extension the window does not claim is left alone too.
        XCTAssertEqual(DocumentPreview.markdown(for: url("notes.rtf"), text: text), text)
    }

    func testSourceFilesAreFencedInTheirLanguage() {
        // A generator script's doc comment opens with `/**` and ` * `, which markdown read as
        // bullets, and the code after it as one reflowed paragraph.
        let text = "/**\n * Report.md is generated from Report.json.\n */\nconst rows: string[] = [];\n"
        let out = DocumentPreview.markdown(for: url("Report.ts"), text: text)

        XCTAssertEqual(out, "```typescript\n\(text.dropLast())\n```\n")
        XCTAssertEqual(DocumentPreview.presentation(for: url("View.tsx")), .fenced(language: "typescript"))
        XCTAssertEqual(DocumentPreview.presentation(for: url("App.swift")), .fenced(language: "swift"))
        XCTAssertEqual(DocumentPreview.presentation(for: url("run.sh")), .fenced(language: "bash"))
        XCTAssertEqual(DocumentPreview.presentation(for: url("Script.PY")), .fenced(language: "python"))
    }

    func testMinifiedJSONIsIndentedAndFenced() {
        let text = #"{"name":"prepare-import","entries":[{"hours":0.5,"timeType":"Ceremonie"}],"done":false}"#
        let out = DocumentPreview.markdown(for: url("cache.json"), text: text)

        XCTAssertTrue(out.hasPrefix("```json\n"))
        XCTAssertTrue(out.hasSuffix("```\n"))
        XCTAssertTrue(out.contains("\n  \"name\": \"prepare-import\","))
        XCTAssertTrue(out.contains("\n      \"hours\": 0.5,"))
        XCTAssertTrue(out.contains("\n  \"done\": false"))
    }

    func testJSONKeepsItsOwnKeyOrderAndValues() {
        // JSONSerialization.prettyPrinted reorders keys and .sortedKeys sorts them; either way
        // the document stops matching the file. A viewer may not do that.
        let text = #"{"zebra":1,"alpha":2,"middle":"a \"quoted\" value, with a comma","exp":1.0e3}"#
        let pretty = DocumentPreview.prettyJSON(text)

        XCTAssertNotNil(pretty)
        let keys = ["\"zebra\"", "\"alpha\"", "\"middle\"", "\"exp\""]
        let positions = keys.map { pretty!.range(of: $0)!.lowerBound }
        XCTAssertEqual(positions, positions.sorted(), "keys were reordered")
        XCTAssertTrue(pretty!.contains(#""middle": "a \"quoted\" value, with a comma""#))
        XCTAssertTrue(pretty!.contains("1.0e3"), "the number was re-encoded")
    }

    func testBracesInsideStringsDoNotBreakTheIndentation() {
        let text = #"{"note":"a {brace} and a [bracket], plus a colon: here"}"#

        XCTAssertEqual(
            DocumentPreview.prettyJSON(text),
            "{\n  \"note\": \"a {brace} and a [bracket], plus a colon: here\"\n}"
        )
    }

    func testEmptyContainersStayOnOneLine() {
        XCTAssertEqual(DocumentPreview.prettyJSON(#"{"a":{},"b":[]}"#), "{\n  \"a\": {},\n  \"b\": []\n}")
    }

    func testBrokenJSONIsShownAsWrittenRatherThanHalfFormatted() {
        let text = "{\"truncated\": [1, 2"

        XCTAssertNil(DocumentPreview.prettyJSON(text))
        XCTAssertEqual(DocumentPreview.markdown(for: url("bad.json"), text: text), "```json\n\(text)\n```\n")
    }

    func testALogThatQuotesABackrickFenceStillCloses() {
        // Three backticks inside the body would end the block early and render the rest of the
        // file as markdown.
        let text = "started\n```\nnot the end\n```\nfinished"
        let out = DocumentPreview.markdown(for: url("run.log"), text: text)

        XCTAssertTrue(out.hasPrefix("````\n"), out)
        XCTAssertTrue(out.hasSuffix("\n````\n"), out)
        XCTAssertTrue(out.contains("not the end"))
    }

    func testYamlAndTomlAreFencedButNeverRewritten() {
        let yaml = "name: shop\nitems:\n  - one\n  - two\n"
        XCTAssertEqual(DocumentPreview.markdown(for: url("a.yml"), text: yaml), "```yaml\n\(yaml.dropLast())\n```\n")

        let toml = "[owner]\nname = \"work\"\n"
        XCTAssertEqual(DocumentPreview.markdown(for: url("a.toml"), text: toml), "```toml\n\(toml.dropLast())\n```\n")
    }

    func testCSVBecomesATable() {
        let text = "date,hours,comment\n2026-09-04,0.5,planning\n2026-09-07,2.0,\"review, then merge\"\n"
        let out = DocumentPreview.markdown(for: url("hours.csv"), text: text)

        XCTAssertEqual(
            out,
            """
            | date | hours | comment |
            | --- | --- | --- |
            | 2026-09-04 | 0.5 | planning |
            | 2026-09-07 | 2.0 | review, then merge |

            """
        )
    }

    func testACellCannotEndItsOwnColumnOrRow() {
        let text = "a,b\nwith | pipe,\"two\nlines\"\n"
        let rows = DocumentPreview.csvRows(text)

        XCTAssertEqual(rows, [["a", "b"], ["with | pipe", "two\nlines"]])
        XCTAssertEqual(DocumentPreview.tableCell("with | pipe"), "with \\| pipe")
        XCTAssertEqual(DocumentPreview.tableCell("two\nlines"), "two<br>lines")
        XCTAssertEqual(
            DocumentPreview.table(fromCSV: text),
            "| a | b |\n| --- | --- |\n| with \\| pipe | two<br>lines |\n"
        )
    }

    func testCRLFLineEndsRowsAndStaysInsideAQuotedField() {
        let text = "a,b\r\n1,\"x\r\ny\"\r\n2,z\r\n"
        XCTAssertEqual(DocumentPreview.csvRows(text), [["a", "b"], ["1", "x\r\ny"], ["2", "z"]])
        XCTAssertEqual(DocumentPreview.tableCell("x\r\ny"), "x<br>y")
    }

    func testASingleColumnFileIsFencedRatherThanTabulated() {
        let text = "one\ntwo\nthree\n"

        XCTAssertNil(DocumentPreview.table(fromCSV: text))
        XCTAssertEqual(DocumentPreview.markdown(for: url("list.csv"), text: text), "```\n\(text.dropLast())\n```\n")
    }

    func testALongTableIsCutAndSaysSo() {
        let rows = (1...(DocumentPreview.maximumTableRows + 5)).map { "\($0),row\($0)" }.joined(separator: "\n")
        let out = DocumentPreview.markdown(for: url("big.csv"), text: "n,label\n\(rows)\n")

        XCTAssertTrue(out.contains("| 1 | row1 |"))
        XCTAssertTrue(out.contains("| \(DocumentPreview.maximumTableRows) | row\(DocumentPreview.maximumTableRows) |"))
        XCTAssertFalse(out.contains("| \(DocumentPreview.maximumTableRows + 1) |"))
        XCTAssertTrue(out.contains("_5 more rows are in the file; open the source view._"))
    }
}
