import XCTest
@testable import GenesisKit

/// ⌘F over the source, with replace. The walking and the replacing are pure;
/// the model test drives them through a real document on disk.
@MainActor
final class SourceFindTests: XCTestCase {
    private var dir: URL!
    private var file: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-find-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("Note.md")
        try "alpha beta alpha\nGamma ALPHA\n".write(to: file, atomically: true, encoding: .utf8)
    }

    func testMatchesAreCaseInsensitiveAndInOrder() {
        let text = "alpha beta alpha\nGamma ALPHA\n"
        let hits = SourceFind.matches(in: text, query: "alpha")
        XCTAssertEqual(hits.map(\.location), [0, 11, 23])
        XCTAssertEqual(SourceFind.matches(in: text, query: ""), [])
        XCTAssertEqual(SourceFind.matches(in: text, query: "nothing"), [])
        // Overlapping needles still advance.
        XCTAssertEqual(SourceFind.matches(in: "aaaa", query: "aa").count, 2)
    }

    func testMatchCaseFindsOnlyTheExactSpelling() {
        let text = "Alpha alpha ALPHA"
        XCTAssertEqual(SourceFind.matches(in: text, query: "alpha").count, 3)
        let exact = SourceFind.matches(in: text, query: "alpha", options: .init(matchCase: true))
        XCTAssertEqual(exact, [NSRange(location: 6, length: 5)])
    }

    func testWholeWordSkipsPartsOfLongerWordsInAnyScript() {
        let options = MarkdownFindOptions(wholeWord: true)
        let text = "alpha alphabet _alpha alpha_x foo-alpha"
        XCTAssertEqual(SourceFind.matches(in: text, query: "alpha", options: options).map(\.location), [0, 34])
        // A háček is part of the word, not a boundary.
        let czech = "čaj čajovna káva"
        XCTAssertEqual(SourceFind.matches(in: czech, query: "čaj", options: options), [NSRange(location: 0, length: 3)])
        XCTAssertEqual(SourceFind.matches(in: czech, query: "aj", options: options), [])
    }

    func testRegexMatchesPerLineAndSkipsEmptyMatches() {
        let options = MarkdownFindOptions(regex: true)
        XCTAssertEqual(SourceFind.matches(in: "a1 b22 c333", query: "\\d+", options: options).count, 3)
        // `^` is every line start, as in an editor.
        let text = "alpha beta alpha\nGamma ALPHA\n"
        XCTAssertEqual(SourceFind.matches(in: text, query: "^gamma", options: options), [NSRange(location: 17, length: 5)])
        XCTAssertEqual(SourceFind.matches(in: text, query: "^gamma", options: .init(matchCase: true, regex: true)), [])
        // Nothing to select in an empty match.
        XCTAssertEqual(SourceFind.matches(in: "abc", query: "x*", options: options), [])
        // Without regex the same characters are literal.
        XCTAssertEqual(SourceFind.matches(in: "a (b) c.d", query: "(b)").count, 1)
        XCTAssertEqual(SourceFind.matches(in: "abcxd", query: "c.d"), [])
        // Regex and whole word together.
        let both = MarkdownFindOptions(wholeWord: true, regex: true)
        XCTAssertEqual(SourceFind.matches(in: "cat category cot", query: "c.t", options: both).map(\.location), [0, 13])
    }

    func testAnInvalidRegexSaysSoAndFindsNothing() {
        let regex = MarkdownFindOptions(regex: true)
        XCTAssertEqual(SourceFind.patternError("(", options: regex), "invalid regex")
        XCTAssertEqual(SourceFind.matches(in: "a ( b", query: "(", options: regex), [])
        XCTAssertNil(SourceFind.patternError("(", options: MarkdownFindOptions()))
        XCTAssertNil(SourceFind.patternError("", options: regex))
        // The whole-word wrapper must not balance a stray parenthesis into a valid pattern.
        XCTAssertEqual(SourceFind.patternError("a)|(b", options: .init(wholeWord: true, regex: true)), "invalid regex")
        XCTAssertEqual(SourceFind.replaceAll(in: "a ( b", query: "(", options: regex, with: "x").count, 0)
    }

    func testAScopeLimitsMatchesButTheTextAroundItStillDecidesEdges() {
        let text = "alpha beta alpha\nGamma ALPHA\n"
        let scope = NSRange(location: 5, length: 12)
        XCTAssertEqual(SourceFind.matches(in: text, query: "alpha", within: scope), [NSRange(location: 11, length: 5)])
        // "alpha" at the start of a scope inside "alphabet" is still part of a longer word.
        let whole = MarkdownFindOptions(wholeWord: true)
        XCTAssertEqual(SourceFind.matches(in: "alphabet", query: "alpha", options: whole, within: NSRange(location: 0, length: 5)), [])
        // A scope that starts mid-line is not a line start for `^`.
        let regex = MarkdownFindOptions(regex: true)
        XCTAssertEqual(SourceFind.matches(in: text, query: "^beta", options: regex, within: NSRange(location: 6, length: 4)), [])
        // A scope past the end is clamped, not a crash.
        XCTAssertEqual(SourceFind.matches(in: "alpha", query: "alpha", within: NSRange(location: 0, length: 99)).count, 1)
    }

    func testReplaceUsesTheOptionsTheScopeAndRegexGroups() {
        let exact = SourceFind.replaceAll(in: "Alpha alpha", query: "alpha", options: .init(matchCase: true), with: "x")
        XCTAssertEqual(exact.text, "Alpha x")
        let scoped = SourceFind.replaceAll(
            in: "alpha alpha alpha", query: "alpha", within: NSRange(location: 6, length: 11), with: "x"
        )
        XCTAssertEqual(scoped.text, "alpha x x")
        XCTAssertEqual(scoped.count, 2)
        // With regex on the replacement is a template; without it `$1` is text.
        let regex = MarkdownFindOptions(regex: true)
        XCTAssertEqual(
            SourceFind.replaceAll(in: "alice@example.com", query: "(\\w+)@(\\w+)", options: regex, with: "$2 at $1").text,
            "example at alice.com"
        )
        XCTAssertEqual(SourceFind.replaceAll(in: "a1", query: "a", with: "$1").text, "$11")
        let one = SourceFind.replacement(
            for: NSRange(location: 0, length: 6), in: "key=42 rest", query: "(\\w+)=(\\d+)", options: regex, template: "$2:$1"
        )
        XCTAssertEqual(one, "42:key")
    }

    func testTheSeedIsOneLineOfRealText() {
        XCTAssertEqual(SourceFind.seed(from: "plan", regex: false), "plan")
        XCTAssertEqual(SourceFind.seed(from: "a.b(c)", regex: true), "a\\.b\\(c\\)")
        XCTAssertNil(SourceFind.seed(from: "two\nlines", regex: false))
        XCTAssertNil(SourceFind.seed(from: "   ", regex: false))
        XCTAssertNil(SourceFind.seed(from: "", regex: false))
        XCTAssertNil(SourceFind.seed(from: String(repeating: "x", count: 201), regex: false))
    }

    func testTheSnippetKeepsTheMatchInView() {
        let short = SourceFind.snippet(in: "intro\n    - [ ] call alice\nend", around: NSRange(location: 21, length: 5))
        XCTAssertEqual(short.text, "- [ ] call alice")
        XCTAssertEqual((short.text as NSString).substring(with: short.match), "alice")

        let long = String(repeating: "word ", count: 40) + "needle" + String(repeating: " tail", count: 40)
        let at = (long as NSString).range(of: "needle")
        let cut = SourceFind.snippet(in: long, around: at, width: 40)
        XCTAssertTrue(cut.text.hasPrefix("…"))
        XCTAssertTrue(cut.text.hasSuffix("…"))
        XCTAssertLessThanOrEqual(cut.text.count, 42)
        XCTAssertEqual((cut.text as NSString).substring(with: cut.match), "needle")
    }

    func testSteppingWrapsAtBothEnds() {
        XCTAssertEqual(SourceFind.step(count: 3, current: 0, delta: 1), 1)
        XCTAssertEqual(SourceFind.step(count: 3, current: 3, delta: 1), 1)
        XCTAssertEqual(SourceFind.step(count: 3, current: 1, delta: -1), 3)
        XCTAssertEqual(SourceFind.step(count: 0, current: 0, delta: 1), 0)
        // A fresh search starts from where the caret is.
        let hits = SourceFind.matches(in: "alpha beta alpha", query: "alpha")
        XCTAssertEqual(SourceFind.firstMatch(after: 5, in: hits), 2)
        XCTAssertEqual(SourceFind.firstMatch(after: 99, in: hits), 1)
    }

    func testReplaceOneAndAll() {
        let text = "alpha beta alpha"
        let one = SourceFind.replace(in: text, match: NSRange(location: 0, length: 5), with: "omega")
        XCTAssertEqual(one.text, "omega beta alpha")
        XCTAssertEqual(one.next, 5)

        let all = SourceFind.replaceAll(in: "alpha ALPHA", query: "alpha", with: "x")
        XCTAssertEqual(all.text, "x x")
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(SourceFind.replaceAll(in: "none", query: "alpha", with: "x").count, 0)
    }

    func testTheFindBarWalksAndReplacesInTheOpenDocument() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-find-\(UUID().uuidString)")!)
        model.open([file])
        model.setMode(.source)
        XCTAssertTrue(model.findsInSource)
        XCTAssertTrue(model.supportsFind)

        model.findQuery = "alpha"
        model.search()
        XCTAssertEqual(model.findCount, 3)
        XCTAssertEqual(model.findIndex, 1)
        XCTAssertEqual(model.sourceSelection?.range, NSRange(location: 0, length: 5))

        model.stepFind(1)
        XCTAssertEqual(model.findIndex, 2)
        XCTAssertEqual(model.sourceSelection?.range, NSRange(location: 11, length: 5))
        // Walking past the end wraps.
        model.stepFind(1)
        model.stepFind(1)
        XCTAssertEqual(model.findIndex, 1)

        model.replaceText = "omega"
        model.replaceCurrent()
        XCTAssertEqual(model.selected?.displayText.hasPrefix("omega beta alpha"), true)
        XCTAssertEqual(model.findCount, 2)
        XCTAssertTrue(model.selected?.isDirty == true)

        model.replaceAll()
        XCTAssertEqual(model.selected?.displayText, "omega beta omega\nGamma omega\n")
        XCTAssertEqual(model.findCount, 0)
        XCTAssertNil(model.sourceSelection)

        // Back in the reading view the bar drives the page instead.
        model.setMode(.preview)
        XCTAssertFalse(model.findsInSource)
    }

    /// In the reading view the bar still marks matches in the page, so the
    /// source path must not steal it.
    func testPreviewModeKeepsTheWebFind() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-find-\(UUID().uuidString)")!)
        model.open([file])
        model.setMode(.preview)
        model.findQuery = "alpha"
        model.search()
        // Nothing was selected in the editor; the token went to the web view.
        XCTAssertNil(model.sourceSelection)
        XCTAssertEqual(model.findCommand.query, "")   // the bar is closed
        model.openFind()
        XCTAssertEqual(model.findCommand.query, "alpha")
    }
}
