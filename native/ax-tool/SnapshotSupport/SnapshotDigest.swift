import CoreGraphics
import CryptoKit
import Foundation

/// AX wrapper hashes belong to a client connection, not the observed app's UI state.
public func snapshotDigest(_ rows: [[String: Any]]) throws -> String {
    let observed = rows.map { $0.filter { $0.key != "identity" } }
    let bytes = try JSONSerialization.data(withJSONObject: observed, options: [.sortedKeys])
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}

public func snapshotTargetKey(_ row: [String:Any], ancestors: [[String:Any]] = []) throws -> String {
    let keys: Set<String> = ["role","AXIdentifier","AXTitle","AXDescription","AXSubrole","AXURL","AXValue","AXEnabled","AXSelected","AXExpanded","actions"]
    let contextKeys: Set<String> = ["role","AXIdentifier","AXTitle","AXDescription","AXSubrole","AXURL"]
    let target = row.filter { keys.contains($0.key) }
    let context = ancestors.suffix(4).map { $0.filter { contextKeys.contains($0.key) } }
    let document = ancestors.last(where: { $0["role"] as? String == "AXWebArea" })?
        .filter { contextKeys.contains($0.key) } ?? [:]
    return try snapshotDigest([["target":target,"ancestors":context,"document":document]])
}

public func preparedTargetIndex(key: String, rows: [[String:Any]]) throws -> Int {
    let matches = rows.indices.filter { rows[$0]["targetKey"] as? String == key }
    guard matches.count == 1, let index = matches.first else {
        throw SnapshotError.refusal(.missingTarget,"observed target changed, disappeared or became ambiguous")
    }
    return index
}

public func bindTargetsToBrowserDocument(_ rows: inout [[String: Any]]) throws {
    let documents = rows.filter { $0["role"] as? String == "AXWebArea" && $0["AXURL"] is String }
    guard let depth = documents.compactMap({ $0["depth"] as? Int }).min() else { return }
    let urls = documents.filter { $0["depth"] as? Int == depth }.compactMap { $0["AXURL"] as? String }.sorted()
    for index in rows.indices {
        guard let key = rows[index]["targetKey"] as? String else { continue }
        rows[index]["targetKey"] = try snapshotDigest([["target": key, "browserDocuments": urls]])
    }
}

public func bindTargetsToSiblingText(_ rows: inout [[String: Any]]) throws {
    var ancestors: [Int] = []
    var parents: [Int: Int] = [:]
    var texts: [Int: [String]] = [:]
    let containers: Set<String> = ["AXGroup", "AXRow", "AXCell", "AXListItem"]
    for index in rows.indices {
        let depth = rows[index]["depth"] as? Int ?? 0
        while let previous = ancestors.last, (rows[previous]["depth"] as? Int ?? 0) >= depth {
            ancestors.removeLast()
        }
        if let parent = ancestors.last { parents[index] = parent }
        if rows[index]["role"] as? String == "AXStaticText",
           let value = rows[index]["AXValue"] as? String, !value.isEmpty {
            for ancestor in ancestors where containers.contains(rows[ancestor]["role"] as? String ?? "") {
                if (texts[ancestor]?.count ?? 0) <= 8 { texts[ancestor, default: []].append(value) }
            }
        }
        ancestors.append(index)
    }
    for index in rows.indices {
        guard let parent = parents[index], let context = texts[parent], !context.isEmpty,
              context.count <= 8, context.reduce(0, { $0 + $1.utf8.count }) <= 2048,
              let key = rows[index]["targetKey"] as? String else { continue }
        rows[index]["targetKey"] = try snapshotDigest([["target": key, "siblingText": context]])
    }
}

public func snapshotValue(_ value: Any) -> String? {
    if let url = value as? URL { return url.absoluteString }
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
