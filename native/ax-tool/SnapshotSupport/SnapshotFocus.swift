import Foundation

/// A focused sheet belongs to the observed window only while the live attachment chain reaches it.
public func focusedWindowBelongsToOwner(
    owner: CFTypeRef,
    focused: CFTypeRef,
    attachedSheets: (CFTypeRef) -> [CFTypeRef],
    maximumNodes: Int = 64
) -> Bool {
    if CFEqual(owner, focused) { return true }
    var visited = SnapshotObjectSet()
    var pending: [CFTypeRef] = [owner]
    var inspected = 0
    while let current = pending.popLast() {
        guard visited.insert(current) else { continue }
        inspected += 1
        guard inspected <= maximumNodes else { return false }
        for sheet in attachedSheets(current) {
            if CFEqual(sheet, focused) { return true }
            pending.append(sheet)
        }
    }
    return false
}
