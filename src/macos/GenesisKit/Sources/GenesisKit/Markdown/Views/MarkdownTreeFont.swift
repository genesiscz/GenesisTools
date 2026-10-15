//
//  MarkdownTreeFont.swift
//  GenesisKit
//
//  The file tree's text size. The sidebar's width sets a ceiling, and the rows set the size under it:
//  the largest size at which the widest name in the list still fits whole, never below a floor.
//
//  Fitting a name means knowing how wide the system font sets it at a size nobody has asked for yet,
//  so the widths are measured once per name and once per size, and a divider drag, which asks at every
//  frame, only reads them back (`MarkdownTreeDemand`).
//

import AppKit

/// The tree's text size. The sidebar's width asks for a ceiling: the configured size at the standard
/// width, one point more per 60 points of extra width, at most four more, never less. The rows decide
/// under it: the text is the largest size at which every name in the list fits whole, and never below
/// `minimum`. So a wider sidebar first shows whole names, the text grows only while they all still fit,
/// and a narrow one shrinks the text instead of cutting names in the middle. In quarter points, so a
/// divider drag changes the size smoothly without re-laying the rows at every fraction.
enum MarkdownTreeFont {
    static let pointsPerStep: Double = 60
    static let maxGrowth: Double = 4
    /// The smallest size the fit shrinks to. Below it a name is cut instead, because smaller text stops
    /// being readable before a long name stops being cut.
    static let minimum: Double = 10.5
    /// Points kept free on top of a row's inset: the measured width is exact, SwiftUI lays a text out
    /// rounded up to a whole point.
    static let slack: Double = 2

    /// The size the sidebar's width alone asks for, the ceiling of the fit. With `scales` off it is
    /// `base` as it is.
    static func size(base: Double, width: Double, scales: Bool) -> Double {
        guard scales else { return base }
        let growth = min(maxGrowth, max(0, (width - MarkdownSidebarWidth.standard) / pointsPerStep))
        return ((base + growth) * 4).rounded() / 4
    }
}

extension MarkdownTreeFont {
    /// The text size for a sidebar `width` points wide that holds `demand`'s rows: the largest quarter
    /// point at which the widest name fits whole, between `minimum` and `size(base:width:scales:)`.
    /// `reserve` is what the list's own scroller takes of the width. With `scales` off this is `base`
    /// and `demand` is not even built.
    static func size(
        base: Double,
        width: Double,
        scales: Bool,
        demand: @autoclosure () -> MarkdownTreeDemand,
        reserve: Double = 0
    ) -> Double {
        let ceiling = size(base: base, width: width, scales: scales)
        guard scales else { return ceiling }
        let room = width - reserve - 2 * Double(FileTreeMetrics.rowInset) - slack
        let rows = demand()
        var high = Int((ceiling * 4).rounded())
        if rows.widest(atQuarters: high) <= room {
            return Double(high) / 4
        }
        // `high` does not fit. `low` is kept whether it fits or not: a name is cut before the text is
        // made unreadable. A wider row never fits at a smaller size, so the answer is a bisection.
        var low = min(Int((minimum * 4).rounded()), high)
        while high - low > 1 {
            let middle = (low + high) / 2
            if rows.widest(atQuarters: middle) <= room {
                low = middle
            } else {
                high = middle
            }
        }
        return Double(low) / 4
    }

    /// The width the list's vertical scroller takes when the system keeps one beside the rows (a mouse,
    /// or "Show scroll bars: Always"). An overlay scroller takes none. It is taken whether or not this
    /// list overflows: the viewport's height is not known here, and a name cut by a scroller that
    /// appears later costs more than 15 points of text.
    static var scrollerReserve: Double {
        guard NSScroller.preferredScrollerStyle == .legacy else { return 0 }
        return Double(NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy))
    }
}

/// What a list of rows asks of the text size: for a size in quarter points, the width of its widest row.
///
/// A row is its chrome (indent, chevron, icon and gaps, which grow in proportion to the text) plus its
/// name. The name is not in proportion: San Francisco sets bigger text tighter, by the same amount for
/// every character, so a name of `n` characters is `size * (advance + n * tracking(size))` wide. The
/// advance is one measurement per name and the tracking one per size, so the first ask at a size is one
/// pass over the rows and every later ask is a lookup. Measuring the name once at a large size and
/// scaling it would read 12% too narrow at 10.5 pt, and cut the name.
final class MarkdownTreeDemand {
    /// A row: its name, and the width around it per point of text size.
    struct Line {
        let name: String
        let layout: Double
    }

    private struct Entry {
        let advance: Double
        let characters: Double
        let layout: Double
    }

    private let entries: [Entry]
    private let tracking: (Double) -> Double
    private var widths: [Int: Double] = [:]

    init(lines: [Line], measure: MarkdownTreeMeasure = .system) {
        entries = lines.map {
            Entry(advance: measure.advance($0.name), characters: Double($0.name.count), layout: $0.layout)
        }
        tracking = measure.tracking
    }

    /// The width of the widest row at `quarters / 4` points of text, without its inset.
    func widest(atQuarters quarters: Int) -> Double {
        if let known = widths[quarters] { return known }
        let size = Double(quarters) / 4
        let drift = tracking(size)
        var perPoint = 0.0
        for entry in entries {
            perPoint = max(perPoint, entry.advance + entry.characters * drift + entry.layout)
        }
        let width = perPoint * size
        widths[quarters] = width
        return width
    }
}

extension MarkdownTreeDemand.Line {
    private static let unit = FileTreeMetrics.scaled(toText: 1)
    /// SF Mono sets a character 0.6 em wide. A little over, because the line number is one point smaller
    /// than the name.
    private static let monoAdvance = 0.62

    /// A tree row (`FileTreeRowView`); `gitMark` keeps room for the git letter at its end.
    init(row: FileTreeRow, gitMark: Bool = false) {
        let mark = gitMark ? Self.unit.gitMarkWidth : 0
        self.init(name: row.name, layout: Double(Self.unit.widthBesidesName(depth: row.depth) + mark))
    }

    /// The name line of a search hit (`MarkdownFileTreeResultRow`): the icon, the name and, for a text
    /// hit, ":line" in the monospaced face, with a gap between each and before the trailing spacer.
    init(hit: FileTreeSearch.Hit) {
        var layout = Double(Self.unit.iconWidth + 2 * Self.unit.spacing)
        if let line = hit.line {
            layout += Double(Self.unit.spacing) + Double(String(line).count + 1) * Self.monoAdvance
        }
        self.init(name: hit.name, layout: layout)
    }
}

/// How wide text is, in the two numbers the fit needs. A test passes a measure that needs no font.
struct MarkdownTreeMeasure {
    /// A name's width, in points per point of text size, at the reference size.
    var advance: (String) -> Double
    /// How much wider one character is at `size` than at the reference size, in points per point of
    /// text size. Negative above the reference size: bigger text is set tighter.
    var tracking: (Double) -> Double

    static let system = MarkdownTreeMeasure(
        advance: { MarkdownTreeTextMetrics.shared.advance($0) },
        tracking: { MarkdownTreeTextMetrics.shared.tracking(at: $0) }
    )
}

/// The system font's widths, measured once and kept. Names repeat from one render to the next and from
/// one folder to the next, so a name is measured the first time any tree shows it.
///
/// Semibold, the widest weight the tree sets a name in (the selected row). A name that fits fits selected
/// or not, and selecting a row never changes the size of every other row.
final class MarkdownTreeTextMetrics {
    static let shared = MarkdownTreeTextMetrics()

    static let referenceSize: Double = 13
    /// The names kept before the cache starts over. A tree of a million files does not keep a million.
    private static let capacity = 50_000
    private static let probe = String(repeating: "i", count: 64)

    private let lock = NSLock()
    private var advances: [String: Double] = [:]
    private var trackings: [Int: Double] = [:]

    func advance(_ name: String) -> Double {
        lock.lock()
        defer { lock.unlock() }
        if let known = advances[name] { return known }
        if advances.count >= Self.capacity { advances.removeAll() }
        let advance = Self.width(of: name, at: Self.referenceSize) / Self.referenceSize
        advances[name] = advance
        return advance
    }

    /// Measured on a run of the same narrow letter: its width per point of text changes with the size
    /// only through the letter spacing, so the change over its length is the change per character.
    func tracking(at size: Double) -> Double {
        lock.lock()
        defer { lock.unlock() }
        let key = Int((size * 4).rounded())
        if let known = trackings[key] { return known }
        let count = Double(Self.probe.count)
        let reference = Self.width(of: Self.probe, at: Self.referenceSize) / Self.referenceSize
        let tracking = (Self.width(of: Self.probe, at: size) / size - reference) / count
        trackings[key] = tracking
        return tracking
    }

    private static func width(of text: String, at size: Double) -> Double {
        Double((text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: size, weight: .semibold)]).width)
    }
}

/// The demand of the list on screen, kept until the list changes. The view asks at every frame of a
/// divider drag, and comparing a list with itself is one pointer check, so only a changed list is
/// measured again.
final class MarkdownTreeFit<Source: Equatable> {
    private var source: [Source] = []
    private var demand: MarkdownTreeDemand?

    func demand(
        for source: [Source],
        measure: MarkdownTreeMeasure = .system,
        line: (Source) -> MarkdownTreeDemand.Line
    ) -> MarkdownTreeDemand {
        if let demand, self.source == source { return demand }
        let built = MarkdownTreeDemand(lines: source.map(line), measure: measure)
        self.source = source
        demand = built
        return built
    }
}
