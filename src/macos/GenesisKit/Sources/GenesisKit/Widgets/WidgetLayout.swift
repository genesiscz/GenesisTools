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

public enum WidgetClusterGeometry {
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
