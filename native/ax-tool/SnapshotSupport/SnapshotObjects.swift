import Foundation

/// AX graphs may share objects; equal hashes alone do not establish object identity.
public struct SnapshotObjectSet {
    private var buckets: [CFHashCode: [CFTypeRef]] = [:]
    public init() {}

    public mutating func insert(_ object: CFTypeRef) -> Bool {
        let hash = CFHash(object)
        if buckets[hash, default: []].contains(where: { CFEqual($0, object) }) {
            return false
        }
        buckets[hash, default: []].append(object)
        return true
    }
}
