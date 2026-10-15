import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The editor's scroll handler runs on every bounds change — dozens per
/// gesture. What it does per tick decides whether scrolling a 41 KB note is
/// free or is the fuel for a main-thread wedge.
@MainActor
final class MarkdownSourceEditorCostTests: XCTestCase {
    private func coordinator(text: String) -> (MarkdownSourceEditor.Coordinator, NSTextView) {
        let editor = MarkdownSourceEditor(
            text: .constant(text),
            font: .monospacedSystemFont(ofSize: 12, weight: .regular),
            textColor: .white,
            background: .black
        )
        let coordinator = editor.makeCoordinator()
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        view.string = text
        coordinator.view = view
        return (coordinator, view)
    }

    func testClearedFindSelectionCanBeRequestedAgainWithTheSameToken() throws {
        let match = MarkdownSourceSelection(range: NSRange(location: 6, length: 4), token: 1)
        func editor(_ selection: MarkdownSourceSelection?) -> MarkdownSourceEditor {
            MarkdownSourceEditor(text: .constant("alpha beta gamma"),
                                 font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                 textColor: .white, background: .black, selection: selection)
        }
        let host = NSHostingView(rootView: editor(match))
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
        func settle() {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            host.layoutSubtreeIfNeeded()
        }
        func textView(in view: NSView) -> NSTextView? {
            if let text = view as? NSTextView { return text }
            return view.subviews.lazy.compactMap { textView(in: $0) }.first
        }
        settle()
        let view = try XCTUnwrap(textView(in: host))
        XCTAssertEqual(view.selectedRange(), match.range)
        host.rootView = editor(nil)
        settle()
        view.setSelectedRange(NSRange(location: 0, length: 0))
        host.rootView = editor(match)
        settle()
        XCTAssertTrue(view === textView(in: host), "the editor is updated, not recreated")
        XCTAssertEqual(view.selectedRange(), match.range)
    }

    func testTheLineIndexIsBuiltOncePerEditNotOncePerScrollTick() {
        let body = (0..<2000).map { "line \($0) with some text on it" }.joined(separator: "\n")
        let (coordinator, view) = coordinator(text: body)

        // A scroll gesture: many reads, one index.
        for _ in 0..<200 { _ = coordinator.starts }
        XCTAssertEqual(coordinator.lineStartComputations, 1)

        // An edit invalidates it, and the new index reflects the new text.
        view.string = "one\ntwo\n"
        coordinator.invalidateLineStarts()
        XCTAssertEqual(coordinator.starts, SourceEditing.lineStarts("one\ntwo\n"))
        XCTAssertEqual(coordinator.lineStartComputations, 2)

        for _ in 0..<50 { _ = coordinator.starts }
        XCTAssertEqual(coordinator.lineStartComputations, 2, "still cached after the edit")
    }

    func testTheIndexIsCorrectForTheTextItWasBuiltFrom() {
        let (coordinator, _) = coordinator(text: "alpha\nbeta\ngamma")
        XCTAssertEqual(coordinator.starts, [0, 6, 11])
        XCTAssertEqual(SourceEditing.line(at: 7, starts: coordinator.starts), 1)
    }
}

/// The source editor's markdown colours (`MarkdownSourceHighlighter`): every element in its colour, lines that never
/// move, edits that colour only what they change, and a 3,000-line note that colours inside a frame.
@MainActor
final class MarkdownSourceColourTests: XCTestCase {
    private let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    private var windows: [NSWindow] = []

    override func tearDown() {
        windows.forEach { $0.close() }
        windows = []
        super.tearDown()
    }

    static let sample = """
    ---
    title: Colours
    ---
    # Heading **in bold**
    Plain **strong** and *em* and ***both*** and ~~gone~~ and ==marked== text.
    `code` [label](https://x.org/a) [[Target|Alias]] ![[pic.png]] ![alt](img.png) #tag https://example.org [^1]
    - item
    - [x] done task
    1. first
    > quoted
    > [!warning] Careful
    > body
    | Head | Two |
    |------|-----|
    | cell | `c` |
    ```swift
    let x = "s" // note
    ```
    ```
    plain fence
    ```
    <!-- one
    two -->
    <b>bold</b>
    ---
    ## Closed ##
    Escaped \\*not em\\*
    snake_case_name
    [^1]: The note.
    """

    /// A note of `lines` lines in the shape of a real one: prose with inline marks, lists, tasks, quotes, callouts,
    /// a table, a Swift block and a comment, repeated.
    static func longNote(lines: Int) -> String {
        var out = ["---", "title: Long note", "tags: [bench]", "---"]
        var section = 0
        while out.count < lines {
            section += 1
            out += [
                "", "## Section \(section)", "",
                "Plain text with **bold words**, *emphasis*, `inline code` and a [link](https://example.org/\(section)).",
                "Another line with a [[Wikilink]] and an [[Note#Part|alias]], an embed ![[image-\(section).png]] and #tag/\(section).",
                "", "- A list item with ~~struck~~ text", "- [ ] An open task", "- [x] A finished task", "  1. A numbered child",
                "", "> A quote with *emphasis*.", "", "> [!tip] A tip", "> Its body line.", "",
                "| Name | Value | Notes |", "|------|------:|-------|", "| one  |     1 | `x` |", "| two  |     2 | [[Link]] |", "",
                "```swift", "// A comment", "struct Item\(section) {", "    let name: String",
                "    func text() -> String { \"Hello \\(name)\" }", "}", "```", "", "<!-- a comment -->",
            ]
            for row in 0..<20 {
                out.append(row % 4 == 0
                    ? "Prose line \(row) with a **strong** word, a `code` span and a link to [[Another note]] in it."
                    : "Prose line \(row) without marks, an ordinary line of a note that someone wrote by hand today.")
            }
        }
        return out.prefix(lines).joined(separator: "\n")
    }

    private func highlighted(_ text: String, _ theme: MarkdownTheme = .genesis) -> (NSTextStorage, MarkdownSourceHighlighter) {
        let storage = NSTextStorage(string: text, attributes: [.font: font, .foregroundColor: NSColor.gray])
        let highlighter = MarkdownSourceHighlighter()
        highlighter.attach(to: storage)
        highlighter.setLook(.init(font: font, textColor: MarkdownSourceHighlighter.color(theme.textHex), theme: theme))
        return (storage, highlighter)
    }

    private static func hex(_ color: NSColor?) -> UInt32? {
        guard let rgb = color?.usingColorSpace(.sRGB) else { return nil }
        func channel(_ value: CGFloat) -> UInt32 { UInt32((value * 255).rounded()) }
        return channel(rgb.redComponent) << 16 | channel(rgb.greenComponent) << 8 | channel(rgb.blueComponent)
    }

    /// Every character of `needle` (found inside the first `context`) has `role`'s colour, and the weight, slant and
    /// strike line asked for.
    private func assertStyle(
        _ storage: NSTextStorage,
        _ needle: String,
        in context: String? = nil,
        _ role: MarkdownTheme.SourceRole,
        bold: Bool = false,
        italic: Bool = false,
        strike: Bool = false,
        theme: MarkdownTheme = .genesis,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let text = storage.string as NSString
        let outer = text.range(of: context ?? needle)
        let inner = outer.location == NSNotFound ? outer : (text.substring(with: outer) as NSString).range(of: needle)
        guard outer.location != NSNotFound, inner.location != NSNotFound else {
            return XCTFail("'\(needle)' is not in the sample", file: file, line: line)
        }
        for index in outer.location + inner.location..<outer.location + NSMaxRange(inner) {
            let attributes = storage.attributes(at: index, effectiveRange: nil)
            let traits = (attributes[.font] as? NSFont)?.fontDescriptor.symbolicTraits ?? []
            let found = (
                Self.hex(attributes[.foregroundColor] as? NSColor), traits.contains(.bold), traits.contains(.italic),
                (attributes[.strikethroughStyle] as? Int ?? 0) != 0
            )
            guard found != (theme.sourceHex(role), bold, italic, strike) else { continue }
            let character = text.substring(with: NSRange(location: index, length: 1))
            return XCTFail(
                "'\(character)' of '\(needle)': colour \(found.0.map { String($0, radix: 16) } ?? "-") bold \(found.1) italic \(found.2) strike \(found.3), "
                    + "expected \(role) (\(String(theme.sourceHex(role), radix: 16))) bold \(bold) italic \(italic) strike \(strike)",
                file: file, line: line
            )
        }
    }

    func testEveryMarkdownElementGetsItsColour() {
        let (s, _) = highlighted(Self.sample)
        assertStyle(s, "---", in: "---\ntitle", .marker)
        assertStyle(s, "title", .propertyKey)
        assertStyle(s, ":", in: "title:", .marker)
        assertStyle(s, "Colours", .propertyValue)
        assertStyle(s, "#", in: "# Heading", .marker)
        assertStyle(s, "Heading", .heading, bold: true)
        assertStyle(s, "**", in: "**in bold**", .marker)
        assertStyle(s, "in bold", .heading, bold: true)
        assertStyle(s, "Plain", .text)
        assertStyle(s, "**", in: "**strong**", .marker)
        assertStyle(s, "strong", .strong, bold: true)
        assertStyle(s, "em", in: "*em*", .emphasis, italic: true)
        assertStyle(s, "both", .strong, bold: true, italic: true)
        assertStyle(s, "gone", .strike, strike: true)
        assertStyle(s, "~~", in: "~~gone", .marker)
        assertStyle(s, "marked", .highlight)
        assertStyle(s, "`", in: "`code`", .marker)
        assertStyle(s, "code", in: "`code`", .code)
        assertStyle(s, "label", .link)
        assertStyle(s, "](", in: "[label](", .marker)
        assertStyle(s, "https://x.org/a", .url)
        assertStyle(s, "[[", in: "[[Target", .marker)
        assertStyle(s, "Target", .link)
        assertStyle(s, "|", in: "Target|Alias", .marker)
        assertStyle(s, "Alias", .link)
        assertStyle(s, "![[", in: "![[pic", .marker)
        assertStyle(s, "pic.png", .embed)
        assertStyle(s, "alt", in: "![alt]", .embed)
        assertStyle(s, "img.png", .url)
        assertStyle(s, "#tag", .tag)
        assertStyle(s, "https://example.org", .link)
        assertStyle(s, "^1", in: "[^1]\n", .link)
        assertStyle(s, "-", in: "- item", .marker)
        assertStyle(s, "item", in: "- item", .text)
        assertStyle(s, "[x]", .task)
        assertStyle(s, "done task", .strike)
        assertStyle(s, "1.", in: "1. first", .marker)
        assertStyle(s, "first", .text)
        assertStyle(s, ">", in: "> quoted", .marker)
        assertStyle(s, "quoted", .quote)
        assertStyle(s, ">", in: "> [!warning]", .calloutWarning)
        assertStyle(s, "[!warning]", .calloutWarning, bold: true)
        assertStyle(s, "Careful", .calloutWarning)
        assertStyle(s, ">", in: "> body", .calloutWarning)
        assertStyle(s, "body", .text)
        assertStyle(s, "|", in: "| Head", .marker)
        assertStyle(s, "Head", in: "| Head |", .strong, bold: true)
        assertStyle(s, "|------|-----|", .marker)
        assertStyle(s, "cell", .text)
        assertStyle(s, "c", in: "`c`", .code)
        assertStyle(s, "```", in: "```swift", .marker)
        assertStyle(s, "swift", in: "```swift", .fenceInfo)
        assertStyle(s, "let", in: "let x", .codeKeyword)
        assertStyle(s, "\"s\"", .codeString)
        assertStyle(s, "// note", .codeComment)
        assertStyle(s, "plain fence", .codeText)
        assertStyle(s, "<!-- one", .comment, italic: true)
        assertStyle(s, "two -->", .comment, italic: true)
        assertStyle(s, "<b>", .marker)
        assertStyle(s, "bold", in: "<b>bold</b>", .text)
        assertStyle(s, "</b>", .marker)
        assertStyle(s, "---", in: "\n---\n## Closed", .marker)
        assertStyle(s, "Closed", .heading, bold: true)
        assertStyle(s, "##", in: "Closed ##", .marker)
        assertStyle(s, "\\", in: "Escaped \\*", .marker)
        assertStyle(s, "*not em", .text)
        assertStyle(s, "snake_case_name", .text)
        assertStyle(s, "^1", in: "[^1]:", .link)
        assertStyle(s, "]:", in: "[^1]:", .marker)
        assertStyle(s, "The note.", .text)

        let (light, _) = highlighted(Self.sample, .light)
        assertStyle(light, "Heading", .heading, bold: true, theme: .light)
        assertStyle(light, "Target", .link, theme: .light)
        assertStyle(light, "#", in: "# Heading", .marker, theme: .light)
    }

    /// Bold and italic come from faces with the same line height and advance, so colouring moves no line.
    func testColouringNeverMovesALine() {
        let both = MarkdownSourceHighlighter.font(font, bold: true, italic: true)
        XCTAssertTrue(both.fontDescriptor.symbolicTraits.contains([.bold, .italic]), "a real bold italic face, not the fallback")
        for variant in [MarkdownSourceHighlighter.font(font, bold: true, italic: false), MarkdownSourceHighlighter.font(font, bold: false, italic: true), both] {
            XCTAssertEqual(variant.ascender, font.ascender)
            XCTAssertEqual(variant.descender, font.descender)
            XCTAssertEqual(variant.leading, font.leading)
        }
        func height(_ storage: NSTextStorage) -> CGFloat {
            let layout = NSLayoutManager()
            let container = NSTextContainer(size: NSSize(width: 100_000, height: CGFloat.greatestFiniteMagnitude))
            layout.addTextContainer(container)
            storage.addLayoutManager(layout)
            layout.ensureLayout(for: container)
            return layout.usedRect(for: container).height
        }
        let plain = NSTextStorage(string: Self.sample, attributes: [.font: font])
        let (coloured, _) = highlighted(Self.sample)
        XCTAssertEqual(height(coloured), height(plain), "same height line for line")
    }

    func testAnEmojiKeepsAFontThatHasIt() {
        let (storage, _) = highlighted("# Done 🎉 today\nplain 🎉\n")
        func emojiFont() -> String? {
            let at = (storage.string as NSString).range(of: "🎉").location
            return (storage.attribute(.font, at: at, effectiveRange: nil) as? NSFont)?.fontName
        }
        XCTAssertTrue(emojiFont()?.contains("Emoji") ?? false, "fixed after the first pass: \(emojiFont() ?? "-")")
        storage.replaceCharacters(in: NSRange(location: 2, length: 0), with: "x")
        XCTAssertTrue(emojiFont()?.contains("Emoji") ?? false, "fixed after an edit on its line: \(emojiFont() ?? "-")")
    }

    func testAnEditColoursItsLinesAndOnlyWhatItsBlockChanges() {
        let note = Self.longNote(lines: 3000)
        let lines = note.components(separatedBy: "\n")
        let (storage, highlighter) = highlighted(note)
        XCTAssertEqual(highlighter.lastLines, 0..<3000, "the first pass colours every line")

        func range(of line: Int) -> NSRange {
            NSRange(location: highlighter.starts[line], length: highlighter.starts[line + 1] - highlighter.starts[line])
        }
        func assertTouchedOnly(_ wanted: Range<Int>, file: StaticString = #filePath, line: UInt = #line) {
            XCTAssertEqual(highlighter.lastLines, wanted, file: file, line: line)
            guard let written = highlighter.lastWritten else { return XCTFail("nothing written", file: file, line: line) }
            let allowed = NSUnionRange(range(of: wanted.lowerBound), range(of: wanted.upperBound - 1))
            XCTAssertEqual(NSIntersectionRange(written, allowed), written, "attributes written outside the lines", file: file, line: line)
        }

        // Typing a word in prose: its line and the line above.
        let prose = (1500..<3000).first { lines[$0].hasPrefix("Prose line 1 ") } ?? 0
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[prose] + 5, length: 0), with: "x")
        assertTouchedOnly((prose - 1)..<(prose + 1))
        // Starting bold, and closing it: still that line.
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[prose], length: 0), with: "**")
        assertTouchedOnly((prose - 1)..<(prose + 1))
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[prose] + 8, length: 0), with: "**")
        assertTouchedOnly((prose - 1)..<(prose + 1))
        assertStyle(storage, "Prosex", in: "**Prosex**", .strong, bold: true)

        // A line of code inside its fence.
        let code = (prose..<3000).first { lines[$0].hasPrefix("    let name") } ?? 0
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[code] + 4, length: 0), with: "var ")
        assertTouchedOnly((code - 1)..<(code + 1))

        // An HTML comment opened and closed on one line.
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[prose] + 3, length: 0), with: "<!-- x -->")
        assertTouchedOnly((prose - 1)..<(prose + 1))

        // A fence opened in prose turns everything below it into code until a closing fence, here the end of the next
        // block, after which every line starts as it did before.
        let opened = (1000..<3000).first { lines[$0].hasPrefix("Prose line 5 ") } ?? 0
        let closer = (opened..<3000).first { lines[$0] == "```" } ?? 0
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[opened], length: 0), with: "```\n")
        XCTAssertEqual(highlighter.lastLines, (opened - 1)..<(closer + 2), "through the old closing fence, now one line lower")
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[opened], length: 4), with: "")
        XCTAssertEqual(highlighter.lastLines, (opened - 1)..<(closer + 1))

        // A comment left open: every line below it is comment, up to the next line that closes one.
        let closes = (opened..<3000).first { lines[$0].contains("-->") } ?? 0
        storage.replaceCharacters(in: NSRange(location: highlighter.starts[opened], length: 0), with: "<!--")
        XCTAssertEqual(highlighter.lastLines, (opened - 1)..<(closes + 1))
        let swallowed = storage.attributes(at: highlighter.starts[closes - 4] + 4, effectiveRange: nil)
        XCTAssertEqual(Self.hex(swallowed[.foregroundColor] as? NSColor), MarkdownTheme.genesis.sourceHex(.comment), "the code below it is comment")

        XCTAssertEqual(runs(storage), runs(highlighted(storage.string).0), "the same colours as one fresh pass")
    }

    /// Random edits (fences, comments, callouts, front matter, line breaks, deletions across lines), each compared
    /// with a fresh pass over the same text.
    func testIncrementalColoursMatchAFreshPassAfterEveryEdit() {
        let (storage, _) = highlighted(Self.longNote(lines: 300))
        var seed: UInt64 = 0x9e37_79b9_7f4a_7c15
        func next(_ bound: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(max(bound, 1)))
        }
        let pieces = ["```\n", "\n", "<!--", "-->", "> [!tip] T\n", "|---|---|\n", "| a | b |\n", "**", "x", "> ", "- [ ] ", "~~~\n", "`", "# ", "*"]
        for step in 0..<120 {
            let length = storage.length
            let location = next(length + 1)
            let removal = step % 3 == 0 ? min(next(60), length - location) : 0
            if step % 15 == 7 {
                storage.replaceCharacters(in: NSRange(location: 0, length: 0), with: "---\n")
            } else if step % 20 == 13 {
                // Two changes in one edit: the storage reports their union.
                storage.beginEditing()
                storage.replaceCharacters(in: NSRange(location: location, length: removal), with: pieces[next(pieces.count)])
                storage.replaceCharacters(in: NSRange(location: next(location + 1), length: 0), with: pieces[next(pieces.count)])
                storage.endEditing()
            } else {
                storage.replaceCharacters(in: NSRange(location: location, length: removal), with: pieces[next(pieces.count)])
            }
            let fresh = runs(highlighted(storage.string).0)
            guard runs(storage) == fresh else {
                return XCTFail("step \(step): the edited colours differ from a fresh pass")
            }
        }
    }

    /// Font, colour and strike line of every run, with neighbours that look the same merged.
    private func runs(_ storage: NSTextStorage) -> [String] {
        var out: [(look: String, length: Int)] = []
        storage.enumerateAttributes(in: NSRange(location: 0, length: storage.length)) { attributes, range, _ in
            let look = "\((attributes[.font] as? NSFont)?.fontName ?? "-") \(Self.hex(attributes[.foregroundColor] as? NSColor) ?? 0) \(attributes[.strikethroughStyle] as? Int ?? 0)"
            if let last = out.last, last.look == look {
                out[out.count - 1].length += range.length
            } else {
                out.append((look, range.length))
            }
        }
        return out.map { "\($0.length) \($0.look)" }
    }

    /// The budget: a full pass over a 3,000-line note inside 30 ms in an optimised build, typing well under 1 ms.
    /// A debug build is several times slower and gets a looser bound; the numbers print either way.
    func testA3000LineNoteColoursInsideTheBudget() {
        let note = Self.longNote(lines: 3000)
        var full: [Double] = []
        for _ in 0..<5 {
            let storage = NSTextStorage(string: note, attributes: [.font: font])
            let highlighter = MarkdownSourceHighlighter()
            highlighter.attach(to: storage)
            let began = DispatchTime.now().uptimeNanoseconds
            highlighter.setLook(.init(font: font, textColor: .white, theme: .genesis))
            full.append(Double(DispatchTime.now().uptimeNanoseconds - began) / 1e9)
        }
        let (storage, highlighter) = highlighted(note)
        let lines = note.components(separatedBy: "\n")
        var typing: [Double] = []
        for line in stride(from: 100, to: 2900, by: 56) where !lines[line].isEmpty {
            storage.replaceCharacters(in: NSRange(location: highlighter.starts[line] + 1, length: 0), with: "x")
            typing.append(highlighter.lastSeconds)
        }
        full.sort()
        typing.sort()
        let optimised = !_isDebugAssertConfiguration()
        print(String(
            format: "[source colours] %@ build, 3000 lines, %d characters: full pass median %.2f ms (min %.2f, max %.2f); typing median %.3f ms, max %.3f ms over %d edits",
            optimised ? "optimised" : "debug", storage.length, full[2] * 1000, full[0] * 1000, full[4] * 1000,
            typing[typing.count / 2] * 1000, typing[typing.count - 1] * 1000, typing.count
        ))
        XCTAssertLessThan(full[2], optimised ? 0.030 : 0.400)
        XCTAssertLessThan(typing[typing.count / 2], optimised ? 0.001 : 0.010)
    }

    func testEachPageColourNamesItsPaletteAndEverySourceColourReads() {
        for theme in MarkdownTheme.allCases {
            XCTAssertEqual(MarkdownTheme.palette(forPage: NSColor(theme.page)), theme.palette)
            let text = MarkdownTheme.contrastRatio(theme.sourceHex(.text), theme.pageHex)
            for role in MarkdownTheme.SourceRole.allCases {
                let ratio = MarkdownTheme.contrastRatio(theme.sourceHex(role), theme.pageHex)
                XCTAssertGreaterThanOrEqual(ratio, role.isMuted ? 3 : 4.5, "\(theme.label) \(role) is \(ratio):1 on the page")
                if role.isMuted { XCTAssertLessThan(ratio, text, "\(theme.label) \(role) steps back from the text") }
            }
        }
        XCTAssertNil(MarkdownTheme.palette(forPage: .systemRed))
    }

    private static func textView(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        return view.subviews.lazy.compactMap { textView(in: $0) }.first
    }

    /// The editor in a window that is never ordered front. Its updates (every scroll tick in split view) keep the
    /// colours, and a theme change recolours without touching the text, the selection or the undo stack.
    func testTheEditorKeepsItsColoursThroughUpdatesAndAThemeChangeTouchesNeitherTextNorUndo() throws {
        let text = "# Title\nSome **bold** text\n"
        func editor(_ theme: MarkdownTheme) -> AnyView {
            AnyView(MarkdownSourceEditor(
                text: .constant(text), font: font, textColor: NSColor(theme.text), background: NSColor(theme.page)
            ).frame(width: 400, height: 300))
        }
        let hosting = NSHostingView(rootView: editor(.genesis))
        hosting.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        windows.append(window)
        func settle() {
            hosting.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            hosting.layoutSubtreeIfNeeded()
        }
        settle()
        let view = try XCTUnwrap(Self.textView(in: hosting))
        let storage = try XCTUnwrap(view.textStorage)
        view.setSelectedRange(NSRange(location: 3, length: 2))

        for _ in 0..<3 {
            hosting.rootView = editor(.genesis)
            settle()
        }
        assertStyle(storage, "#", in: "# Title", .marker)
        assertStyle(storage, "Title", .heading, bold: true)
        assertStyle(storage, "bold", in: "**bold**", .strong, bold: true)

        hosting.rootView = editor(.light)
        settle()
        XCTAssertEqual(view.string, text)
        XCTAssertEqual(view.selectedRange(), NSRange(location: 3, length: 2))
        XCTAssertFalse(view.undoManager?.canUndo ?? true, "colours are not edits")
        assertStyle(storage, "#", in: "# Title", .marker, theme: .light)
        assertStyle(storage, "Title", .heading, bold: true, theme: .light)
        assertStyle(storage, "Some", .text, theme: .light)
    }
}
