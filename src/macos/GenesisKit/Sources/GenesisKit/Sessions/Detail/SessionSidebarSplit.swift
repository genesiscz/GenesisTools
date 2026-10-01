import SwiftUI

/// The session screen's transcript and its details sidebar (SessionDetailScreen.swift).
/// Wide enough for both, they sit side by side; narrower, the sidebar covers the transcript's trailing
/// edge. The screen never grows past its frame: as an HStack of the transcript (`minWidth: 460`) and the
/// 301 pt sidebar it grew to 761 pt in a narrower pane, the parent clipped both edges, and the sidebar
/// and the header's sidebar toggle went off screen (2026-09-25).
public struct SessionSidebarSplit: Layout {
    /// The details sidebar; the screen draws a 1 pt hairline before it.
    public static let sidebarWidth: CGFloat = 300

    public var mainMinWidth: CGFloat = 460

    public init(mainMinWidth: CGFloat = 460) {
        self.mainMinWidth = mainMinWidth
    }

    /// True when the sidebar has to cover the transcript at this width.
    public static func overlays(width: CGFloat, sidebar: CGFloat, mainMinWidth: CGFloat) -> Bool {
        width - sidebar < mainMinWidth
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let main = subviews.first else {
            return
        }

        guard subviews.count > 1, let sidebar = subviews.last else {
            main.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            return
        }

        let sidebarWidth = min(sidebar.sizeThatFits(ProposedViewSize(width: nil, height: bounds.height)).width, bounds.width)
        let covers = Self.overlays(width: bounds.width, sidebar: sidebarWidth, mainMinWidth: mainMinWidth)
        let mainWidth = covers ? bounds.width : bounds.width - sidebarWidth
        main.place(at: bounds.origin, proposal: ProposedViewSize(width: mainWidth, height: bounds.height))
        sidebar.place(at: CGPoint(x: bounds.maxX - sidebarWidth, y: bounds.minY), proposal: ProposedViewSize(width: sidebarWidth, height: bounds.height))
    }
}
