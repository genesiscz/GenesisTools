import SwiftUI

// A decision's context as the hub's Inbox card shows it, drawn by one set of views in the hub and in the widget's
// decision card (Martin, 2026-11-01: "the widget doesnt show all the context of the decisions? ... i want this too in
// the widget"). The data is `DecisionRef` and `DecisionDelivery` (DecisionDetails.swift).

/// A decision's Context section: the findings that lead to it, in markdown, folded at `foldHeight` with a fade at
/// the cut and Show more / Show less while it is taller than that. A decision quoted inside it (another decision's
/// "❓ DECISION N: title" with its a) b) c) lines) is drawn as a blockquote of plain lines (`quotingDecisions`): drawn
/// as a list under the card's own options, it read as a second set of answers (hub UX council, 2026-11-09).
public struct DecisionContextSection: View {
    /// The widget's fold: about eight lines of 12 pt text.
    public static let foldHeight: CGFloat = 150
    /// The hub card's fold: two lines, so a card shows its question and options first (hub UX council, 2026-11-09).
    public static let twoLines: CGFloat = 40

    let markdown: String
    /// Open in full from the start (the widget's Decision context setting); Show less still folds it.
    let startsOpen: Bool
    /// Whole whatever the reader chose: the hub's panel find has its current match inside it.
    let forcedOpen: Bool
    let fold: CGFloat
    /// The reader's Show more / Show less; nil follows `startsOpen`.
    @State private var showAll: Bool?
    /// Taller than the fold: only then does it fade at the cut and offer Show more.
    @State private var overflows = false
    @GenReduceMotion private var reduceMotion

    public init(markdown: String, startsOpen: Bool = false, forcedOpen: Bool = false, foldHeight: CGFloat = Self.foldHeight) {
        self.markdown = Self.quotingDecisions(markdown)
        self.startsOpen = startsOpen
        self.forcedOpen = forcedOpen
        fold = foldHeight
    }

    private var revealed: Bool { (showAll ?? startsOpen) || forcedOpen }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Context").font(.system(size: 10.5, weight: .semibold)).foregroundColor(KitPalette.dim)
                Spacer()
                if overflows || showAll == true {
                    LiveButton(tooltip: nil, pressable: true) {
                        let revealing = !revealed
                        GenMotion.perform(expanding: revealing, reduceMotion: reduceMotion) { showAll = revealing }
                    } label: {
                        Text(revealed ? "Show less" : "Show more")
                    }
                        .font(.system(size: 10.5))
                        .foregroundColor(KitPalette.renamed)
                        .accessibilityValue(revealed ? "Expanded" : "Collapsed")
                }
            }
            // Folded, a long context fades out at the cut instead of ending mid-line (H16).
            let faded = overflows && !revealed
            let fold = fold
            MarkdownContentView(markdown: markdown, style: .decisionContext)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: Bool.self, of: { $0.size.height > fold + 1 }) { overflows = $0 }
                .frame(maxHeight: revealed ? nil : fold, alignment: .top)
                .clipped()
                .mask {
                    VStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: faded ? min(36, fold / 2) : 0)
                    }
                }
                // A file link in it opens by the widget's Clicking a file link setting; right-click lists the ways.
                .pathLinkMenu(markdown: markdown)
        }
        // A plain block with a rule on its left, not a filled box inside the card (P8: a card in a card).
        .leadingRule(Color.white.opacity(0.12))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension DecisionContextSection {
    /// A line that opens a quoted decision: "❓ **DECISION 11**: title", also as a heading or a list item, with the
    /// number as a link or not. The colon after it is required: a sentence that only mentions a decision is no quote.
    private static let quoteStart = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:#{1,6}\s+)?(?:[-*+]\s+)?\**\[?\s*(?:❓\s*)?\**DECISION\s+\d+\**\]?(?:\([^)]*\))?\**\s*:"#)
    /// An option line of a quoted decision: "- **a)** words", "b) words", "**(c)** words".
    private static let optionLine = try! NSRegularExpression(
        pattern: #"^\s*(?:[-*+]\s+)?\**\(?([a-z])\)\**\s*(.*)$"#)
    private static let headingMarks = try! NSRegularExpression(pattern: #"^\s{0,3}(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:❓\s*)?"#)

    /// Another decision quoted in a context becomes a blockquote: its title line says "Quoted", its description stays,
    /// and each option is a plain "a) words" line, never a list item that looks like the card's own option rows. The
    /// quote ends at the first prose line after its options, a heading, or the next quoted decision.
    public static func quotingDecisions(_ markdown: String) -> String {
        guard markdown.contains("DECISION") else { return markdown }
        func matches(_ regex: NSRegularExpression, _ line: String) -> NSTextCheckingResult? {
            regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line))
        }
        var out: [String] = []
        var quoting = false
        var seenOption = false
        var blanks = 0
        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if matches(quoteStart, line) != nil {
                if quoting { out.append(contentsOf: Array(repeating: "", count: max(blanks, 1))) }
                let range = NSRange(line.startIndex..., in: line)
                let title = headingMarks.stringByReplacingMatches(in: line, range: range, withTemplate: "")
                out.append("> Quoted: \(title)")
                quoting = true
                seenOption = false
                blanks = 0
                continue
            }
            guard quoting else {
                out.append(line)
                continue
            }
            if trimmed.isEmpty {
                blanks += 1
                continue
            }
            let heading = trimmed.hasPrefix("#")
            if let option = matches(optionLine, line), !heading,
               let letter = Range(option.range(at: 1), in: line), let words = Range(option.range(at: 2), in: line) {
                out.append(">")
                out.append("> \(line[letter])) \(line[words])")
                seenOption = true
                blanks = 0
                continue
            }
            if heading || seenOption {
                out.append(contentsOf: Array(repeating: "", count: max(blanks, 1)))
                out.append(line)
                quoting = false
                blanks = 0
                continue
            }
            if blanks > 0 { out.append(">") }
            out.append("> \(line)")
            blanks = 0
        }
        if !quoting { out.append(contentsOf: Array(repeating: "", count: blanks)) }
        return out.joined(separator: "\n")
    }
}

/// A decision's Code section: each cited `file:line` with the lines the loader read, the cited line marked, or why a
/// file has none. `root` is where a ref with no absolute path is looked for (the session's checkout).
public struct DecisionCodeSection: View {
    let refs: [DecisionRef]
    let root: String?
    /// The card's controls are live (pointer on it, the key card, a focused field): the paths are buttons too.
    @Environment(\.rowLive) private var live

    public init(refs: [DecisionRef], root: String?) {
        self.refs = refs
        self.root = root
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Code").font(.system(size: 10.5, weight: .semibold)).foregroundColor(KitPalette.dim)
            ForEach(Array(refs.enumerated()), id: \.offset) { index, ref in
                DecisionExcerpt(ref: ref, root: root, field: "ref:\(index)", cardLive: live)
            }
        }
    }
}

/// One `file:line` excerpt: the path, which opens the file at the line, and the lines, syntax highlighted, the cited
/// one marked. Long lines scroll sideways inside the block (`CodeBlockText`), so a narrow widget never wraps code.
struct DecisionExcerpt: View {
    let ref: DecisionRef
    let root: String?
    /// The panel find's key of the path (`ref:<index>`), as the hub's ⌘F lists it.
    let field: String
    /// The card around it is live; the excerpt is a row of the card's list, so it takes the card's liveness.
    let cardLive: Bool
    /// The widget's file-link handler (`.pathLinks`): a click opens the file by Clicking a file link and a right-click
    /// lists every way. Without one (the hub) a click opens the file in Cursor at the line.
    @Environment(\.pathLinkHandler) private var pathLinks

    private var file: String { ref.file(under: root) }

    private var tooltip: String {
        if pathLinks != nil {
            return "Open \(PathDisplay.tilde(file))\(ref.line.map { " at line \($0)" } ?? ""). Right-click for every way to open it."
        }
        return "Open \(file)\(ref.line.map { ":\($0)" } ?? "") in Cursor"
    }

    var body: some View {
        let _ = RenderProbe.hit("decision.excerpt.body")
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if ref.missing == true {
                    // Nothing to open: a link here opened a guessed path that does not exist.
                    let note = ref.unresolvedNote
                    KitFindText(text: ref.displayPath, field: field)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(KitPalette.dim)
                    Spacer()
                    Label(note.label, systemImage: "questionmark.folder")
                        .font(.system(size: 10.5))
                        .foregroundColor(KitPalette.dim)
                        .instantTooltip(note.detail)
                } else {
                    LiveButton(tooltip: tooltip, pressable: true) {
                        open()
                    } label: {
                        KitFindText(text: ref.displayPath, field: field)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(Color(red: 0.55, green: 0.7, blue: 1))
                    }
                    .pathLinkMenu(PathLinkRef(label: ref.displayPath, path: file, lines: ref.lines))
                    Spacer()
                }
            }
            if let excerpt = ref.excerpt, !excerpt.isEmpty {
                CodeBlockText(
                    block: CodeBlockBuilder.numbered(excerpt, start: ref.startLine ?? ref.line ?? 1,
                                                     language: SyntaxLanguage.forPath(ref.path), focus: ref.line),
                    limit: nil,
                    cacheKey: "inbox-\(ref.path):\(ref.line ?? 0)"
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                // The code reads as a block by its rule and its monospaced lines, not by a filled box (P8).
                .leadingRule(Color.white.opacity(0.12))
            }
        }
        .liveRow(selected: cardLive)
    }

    private func open() {
        if let pathLinks {
            pathLinks.perform(path: file, lines: ref.lines, menu: PathLink.isMenuClickNow)
        } else {
            PathOpener.cursor(file, line: ref.line ?? 1)
        }
    }
}

/// "High confidence": how sure the agent is of its recommended option, green, orange or red.
public struct DecisionConfidenceBadge: View {
    let level: String

    public init(_ level: String) {
        self.level = level
    }

    public static func color(_ level: String) -> Color {
        switch level.lowercased() {
        case "high": return KitPalette.added
        case "low": return KitPalette.removed
        default: return KitPalette.modified
        }
    }

    public var body: some View {
        Badge("\(level.capitalized) confidence", color: Self.color(level), look: .filled)
            .instantTooltip("How sure the agent is of its recommended option")
    }
}

/// The mark of the option the agent recommends: the same green badge on every decision surface.
public struct DecisionRecommendedBadge: View {
    public init() {}

    public var body: some View {
        Badge("Recommended", color: KitPalette.added, look: .filled)
    }
}

public extension View {
    /// A block marked by a 2 pt rule on its left, not a filled box inside a card (P8: a card in a card).
    func leadingRule(_ color: Color) -> some View {
        padding(.leading, 10)
            .overlay(alignment: .leading) { Rectangle().fill(color).frame(width: 2) }
    }
}
