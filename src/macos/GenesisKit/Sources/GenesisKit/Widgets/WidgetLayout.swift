import AppKit
import Foundation
import SwiftUI

/// Measures both wings before placing them, keeping a hardware cutout at the screen's center.
struct WidgetTopBarLayout: Layout {
    var cutout: CGFloat
    var notch: CGFloat = 0
    var intrinsicSizeChanged: (CGSize) -> Void = { _ in }
    var placementsMeasured: (CGSize, CGSize) -> Void = { _, _ in }
    struct Cache {
        var intrinsic: CGSize = .zero
        var plain: CGSize = .zero
        var split: CGSize = .zero
    }
    func makeCache(subviews: Subviews) -> Cache { Cache() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        guard sizes.count == 2 else { return .zero }
        let width = cutout > 0
            ? max(sizes[0].width, sizes[1].width) * 2 + cutout + 16
            : sizes[0].width + sizes[1].width + 16
        let intrinsic = CGSize(width: width, height: max(sizes[0].height, sizes[1].height))
        let plain = CGSize(width: sizes[0].width + sizes[1].width + 16, height: intrinsic.height)
        let split = CGSize(width: max(sizes[0].width, sizes[1].width) * 2 + notch + 16, height: intrinsic.height)
        if cache.intrinsic != intrinsic {
            cache.intrinsic = intrinsic
            intrinsicSizeChanged(intrinsic)
        }
        if cache.plain != plain || cache.split != split {
            cache.plain = plain
            cache.split = split
            placementsMeasured(plain, split)
        }
        return CGSize(width: min(proposal.width ?? width, width), height: intrinsic.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        guard subviews.count == 2 else { return }
        let left = subviews[0].sizeThatFits(.unspecified)
        let right = subviews[1].sizeThatFits(.unspecified)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(left))
        let rightX = cutout > 0 ? bounds.midX + cutout / 2 + 8 : bounds.minX + left.width + 16
        subviews[1].place(at: CGPoint(x: rightX, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(right))
    }
}

public struct WidgetLayoutConfiguration: Codable, Equatable, Sendable {
    public var topModules: [String]
    public var sideGroups: [[String]]
    public var separated: Bool
    public var sidePosition: Double
    /// The top bar's horizontal center, 0 (left) to 1 (right) of its travel; 0.5 is centered (split around a notch).
    public var topPosition: Double
    public var hoverPreviews: Bool

    public init(
        topModules: [String] = ["agents"],
        sideGroups: [[String]] = [["agents"], ["capture", "shelf"], ["focus", "voice", "tasks"]],
        separated: Bool = false, sidePosition: Double = 0.5, topPosition: Double = 0.5, hoverPreviews: Bool = true
    ) {
        self.topModules = Self.unique(topModules)
        self.sideGroups = Array(sideGroups.prefix(3)).map(Self.unique)
        while self.sideGroups.count < 3 { self.sideGroups.append([]) }
        self.separated = separated
        self.sidePosition = sidePosition.isFinite ? min(1, max(0, sidePosition)) : 0.5
        self.topPosition = topPosition.isFinite ? min(1, max(0, topPosition)) : 0.5
        self.hoverPreviews = hoverPreviews
    }

    public func groups(available: Set<String>) -> [[String]] {
        let groups = sideGroups.map { $0.filter(available.contains) }
        if separated { return groups }
        return [Self.unique(groups.flatMap { $0 })]
    }

    public func top(available: Set<String>) -> [String] {
        topModules.filter(available.contains)
    }

    public static func unique(_ ids: [String]) -> [String] {
        var seen: Set<String> = []
        return ids.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

struct ScreenAnchoredWidgetRail<Content: View>: NSViewRepresentable {
    let screenCenterY: CGFloat?
    let height: CGFloat
    @ViewBuilder let content: () -> Content

    func makeNSView(context: Context) -> RailView {
        RailView(content: content())
    }

    func updateNSView(_ view: RailView, context: Context) {
        view.host.rootView = content()
        view.screenCenterY = screenCenterY
        view.railHeight = height
        view.needsLayout = true
    }

    final class RailView: NSView {
        let host: NSHostingView<Content>
        var screenCenterY: CGFloat?
        var railHeight: CGFloat = 0

        init(content: Content) {
            host = NSHostingView(rootView: content)
            host.sizingOptions = []
            super.init(frame: .zero)
            addSubview(host)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func layout() {
            super.layout()
            let center = screenCenterY.map { value -> CGFloat in
                guard let window else { return bounds.midY }
                let point = window.convertFromScreen(CGRect(x: window.frame.midX, y: value, width: 0, height: 0)).origin
                return convert(point, from: nil).y
            } ?? bounds.midY
            host.frame = CGRect(x: 0, y: center - railHeight / 2, width: bounds.width, height: railHeight)
        }
    }
}

struct WidgetSideStripMetrics {
    static let width: CGFloat = 44
    static let verticalPadding: CGFloat = 12
    static let badgedModuleHeight: CGFloat = 42
    static let dragWidth: CGFloat = 40
    static let dragHeight: CGFloat = 21
    static let settingsWidth: CGFloat = 32
    static let settingsHeight: CGFloat = 24
    static let addWidth: CGFloat = 34
    static let addHeight: CGFloat = 30
    static let sessionWidth: CGFloat = 38
    static let sessionHeight: CGFloat = 34
    static let sessionSpacing: CGFloat = 6
    /// A rail session bubble's target beyond its drawn 38 by 34 pt: half the gap to each neighbour and the rail's
    /// spare width beside it, so a click between two bubbles reaches one of them (ux checklist, Hit targets).
    static let sessionHitPadding = EdgeInsets(
        top: sessionSpacing / 2, leading: (width - sessionWidth) / 2,
        bottom: sessionSpacing / 2, trailing: (width - sessionWidth) / 2)
    static let minimumSpacer: CGFloat = 2
    static let sessionLimit = 4

    let classic: Bool
    let moduleCount: Int
    let sessionCount: Int
    let hasInboxBadge: Bool

    init(classic: Bool, moduleIDs: [String], visibleSessionCount: Int, hasInboxBadge: Bool = false) {
        self.classic = classic
        moduleCount = moduleIDs.count
        self.hasInboxBadge = hasInboxBadge && moduleIDs.contains("agents")
        sessionCount = moduleIDs.contains("agents") ? min(Self.sessionLimit, max(0, visibleSessionCount)) : 0
    }

    var spacing: CGFloat { classic ? 5 : 7 }
    var moduleSize: CGFloat { classic ? 28 : 32 }

    var fixedOverflowChromeHeight: CGFloat {
        Self.verticalPadding * 2 + Self.dragHeight + Self.settingsHeight + spacing * 2
    }

    var minimumHeight: CGFloat {
        let modules = moduleCount == 0 ? Self.addHeight : CGFloat(moduleCount) * moduleSize
            + (hasInboxBadge ? Self.badgedModuleHeight - moduleSize : 0)
        let sessions = CGFloat(sessionCount) * Self.sessionHeight
            + CGFloat(max(0, sessionCount - 1)) * Self.sessionSpacing
        // Drag handle, settings and flexible spacer are always arranged children.
        let childCount = max(1, moduleCount) + 3 + (sessionCount > 0 ? 1 : 0)
        return Self.verticalPadding * 2 + Self.dragHeight + Self.settingsHeight + Self.minimumSpacer
            + modules + sessions + CGFloat(childCount - 1) * spacing
    }
}

public enum WidgetClusterGeometry {
    static func detailSize(visible: CGSize) -> CGSize {
        let width = min(960, max(560, visible.width * 0.34))
        let height = min(900, max(580, visible.height * 0.62))
        return CGSize(width: min(max(0, visible.width - 36), width),
                      height: min(max(0, visible.height - 36), height))
    }

    /// The tallest a fitted panel's content grows before it scrolls: the display's visible height less an 18 pt
    /// margin above and below, and never above 900 pt, the ceiling of the old fixed detail size (875 pt on a
    /// 1440 pt display). Below it the panel is as tall as its content (W3), so a disclosure opened inside grows the
    /// panel up to here and only what is beyond scrolls. On a laptop this is the screen less its margins, where the
    /// old 62 % rule stopped at 580 pt and made a short screen scroll the most.
    static func maximumContentHeight(visible: CGSize) -> CGFloat {
        max(0, min(900, visible.height - 36))
    }

    /// A fitted panel's content height: its measured content, never below `minimum` (a nearly empty inbox still
    /// reads as a panel) and never above `maximum`. Before the first measurement it takes the maximum.
    static func fittedHeight(measured: CGFloat?, minimum: CGFloat, maximum: CGFloat) -> CGFloat {
        min(maximum, max(minimum, measured ?? maximum))
    }

    public static func topWidth(cutout: CGFloat, moduleCount: Int) -> CGFloat {
        let otherButtons = min(4, max(0, moduleCount - 1))
        let titleWidth: CGFloat = cutout > 0 ? 24 : 110
        let fixedWidth: CGFloat = 32 + titleWidth + 64 + 20 + 24
        let overflowWidth: CGFloat = moduleCount > 5 ? 28 : 0
        return max(360, max(0, cutout) + fixedWidth + CGFloat(otherButtons) * 33 + overflowWidth)
    }

    static func allocate(
        heights: [(minimum: CGFloat, preferred: CGFloat)], visibleHeight: CGFloat, gap: CGFloat = 12
    ) -> (heights: [CGFloat], gap: CGFloat) {
        guard !heights.isEmpty else { return ([], 0) }
        let available = max(0, visibleHeight)
        let actualGap = min(max(0, gap), available / CGFloat(heights.count * 2))
        let budget = max(0, available - actualGap * CGFloat(heights.count - 1))
        let minimums = heights.map { max(0, $0.minimum) }
        let preferred = zip(heights, minimums).map { max($0.0.preferred, $0.1) }
        let minimumTotal = minimums.reduce(0, +)
        if minimumTotal > budget {
            // Cap tall rails first so a small rail does not lose usable controls unnecessarily.
            var remaining = budget
            var cap: CGFloat = 0
            for (index, height) in minimums.sorted().enumerated() {
                cap = remaining / CGFloat(minimums.count - index)
                if height >= cap { break }
                remaining -= height
            }
            return (minimums.map { min($0, cap) }, actualGap)
        }
        let preferredTotal = preferred.reduce(0, +)
        guard preferredTotal > budget else { return (preferred, actualGap) }
        let extraScale = (budget - minimumTotal) / max(1, preferredTotal - minimumTotal)
        return (zip(minimums, preferred).map { $0 + ($1 - $0) * extraScale }, actualGap)
    }

    public static func centers(
        heights: [CGFloat], position: Double, visible: CGRect, gap: CGFloat = 12
    ) -> [CGFloat] {
        guard !heights.isEmpty else { return [] }
        let desired = heights.reduce(0, +) + gap * CGFloat(max(0, heights.count - 1))
        let top = visible.maxY - max(0, visible.height - desired) * min(1, max(0, position))
        var offset: CGFloat = 0
        return heights.map { height in
            defer { offset += height + gap }
            return top - offset - height / 2
        }
    }

    public static func position(
        starting: Double, translationDown: CGFloat, clusterHeight: CGFloat, visibleHeight: CGFloat
    ) -> Double {
        let travel = max(1, visibleHeight - clusterHeight)
        return min(1, max(0, starting + translationDown / travel))
    }
}

/// Where the top bar sits on its display: the `topPosition` preference turned into a horizontal span and the notch
/// gap the bar is drawn around. Pure geometry, so it is tested without windows.
public struct WidgetTopPlacement: Equatable, Sendable {
    /// The bar's horizontal center, in screen coordinates.
    public var centerX: CGFloat
    public var width: CGFloat
    /// The notch gap the bar is split around; 0 draws it in one piece.
    public var cutout: CGFloat

    public var minX: CGFloat { centerX - width / 2 }
    public var maxX: CGFloat { centerX + width / 2 }

    /// `position` 0...1 spreads the bar's center over the room `screen` leaves a bar `width` wide (the bar in one
    /// piece), so 0 and 1 put it flush with an edge. On a display whose notch is `notch` wide (0: no notch) at the
    /// screen's center, a bar that would cover the notch snaps: with its center within the notch's half-width of the
    /// screen's center it is centered and split around the notch (the default layout, `splitWidth` wide); further out
    /// it is pushed to that side until it clears the notch, in one piece. Position 0.5 is always the centered layout.
    public static func place(
        position: Double, screen: CGRect, notch: CGFloat, width: CGFloat, splitWidth: CGFloat
    ) -> WidgetTopPlacement {
        let fraction = position.isFinite ? min(1, max(0, position)) : 0.5
        let plain = min(max(1, width), screen.width)
        let gap = max(0, notch)
        let center = screen.minX + plain / 2 + (screen.width - plain) * CGFloat(fraction)
        guard gap > 0 else { return WidgetTopPlacement(centerX: center, width: plain, cutout: 0) }
        let split = WidgetTopPlacement(centerX: screen.midX, width: min(max(1, splitWidth), screen.width), cutout: gap)
        let offset = center - screen.midX
        if abs(offset) >= (plain + gap) / 2 { return WidgetTopPlacement(centerX: center, width: plain, cutout: 0) }
        if abs(offset) <= gap / 2 { return split }
        let pushed = offset < 0 ? screen.midX - (gap + plain) / 2 : screen.midX + (gap + plain) / 2
        // A display too narrow to hold the bar beside its notch keeps the split layout.
        guard pushed - plain / 2 >= screen.minX - 0.5, pushed + plain / 2 <= screen.maxX + 0.5 else { return split }
        return WidgetTopPlacement(centerX: pushed, width: plain, cutout: 0)
    }

    /// The position after a horizontal drag of `translationRight` points that started at `starting`, for a bar
    /// `width` wide on a screen `screenWidth` wide.
    public static func position(
        starting: Double, translationRight: CGFloat, width: CGFloat, screenWidth: CGFloat
    ) -> Double {
        // A bar as wide as its screen has no room to travel: the drag keeps the stored position, so a wider display
        // later still shows the bar where it was.
        guard screenWidth > width else { return starting }
        return WidgetClusterGeometry.position(
            starting: starting, translationDown: translationRight, clusterHeight: width, visibleHeight: screenWidth)
    }

    /// How far right of a top panel's middle the bar sits. A panel wider than the bar (the preview, the expanded
    /// pane) is centered on the bar but kept on the screen (`EdgePanelGeometry.frame`), so near an edge the bar sits
    /// off the panel's middle and stays where it is in the compact panel.
    public static func stripOffset(barCenterX: CGFloat, panelWidth: CGFloat, screen: CGRect) -> CGFloat {
        let width = min(max(1, panelWidth), screen.width)
        return barCenterX - (EdgePanelGeometry.topMinX(centerX: barCenterX, width: width, screen: screen) + width / 2)
    }
}

/// Places the top strip at the top of its panel, moved off the middle so it stays over the bar's place on the screen
/// whatever the panel's width (`WidgetTopPlacement.stripOffset`). Without a center it stays in the middle.
struct WidgetTopStripPlacement: Layout {
    var barCenterX: CGFloat?
    var screen: CGRect

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let strip = subviews.first else { return .zero }
        let size = strip.sizeThatFits(proposal)
        return CGSize(width: proposal.width ?? size.width, height: proposal.height ?? size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let strip = subviews.first else { return }
        let offset = barCenterX.map {
            WidgetTopPlacement.stripOffset(barCenterX: $0, panelWidth: bounds.width, screen: screen)
        } ?? 0
        strip.place(
            at: CGPoint(x: bounds.midX + offset, y: bounds.minY), anchor: .top,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}
