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

/// The sheets among one node's candidates (its `AXSheets` and children), read one at a time.
///
/// Each role read is a round trip to the app, so the deadline is checked before every one, and
/// a slow provider ends the scan instead of holding up input. A candidate that IS the focused
/// element is tried first: when it is a sheet, no other candidate's role is read at all.
public func attachedSheetCandidates(
    _ candidates: [CFTypeRef],
    focused: CFTypeRef,
    deadline: Date,
    now: () -> Date = Date.init,
    isSheet: (CFTypeRef) -> Bool
) -> [CFTypeRef] {
    // The lookup itself is checked against the deadline per candidate, and again before the role read.
    var focusedCandidate: CFTypeRef?
    for candidate in candidates {
        guard now() < deadline else { return [] }
        if CFEqual(candidate, focused) {
            focusedCandidate = candidate
            break
        }
    }
    if let hit = focusedCandidate, now() < deadline, isSheet(hit) {
        return [hit]
    }
    var sheets: [CFTypeRef] = []
    for candidate in candidates {
        guard now() < deadline else { break }
        if CFEqual(candidate, focused) || sheets.contains(where: { CFEqual($0, candidate) }) { continue }
        if isSheet(candidate) { sheets.append(candidate) }
    }
    return sheets
}
