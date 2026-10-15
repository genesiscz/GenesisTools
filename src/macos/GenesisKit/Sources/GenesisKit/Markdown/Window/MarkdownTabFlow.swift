//
//  MarkdownTabFlow.swift
//  GenesisKit
//
//  The tab row when tabs wrap (`GenesisKitMarkdownConfiguration.wrapTabs`): tabs flow left to right and
//  break onto a new row when the next one would pass the right edge, so every tab, the selected one
//  included, is always on screen. A tab wider than the row gets the row's width and truncates its title.
//

import SwiftUI

struct MarkdownTabFlow: Layout {
    var spacing: CGFloat = 2
    var rowSpacing: CGFloat = 2

    /// Which items share a row: consecutive runs whose widths plus the gaps fit `maxWidth`. An item wider
    /// than `maxWidth` gets a row of its own. Every item is in exactly one row, in order.
    static func rows(widths: [CGFloat], maxWidth: CGFloat, spacing: CGFloat) -> [Range<Int>] {
        var rows: [Range<Int>] = []
        var start = 0
        var used: CGFloat = 0
        for (index, width) in widths.enumerated() {
            if index > start, used + spacing + width > maxWidth {
                rows.append(start..<index)
                start = index
                used = width
            } else {
                used += index > start ? spacing + width : width
            }
        }
        if start < widths.count { rows.append(start..<widths.count) }
        return rows
    }

    // No cache across passes: a tab's width changes with its title (the unsaved dot), and a handful of
    // tabs measure in microseconds.

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let sizes = measure(subviews, maxWidth: maxWidth)
        let rows = Self.rows(widths: sizes.map(\.width), maxWidth: maxWidth, spacing: spacing)
        let height = rows.map { row in row.map { sizes[$0].height }.max() ?? 0 }.reduce(0, +)
            + rowSpacing * CGFloat(max(0, rows.count - 1))
        let widest = rows.map { row in
            row.map { sizes[$0].width }.reduce(0, +) + spacing * CGFloat(max(0, row.count - 1))
        }.max() ?? 0
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = measure(subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for row in Self.rows(widths: sizes.map(\.width), maxWidth: bounds.width, spacing: spacing) {
            let height = row.map { sizes[$0].height }.max() ?? 0
            var x = bounds.minX
            for index in row {
                subviews[index].place(
                    at: CGPoint(x: x, y: y),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(width: sizes[index].width, height: height)
                )
                x += sizes[index].width + spacing
            }
            y += height + rowSpacing
        }
    }

    /// Each tab's own size, no wider than the row.
    private func measure(_ subviews: Subviews, maxWidth: CGFloat) -> [CGSize] {
        subviews.map { subview in
            let ideal = subview.sizeThatFits(.unspecified)
            guard ideal.width > maxWidth else { return ideal }
            return subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
        }
    }
}
