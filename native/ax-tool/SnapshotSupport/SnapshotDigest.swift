import CoreGraphics
import CryptoKit
import Foundation

/// AX wrapper hashes belong to a client connection, not the observed app's UI state.
public func snapshotDigest(_ rows: [[String: Any]]) throws -> String {
    let observed = rows.map { $0.filter { $0.key != "identity" } }
    let bytes = try JSONSerialization.data(withJSONObject: observed, options: [.sortedKeys])
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}

public func snapshotValue(_ value: Any) -> String? {
    if let text = value as? String {
        return text
    }
    if let number = value as? NSNumber, number.doubleValue.isFinite {
        return number.stringValue
    }
    if let attributed = value as? NSAttributedString {
        return attributed.string
    }
    return nil
}

/// Quartz's window-local event field uses a top-left origin, including window chrome.
public func snapshotWindowPoint(_ screen: CGPoint, in window: CGRect) -> CGPoint {
    CGPoint(x: screen.x - window.minX, y: screen.y - window.minY)
}
