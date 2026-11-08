import Foundation

/// A cache that keeps only the `limit` entries used last. A render reads its frames in time order, so the entry used
/// longest ago is the one the next frames need least. The owner holds its own lock around every call.
struct RecentCache<Key: Hashable, Value> {
    let limit: Int
    private var values: [Key: Value] = [:]
    /// Least recently used first.
    private var order: [Key] = []

    init(limit: Int) {
        self.limit = max(1, limit)
    }

    var count: Int { values.count }

    /// The value for `key`, which then counts as the one used last.
    mutating func value(for key: Key) -> Value? {
        guard let value = values[key] else { return nil }
        touch(key)
        return value
    }

    /// Keeps `value` for `key` and drops the entry used longest ago once there are more than `limit`.
    mutating func set(_ value: Value, for key: Key) {
        if values.updateValue(value, forKey: key) != nil {
            touch(key)
            return
        }
        order.append(key)
        if order.count > limit { values[order.removeFirst()] = nil }
    }

    private mutating func touch(_ key: Key) {
        if let index = order.lastIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }
}
