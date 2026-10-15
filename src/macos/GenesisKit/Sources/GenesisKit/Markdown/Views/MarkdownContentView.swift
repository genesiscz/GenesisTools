//
//  MarkdownContentView.swift
//  GenesisKit
//
//  The one native markdown renderer both apps share: the vault's native reading
//  pane (MarkdownPreviewView, block by block), chat and the companion HUD
//  (Genesis), the PR description, the review threads and the inbox context
//  (GenesisTools, which had its own copy until 2026-10-13), and the session
//  transcript in both. One parser (MarkdownBlocks), one block view, and a
//  MarkdownStyle a caller tunes: fonts, colours, spacing, the code block's look,
//  text selection and links.
//
//  MarkdownContentView is a VStack of blocks with no ScrollView and no
//  background: the caller owns the container. What it parses is cached
//  (NSCache): a transcript row's body runs every time the list re-measures, and
//  parsing in the body was in 73 of the 179 transcript stall stacks of
//  2026-09-29/30.
//
//  A host's find marks its matches through `markdownFindMarks` (GenesisTools'
//  panel find sets it with `.findField`). `searchBlocks` lists the text of each
//  unit the view marks (a paragraph, a heading, a list item, a table cell), in
//  the order the view draws them, so a match's index names its unit.
//

import AppKit
import SwiftUI

/// Visual knobs, so one renderer serves the near-black vault pane, chat, the teal companion HUD, the
/// transcript and GenesisTools' panels. `MarkdownStyle()` is the vault's look. Every field is a `var`:
/// start from a preset and change what the surface needs (`MarkdownStyle.chat.with { $0.bodySize = 12 }`).
public struct MarkdownStyle: Equatable, Sendable {
    /// Which text the reader can select. A selectable block is a selection overlay view, a focus ring
    /// and a key-view entry per paragraph, which a long list pays for on every row whether or not it
    /// is pointed at.
    public enum Selection: Sendable {
        case none
        case codeOnly
        case all
    }

    public var bodySize: CGFloat = 13
    public var textColor: Color = .settingsText
    public var secondaryColor: Color = .settingsTextSecondary
    public var mutedColor: Color = .settingsTextMuted
    /// Bullets, ordered markers, the quote bar.
    public var accentColor: Color = .neonAmber
    public var codeColor: Color = .neonCyan
    public var codeBackground: Color = Color.black.opacity(0.35)
    public var taskDoneColor: Color = .genSuccess
    public var lineSpacing: CGFloat = 3
    public var blockSpacing: CGFloat = 10
    /// Multiplies heading sizes (the companion runs a touch smaller than the vault).
    public var headingScale: CGFloat = 1
    /// Paragraphs in the monospaced font.
    public var monoBody: Bool = false

    // MARK: Headings

    /// h1 to h6, in points, before `headingScale`.
    public var headingSizes: [CGFloat] = [22, 18, 15, 13, 13, 13]
    /// h1 to h6.
    public var headingWeights: [Font.Weight] = [.bold, .bold, .semibold, .semibold, .semibold, .semibold]
    /// h3 and below in `secondaryColor`. Off: every heading in `textColor`.
    public var dimsMinorHeadings = true

    // MARK: Code

    /// Fenced code's size. nil = `bodySize - 1.5`, so it follows the body.
    public var codeFontSize: CGFloat? = 11
    /// Fenced blocks in syntax colours by their language (```tsx).
    public var highlightsCode = false
    /// Long lines wrap. Off: the block scrolls sideways and keeps its lines whole.
    public var codeWraps = false
    /// The fence's language above the block.
    public var codeShowsLanguage = true
    /// A Copy button above the block (beside the language).
    public var codeCopyButton = false
    public var codePadding: CGFloat = 10
    public var codeCornerRadius: CGFloat = GenRadius.sm
    /// A fill behind `inline code`. nil keeps only the monospace.
    public var inlineCodeBackground: Color?

    // MARK: Quotes

    /// nil = `accentColor` at 70 %.
    public var quoteBarColor: Color?
    public var quoteItalic = true

    // MARK: Text and links

    public var selection: Selection = .codeOnly
    /// `[[Note]]` becomes a link that `MarkdownContentView(onWikilink:)` receives. Off: it stays text.
    public var wikilinks = true
    /// Links in this colour. nil = the environment's tint.
    public var linkColor: Color?
    /// The HTML GitHub and review bots write (`<details><summary>`, `<!-- -->`, `<br>`, `<b>`) becomes
    /// markdown or goes, instead of showing as tags. Fenced code is left alone.
    public var cleansHTML = true

    public init() {}

    /// A copy with `change` applied.
    public func with(_ change: (inout MarkdownStyle) -> Void) -> MarkdownStyle {
        var copy = self
        change(&copy)
        return copy
    }

    public static let vault = MarkdownStyle()

    public static let chat = MarkdownStyle().with {
        $0.bodySize = 13.5
        $0.blockSpacing = 9
    }

    /// Companion HUD: teal accents, assistant ink, tighter spacing.
    public static let companion = MarkdownStyle().with {
        $0.bodySize = 14
        $0.textColor = .companionAssistInk
        $0.secondaryColor = .companionInk
        $0.mutedColor = .companionDim
        $0.accentColor = .companionTeal
        $0.codeColor = Color(red: 0xC6 / 255.0, green: 0xF2 / 255.0, blue: 0xE6 / 255.0)
        $0.codeBackground = Color.companionTeal.opacity(0.08)
        $0.taskDoneColor = .companionTeal
        $0.blockSpacing = 8
        $0.headingScale = 0.82
    }

    /// Session Details transcript: sized for the 720-wide details window (headings, tables, fenced code).
    public static let transcript = MarkdownStyle().with {
        $0.bodySize = 12.5
        $0.textColor = .genTextSecondary
        $0.secondaryColor = .genTextMuted
        $0.mutedColor = .genTextMuted
        $0.accentColor = .genAccent
        $0.codeColor = .genTextPrimary
        $0.codeBackground = Color.genSurfaceElevated
        $0.blockSpacing = 8
        $0.headingScale = 0.88
    }

    /// The "You" row and the chat user bubble: dimmer, no heading emphasis needed.
    public static let companionUser = MarkdownStyle().with {
        $0.textColor = .companionInk
        $0.secondaryColor = .companionInk
        $0.mutedColor = .companionDim
        $0.accentColor = .companionTealDim
        $0.codeColor = Color(red: 0xC6 / 255.0, green: 0xF2 / 255.0, blue: 0xE6 / 255.0)
        $0.codeBackground = Color.companionTeal.opacity(0.06)
        $0.taskDoneColor = .companionTeal
        $0.blockSpacing = 6
        $0.headingScale = 0.8
    }
}

extension MarkdownStyle {
    /// The transcript's style (`GenesisKitHost.transcriptMarkdown`) as a markdown style. The rows turn
    /// selection on under the pointer (`hoverTextSelection`), so the blocks do not hold it themselves,
    /// and code wraps: a sideways scroller per block in every row is what a long transcript cannot pay.
    public init(_ transcript: TranscriptMarkdownStyle) {
        self.init()
        bodySize = transcript.bodySize
        textColor = transcript.textColor
        secondaryColor = transcript.secondaryColor
        mutedColor = transcript.mutedColor
        accentColor = transcript.accentColor
        codeColor = transcript.codeColor
        codeBackground = transcript.codeBackground
        taskDoneColor = transcript.taskDoneColor
        lineSpacing = transcript.lineSpacing
        blockSpacing = transcript.blockSpacing
        headingScale = transcript.headingScale
        selection = .none
        codeFontSize = nil
        codeWraps = true
    }
}

// MARK: - Find marks

/// A host's find, marking its matches inside a `MarkdownContentView`. `mark` tints the matches in one
/// unit's shown text; `anchor` names the unit's scroll target (`.id`), nil for none. A unit is one text
/// the view draws (a paragraph, a heading, a list item, a code block, a table cell), numbered in the
/// order `MarkdownContentView.searchBlocks` lists them. Equal when `id` is: a closure cannot be compared,
/// so the id carries everything the marks depend on.
public struct MarkdownFindMarks: Equatable {
    public let id: AnyHashable
    public let mark: (inout AttributedString, _ unit: Int) -> Void
    public let anchor: (_ unit: Int) -> String?

    public init(id: AnyHashable, mark: @escaping (inout AttributedString, _ unit: Int) -> Void, anchor: @escaping (_ unit: Int) -> String?) {
        self.id = id
        self.mark = mark
        self.anchor = anchor
    }

    public static func == (lhs: MarkdownFindMarks, rhs: MarkdownFindMarks) -> Bool {
        lhs.id == rhs.id
    }
}

private struct MarkdownFindMarksKey: EnvironmentKey {
    static let defaultValue: MarkdownFindMarks? = nil
}

extension EnvironmentValues {
    /// The enclosing find's marks for the `MarkdownContentView`s below. nil = no find.
    public var markdownFindMarks: MarkdownFindMarks? {
        get { self[MarkdownFindMarksKey.self] }
        set { self[MarkdownFindMarksKey.self] = newValue }
    }
}

// MARK: - View

/// A stack of rendered markdown blocks. No ScrollView, no background: wrap it in whatever container
/// the surface needs.
public struct MarkdownContentView: View {
    let markdown: String
    var style: MarkdownStyle
    /// When set, wikilinks are routed here (`style.wikilinks`).
    var onWikilink: ((String) -> Void)?

    public init(markdown: String, style: MarkdownStyle = .vault, onWikilink: ((String) -> Void)? = nil) {
        self.markdown = markdown
        self.style = style
        self.onWikilink = onWikilink
    }

    public var body: some View {
        let blocks = MarkdownRenderCache.blocks(markdown, cleansHTML: style.cleansHTML)
        let firstUnits = MarkdownRenderCache.firstUnits(blocks)
        VStack(alignment: .leading, spacing: style.blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                MarkdownBlockView(block: block, style: style, firstUnit: firstUnits[index])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(MarkdownLinkTint(color: style.linkColor))
        .modifier(WikilinkRouting(onWikilink: onWikilink))
    }

    /// The text of every unit the view draws, in order (see `MarkdownFindMarks`): what a host's find
    /// matches, so the n-th entry is the unit its n-th mark lands in.
    public nonisolated static func searchBlocks(_ markdown: String, style: MarkdownStyle = MarkdownStyle()) -> [String] {
        MarkdownRenderCache.blocks(markdown, cleansHTML: style.cleansHTML).flatMap { MarkdownRenderCache.unitTexts($0, style: style) }
    }

    /// A fence line: its character, its length and what follows it (the info string), trimmed.
    public nonisolated static func fenceMarker(_ line: String) -> (mark: Character, count: Int, info: String)? {
        MarkdownBlocks.fenceMarker(line)
    }

    /// A fence's language from its info string (```tsx title="x" is TypeScript), as GenesisKit's token
    /// highlighter knows them; `.plain` (no colour) for an unlabelled fence or an unknown name. The web
    /// cards map the same names (web/diff-viewer/code-lang.ts).
    public nonisolated static func fenceLanguage(_ info: String) -> SyntaxLanguage {
        MarkdownRenderCache.fenceLanguage(info)
    }

    /// A fenced block in GenesisKit's token colours (`SyntaxHighlighter`), cached per language and
    /// text. Long blocks keep their first 400 lines coloured and the rest plain.
    public nonisolated static func highlighted(_ text: String, info: String) -> AttributedString {
        MarkdownRenderCache.highlighted(text, info: info)
    }

    /// Inline markdown with every code span on `codeBackground`.
    public nonisolated static func inline(_ text: String, codeBackground: Color) -> AttributedString {
        MarkdownRenderCache.inline(text, wikilinks: false, codeBackground: codeBackground)
    }
}

/// Installs the `genesiswiki:` openURL interceptor only when a handler is set.
private struct WikilinkRouting: ViewModifier {
    let onWikilink: ((String) -> Void)?
    func body(content: Content) -> some View {
        if let onWikilink {
            content.environment(\.openURL, OpenURLAction { url in
                if url.scheme == "genesiswiki" {
                    let raw = url.absoluteString.replacingOccurrences(of: "genesiswiki:", with: "")
                    onWikilink(raw.removingPercentEncoding ?? raw)
                    return .handled
                }
                return .systemAction
            })
        } else {
            content
        }
    }
}

private struct MarkdownLinkTint: ViewModifier {
    let color: Color?
    func body(content: Content) -> some View {
        if let color {
            content.tint(color)
        } else {
            content
        }
    }
}

private extension View {
    @ViewBuilder
    func markdownSelectable(_ on: Bool) -> some View {
        if on {
            textSelection(.enabled)
        } else {
            self
        }
    }

    /// A unit's scroll target, only while a find asks for one.
    @ViewBuilder
    func markdownFindAnchor(_ id: String?) -> some View {
        if let id {
            self.id(id)
        } else {
            self
        }
    }
}

/// Renders one markdown block. Shared by `MarkdownContentView` and the vault's native reading pane.
struct MarkdownBlockView: View {
    let block: MarkdownBlocks.Block
    var style: MarkdownStyle = .vault
    /// The block's first find unit (see `MarkdownFindMarks`).
    var firstUnit = 0
    @Environment(\.markdownFindMarks) private var findMarks

    var body: some View {
        switch block {
        case .heading(let level, let text, _, _):
            Text(found(inline(text), firstUnit))
                .font(headingFont(level))
                .foregroundColor(level <= 2 || !style.dimsMinorHeadings ? style.textColor : style.secondaryColor)
                .markdownSelectable(style.selection == .all)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, level <= 2 ? 8 : 4)
                .markdownFindAnchor(anchor(firstUnit))
        case .paragraph(let text, _):
            Text(found(inline(text), firstUnit))
                .font(bodyFont(style.bodySize))
                .foregroundColor(style.textColor)
                .lineSpacing(style.lineSpacing)
                .markdownSelectable(style.selection == .all)
                .fixedSize(horizontal: false, vertical: true)
                .markdownFindAnchor(anchor(firstUnit))
        case .code(let language, let code, _):
            MarkdownCodeBlock(language: language, code: code, text: found(codeText(code, language), firstUnit), style: style)
                .markdownFindAnchor(anchor(firstUnit))
        case .quote(let text, _):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(style.quoteBarColor ?? style.accentColor.opacity(0.7))
                    .frame(width: 3)
                Text(found(inline(text), firstUnit))
                    .font(bodyFont(style.bodySize))
                    .foregroundColor(style.secondaryColor)
                    .italic(style.quoteItalic)
                    .lineSpacing(style.lineSpacing)
                    .markdownSelectable(style.selection == .all)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 2)
            .markdownFindAnchor(anchor(firstUnit))
        case .listItem(let indent, _, let marker, let text, let task, _):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let task {
                    Image(systemName: task ? "checkmark.square.fill" : "square")
                        .font(.system(size: 11))
                        .foregroundColor(task ? style.taskDoneColor : style.mutedColor)
                        .accessibilityLabel(task ? "Done" : "Not done")
                } else {
                    Text(marker)
                        .font(GenTypography.mono(11))
                        .foregroundColor(style.accentColor)
                }
                Text(found(inline(text), firstUnit))
                    .font(bodyFont(style.bodySize))
                    .foregroundColor(task == true ? style.mutedColor : style.textColor)
                    .strikethrough(task == true, color: style.mutedColor)
                    .lineSpacing(style.lineSpacing)
                    .markdownSelectable(style.selection == .all)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, CGFloat(indent) * 16)
            .markdownFindAnchor(anchor(firstUnit))
        case .rule:
            Rectangle().fill(style.mutedColor.opacity(0.3)).frame(height: 1).padding(.vertical, 4)
        case .frontmatter(let keys, _):
            if !keys.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "list.bullet.rectangle")
                        .font(.system(size: 9))
                        .foregroundColor(style.mutedColor)
                    ForEach(keys.prefix(8), id: \.self) { k in
                        TagPill(text: k, color: .neonPurple)
                    }
                }
            }
        case .table(let header, let aligns, let rows, _):
            tableView(header: header, aligns: aligns, rows: rows)
        }
    }

    // MARK: - Table

    private func tableView(header: [String], aligns: [MarkdownBlocks.ColumnAlign], rows: [[String]]) -> some View {
        let columns = MarkdownRenderCache.tableColumns(header: header, rows: rows)
        return Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 0) {
            GridRow {
                ForEach(0..<columns, id: \.self) { col in
                    let unit = firstUnit + col
                    Text(found(MarkdownRenderCache.headerCell(cell(header, col), wikilinks: style.wikilinks), unit))
                        .font(GenTypography.mono(10, weight: .medium))
                        .foregroundColor(style.mutedColor)
                        .tracking(0.6)
                        .frame(maxWidth: .infinity, alignment: frameAlignment(align(col, aligns)))
                        .multilineTextAlignment(textAlignment(align(col, aligns)))
                        .padding(.vertical, 4)
                        .markdownFindAnchor(anchor(unit))
                }
            }
            Divider().overlay(style.mutedColor.opacity(0.35)).gridCellColumns(columns)
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                GridRow {
                    ForEach(0..<columns, id: \.self) { col in
                        let unit = firstUnit + columns * (rowIndex + 1) + col
                        Text(found(inline(cell(row, col)), unit))
                            .font(bodyFont(style.bodySize - 0.5))
                            .foregroundColor(style.textColor)
                            .markdownSelectable(style.selection == .all)
                            .frame(maxWidth: .infinity, alignment: frameAlignment(align(col, aligns)))
                            .multilineTextAlignment(textAlignment(align(col, aligns)))
                            .padding(.vertical, 5)
                            .markdownFindAnchor(anchor(unit))
                    }
                }
                if rowIndex < rows.count - 1 {
                    Divider().overlay(style.mutedColor.opacity(0.25)).gridCellColumns(columns)
                }
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cell(_ cells: [String], _ col: Int) -> String { col < cells.count ? cells[col] : "" }
    private func align(_ col: Int, _ aligns: [MarkdownBlocks.ColumnAlign]) -> MarkdownBlocks.ColumnAlign {
        col < aligns.count ? aligns[col] : .leading
    }
    private func frameAlignment(_ a: MarkdownBlocks.ColumnAlign) -> Alignment {
        switch a { case .leading: .leading; case .center: .center; case .trailing: .trailing }
    }
    private func textAlignment(_ a: MarkdownBlocks.ColumnAlign) -> TextAlignment {
        switch a { case .leading: .leading; case .center: .center; case .trailing: .trailing }
    }

    // MARK: - Fonts, inline, find

    private func headingFont(_ level: Int) -> Font {
        let i = min(max(level, 1), 6) - 1
        let size = (i < style.headingSizes.count ? style.headingSizes[i] : style.headingSizes.last ?? 13) * style.headingScale
        let weight = i < style.headingWeights.count ? style.headingWeights[i] : .semibold
        return .system(size: size, weight: weight)
    }

    private func bodyFont(_ size: CGFloat) -> Font {
        style.monoBody ? GenTypography.mono(size) : .system(size: size)
    }

    /// Inline markdown (bold, italic, code, links), wikilinks as links when the style asks, code spans
    /// filled when it gives a fill. Cached.
    private func inline(_ text: String) -> AttributedString {
        MarkdownRenderCache.inline(text, wikilinks: style.wikilinks, codeBackground: style.inlineCodeBackground)
    }

    private func codeText(_ code: String, _ language: String?) -> AttributedString {
        style.highlightsCode ? MarkdownRenderCache.highlighted(code, info: language ?? "") : AttributedString(code)
    }

    private func found(_ text: AttributedString, _ unit: Int) -> AttributedString {
        guard let findMarks else { return text }
        var marked = text
        findMarks.mark(&marked, unit)
        return marked
    }

    private func anchor(_ unit: Int) -> String? {
        findMarks?.anchor(unit)
    }
}

// MARK: - Code block

/// A fenced block: its language and a Copy button on top when the style asks for them, then the code,
/// wrapped or scrolling sideways. `text` is the code as shown (coloured, find marks).
struct MarkdownCodeBlock: View {
    let language: String?
    let code: String
    let text: AttributedString
    var style: MarkdownStyle
    /// The text carries its own font and colours (the Native+ renderer's hljs output).
    var preStyled = false

    private var languageLabel: String? {
        guard style.codeShowsLanguage, let word = language?.split(separator: " ").first, !word.isEmpty else { return nil }
        return String(word)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if languageLabel != nil || style.codeCopyButton {
                HStack(spacing: 8) {
                    if let languageLabel {
                        Text(languageLabel)
                            .font(GenTypography.mono(9, weight: .bold))
                            .foregroundColor(style.mutedColor)
                    }
                    Spacer(minLength: 0)
                    if style.codeCopyButton {
                        MarkdownCopyButton(text: code, tint: style.mutedColor, doneTint: style.accentColor)
                    }
                }
                .padding(.horizontal, style.codePadding)
                .padding(.top, style.codeCopyButton ? 5 : 8)
            }
            if style.codeWraps {
                codeView
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(style.codePadding)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    codeView.padding(style.codePadding)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(style.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: style.codeCornerRadius))
    }

    @ViewBuilder
    private var codeView: some View {
        if preStyled {
            Text(text)
                .markdownSelectable(style.selection != .none)
                .fixedSize(horizontal: !style.codeWraps, vertical: true)
        } else {
            Text(text)
                .font(GenTypography.mono(style.codeFontSize ?? style.bodySize - 1.5))
                .foregroundColor(style.codeColor)
                .markdownSelectable(style.selection != .none)
                .fixedSize(horizontal: !style.codeWraps, vertical: true)
        }
    }
}

/// Copy for a code block: the block's text to the pasteboard, then "Copied" for a moment.
struct MarkdownCopyButton: View {
    let text: String
    var tint: Color
    var doneTint: Color
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: copy) {
            HStack(spacing: 4) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 9.5, weight: .semibold))
                Text(copied ? "Copied" : "Copy")
                    .font(.system(size: 10.5, weight: .medium))
            }
            .foregroundColor(copied ? doneTint : tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Copy the code")
        .accessibilityLabel(copied ? "Copied" : "Copy code")
        .accessibilityIdentifier("markdown-code-copy")
        // The label goes back after a moment; leaving the screen cancels the wait.
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            copied = false
        }
    }

    private func copy() {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
        withAnimation(reduceMotion ? nil : KitTheme.quick) { copied = true }
    }
}

// MARK: - Parsing and caches

/// What `MarkdownContentView` draws, worked out once per text: the blocks, the inline runs, the coloured
/// code. Pure and cached, so a host's find can match off the main thread.
enum MarkdownRenderCache {
    private final class Box<Value>: NSObject {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    nonisolated(unsafe) private static let blockCache: NSCache<NSString, Box<[MarkdownBlocks.Block]>> = {
        let cache = NSCache<NSString, Box<[MarkdownBlocks.Block]>>()
        cache.countLimit = 2000
        return cache
    }()

    nonisolated(unsafe) private static let inlineCache: NSCache<NSString, Box<AttributedString>> = {
        let cache = NSCache<NSString, Box<AttributedString>>()
        cache.countLimit = 4000
        return cache
    }()

    nonisolated(unsafe) private static let codeCache: NSCache<NSString, Box<AttributedString>> = {
        let cache = NSCache<NSString, Box<AttributedString>>()
        cache.countLimit = 500
        return cache
    }()

    static func blocks(_ markdown: String, cleansHTML: Bool) -> [MarkdownBlocks.Block] {
        let key = "\(cleansHTML ? 1 : 0)\u{0}\(markdown)" as NSString
        if let hit = blockCache.object(forKey: key) {
            return hit.value
        }
        let blocks = MarkdownBlocks.parseUncached(cleansHTML ? MarkdownBlocks.strippingHTML(markdown) : markdown)
        blockCache.setObject(Box(blocks), forKey: key)
        return blocks
    }

    /// The first find unit of every block: one per block, one per cell for a table.
    static func firstUnits(_ blocks: [MarkdownBlocks.Block]) -> [Int] {
        var next = 0
        return blocks.map { block in
            defer { next += unitCount(block) }
            return next
        }
    }

    static func unitCount(_ block: MarkdownBlocks.Block) -> Int {
        guard case .table(let header, _, let rows, _) = block else { return 1 }
        return tableColumns(header: header, rows: rows) * (rows.count + 1)
    }

    static func tableColumns(header: [String], rows: [[String]]) -> Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    /// The text each unit of `block` shows, as `MarkdownBlockView` draws it.
    static func unitTexts(_ block: MarkdownBlocks.Block, style: MarkdownStyle) -> [String] {
        func shown(_ text: String) -> String { String(inline(text, wikilinks: style.wikilinks, codeBackground: nil).characters) }
        switch block {
        case .heading(_, let text, _, _), .paragraph(let text, _), .quote(let text, _), .listItem(_, _, _, let text, _, _):
            return [shown(text)]
        case .code(_, let code, _):
            return [code]
        case .rule, .frontmatter:
            return [""]
        case .table(let header, _, let rows, _):
            let columns = tableColumns(header: header, rows: rows)
            func cell(_ row: [String], _ col: Int) -> String { col < row.count ? row[col] : "" }
            let head = (0..<columns).map { String(headerCell(cell(header, $0), wikilinks: style.wikilinks).characters) }
            return head + rows.flatMap { row in (0..<columns).map { shown(cell(row, $0)) } }
        }
    }

    /// A table's header cell: its shown text in capitals.
    static func headerCell(_ text: String, wikilinks: Bool) -> AttributedString {
        AttributedString(String(inline(text, wikilinks: wikilinks, codeBackground: nil).characters).uppercased())
    }

    static func inline(_ text: String, wikilinks: Bool, codeBackground: Color?) -> AttributedString {
        let key = "\(wikilinks ? 1 : 0)\u{0}\(codeBackground.map { "\($0)" } ?? "")\u{0}\(text)" as NSString
        if let hit = inlineCache.object(forKey: key) {
            return hit.value
        }
        let source = wikilinks ? MarkdownBlocks.wikilinksToMarkdownLinks(text) : text
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var parsed = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(text)
        if let codeBackground {
            for run in parsed.runs where run.inlinePresentationIntent?.contains(.code) == true {
                parsed[run.range].backgroundColor = codeBackground
            }
        }
        inlineCache.setObject(Box(parsed), forKey: key)
        return parsed
    }

    static func fenceLanguage(_ info: String) -> SyntaxLanguage {
        let word = info.trimmingCharacters(in: .whitespaces)
            .split(whereSeparator: { $0 == " " || $0 == "{" || $0 == "," }).first.map { $0.lowercased() } ?? ""
        switch word {
        case "": return .plain
        case "typescript", "tsx", "ts": return .typescript
        case "javascript", "jsx", "js": return .javascript
        case "shell", "console", "shellscript", "sh", "bash", "zsh": return .shell
        case "python": return .python
        case "kotlin": return .kotlin
        case "ruby": return .ruby
        case "rust": return .rust
        case "c", "cpp", "objc", "objective-c": return .cLike
        case "patch": return .plain
        default: return SyntaxLanguage.forPath("block.\(word)")
        }
    }

    static func highlighted(_ text: String, info: String) -> AttributedString {
        let language = fenceLanguage(info)
        guard language != .plain else { return AttributedString(text) }
        let key = "\(language.rawValue)\u{0}\(text)" as NSString
        if let hit = codeCache.object(forKey: key) {
            return hit.value
        }

        var highlighter = SyntaxHighlighter(language: language)
        var out = AttributedString()
        let lines = text.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            if index > 0 {
                out += AttributedString("\n")
            }
            guard index < 400 else {
                out += AttributedString(line)
                continue
            }

            let scalars = Array(line.unicodeScalars)
            var at = 0
            for (token, length) in highlighter.runs(line) {
                let end = min(scalars.count, at + length)
                var piece = AttributedString(String(String.UnicodeScalarView(scalars[at..<end])))
                if token != .plain {
                    piece.foregroundColor = token.color
                }
                out += piece
                at = end
            }
        }
        codeCache.setObject(Box(out), forKey: key)
        return out
    }
}
