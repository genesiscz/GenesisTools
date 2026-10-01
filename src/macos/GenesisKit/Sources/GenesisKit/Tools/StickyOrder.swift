import Foundation

/// A list order that does not jump on refresh. Rows sit in two buckets, active first. A refresh keeps
/// the previous order as the base: it only puts NEW rows at the top of their bucket and moves a row
/// that changed bucket to the top of its new one. Within a bucket nothing is re-sorted by recency.
///
/// Hysteresis: a row turns active at once, but leaves the active bucket only `hold` seconds after it
/// was last seen active, so a turn boundary does not bounce it. `hold: true` on `update` freezes every
/// move (the pointer is over the list): known rows keep their places and new rows go to the end, and the
/// next update without hold applies the moves. `resort` sorts everything again (an explicit action).
public struct StickyOrder<ID: Hashable> {
    public struct Item {
        public let id: ID
        public let active: Bool
        public let lastAt: Date

        public init(id: ID, active: Bool, lastAt: Date) {
            self.id = id
            self.active = active
            self.lastAt = lastAt
        }
    }

    public let hold: TimeInterval
    public private(set) var order: [ID] = []
    private var bucket: [ID: Bool] = [:]
    private var lastSeenActive: [ID: Date] = [:]

    public init(hold: TimeInterval = 120) {
        self.hold = hold
    }

    /// True when the row is in the active bucket (active now, or within `hold` of it).
    public func isActive(_ id: ID) -> Bool {
        bucket[id] ?? false
    }

    @discardableResult
    public mutating func update(_ items: [Item], now: Date = Date(), resort: Bool = false, hold holding: Bool = false) -> [ID] {
        let present = Set(items.map(\.id))
        for item in items where item.active {
            lastSeenActive[item.id] = now
        }
        lastSeenActive = lastSeenActive.filter { present.contains($0.key) }
        let wanted = Dictionary(items.map { item in
            (item.id, item.active || lastSeenActive[item.id].map { now.timeIntervalSince($0) < hold } ?? false)
        }, uniquingKeysWith: { first, _ in first })
        let lastAt = Dictionary(items.map { ($0.id, $0.lastAt) }, uniquingKeysWith: { first, _ in first })
        let recent: (ID, ID) -> Bool = { (lastAt[$0] ?? .distantPast) > (lastAt[$1] ?? .distantPast) }
        let kept = order.filter { present.contains($0) }
        let known = Set(kept)
        let fresh = items.map(\.id).filter { !known.contains($0) }

        if holding, !order.isEmpty, !resort {
            // Nothing moves: known rows stay put, new ones wait at the end, buckets stay as they were.
            for id in fresh {
                bucket[id] = wanted[id] ?? false
            }
            order = kept + fresh.sorted(by: recent)
            return order
        }

        if resort || order.isEmpty {
            order = items.map(\.id).sorted { left, right in
                let a = wanted[left] ?? false
                let b = wanted[right] ?? false
                return a != b ? a : recent(left, right)
            }
            bucket = wanted
            return order
        }

        // New rows and rows that changed bucket go to the top of their bucket, newest first.
        let movers = kept.filter { bucket[$0] != wanted[$0] }
        let moved = Set(movers)
        let arriving = (fresh + movers).sorted(by: recent)
        let activeTop = arriving.filter { wanted[$0] ?? false }
        let inactiveTop = arriving.filter { !(wanted[$0] ?? false) }
        let staying = kept.filter { !moved.contains($0) }
        order = activeTop + staying.filter { wanted[$0] ?? false } + inactiveTop + staying.filter { !(wanted[$0] ?? false) }
        bucket = wanted
        return order
    }
}
