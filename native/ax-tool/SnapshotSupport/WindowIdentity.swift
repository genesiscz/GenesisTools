import Foundation

/// Native IDs distinguish overlapping windows; geometry remains required and is the strict fallback.
public func matchesNativeWindowIdentity(reportedID: UInt32?, expectedID: UInt32, frameMatches: Bool) -> Bool {
    guard frameMatches else { return false }
    return reportedID.map { $0 == expectedID } ?? true
}
