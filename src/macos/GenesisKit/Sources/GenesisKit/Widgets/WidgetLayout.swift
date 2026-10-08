import Foundation

public struct WidgetLayoutConfiguration: Codable, Equatable, Sendable {
    public var topModules: [String]
    public var sideGroups: [[String]]
    public var separated: Bool
    public var sidePosition: Double
    public var hoverPreviews: Bool

    public init(
        topModules: [String] = ["agents"],
        sideGroups: [[String]] = [["agents"], ["capture", "shelf"], ["focus", "voice", "tasks"]],
        separated: Bool = false, sidePosition: Double = 0.5, hoverPreviews: Bool = true
    ) {
        self.topModules = Self.unique(topModules)
        self.sideGroups = Array(sideGroups.prefix(3)).map(Self.unique)
        while self.sideGroups.count < 3 { self.sideGroups.append([]) }
        self.separated = separated
        self.sidePosition = sidePosition.isFinite ? min(1, max(0, sidePosition)) : 0.5
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

struct WidgetSideStripMetrics {
    static let width: CGFloat = 44
    static let verticalPadding: CGFloat = 4
    static let dragWidth: CGFloat = 40
    static let dragHeight: CGFloat = 21
    static let settingsWidth: CGFloat = 32
    static let settingsHeight: CGFloat = 24
    static let addWidth: CGFloat = 34
    static let addHeight: CGFloat = 30
    static let sessionWidth: CGFloat = 34
    static let sessionHeight: CGFloat = 17
    static let sessionSpacing: CGFloat = 6
    static let minimumSpacer: CGFloat = 2
    static let sessionLimit = 4

    let classic: Bool
    let moduleCount: Int
    let sessionCount: Int

    init(classic: Bool, moduleIDs: [String], visibleSessionCount: Int) {
        self.classic = classic
        moduleCount = moduleIDs.count
        sessionCount = moduleIDs.contains("agents") ? min(Self.sessionLimit, max(0, visibleSessionCount)) : 0
    }

    var spacing: CGFloat { classic ? 5 : 7 }
    var moduleSize: CGFloat { classic ? 28 : 32 }

    var fixedOverflowChromeHeight: CGFloat {
        Self.verticalPadding * 2 + Self.dragHeight + Self.settingsHeight + spacing * 2
    }

    var minimumHeight: CGFloat {
        let modules = moduleCount == 0 ? Self.addHeight : CGFloat(moduleCount) * moduleSize
        let sessions = CGFloat(sessionCount) * Self.sessionHeight
            + CGFloat(max(0, sessionCount - 1)) * Self.sessionSpacing
        // Drag handle, settings and flexible spacer are always arranged children.
        let childCount = max(1, moduleCount) + 3 + (sessionCount > 0 ? 1 : 0)
        return Self.verticalPadding * 2 + Self.dragHeight + Self.settingsHeight + Self.minimumSpacer
            + modules + sessions + CGFloat(childCount - 1) * spacing
    }
}

public enum WidgetClusterGeometry {
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
