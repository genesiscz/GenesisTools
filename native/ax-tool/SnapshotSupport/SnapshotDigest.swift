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

/// The identity to use when the app gave this element an AXIdentifier.
///
/// 🛑 `snapshotTargetKey` folds in AXValue, AXTitle and AXDescription, for the element AND for its
/// ancestors. On a live window every one of those moves: measured 2026-09-21 on a countdown HUD,
/// the container's AXDescription read "Flow, 11 minutes 52 seconds remain" and the primary button's
/// own label alternated Pause/Resume as a RESULT of pressing it. So the key that was supposed to
/// survive churn was itself rewritten by the churn, and re-resolution failed half the time.
///
/// An AXIdentifier is the one attribute an app author sets precisely so a machine can find the
/// thing again, and it does not change when the label does. Ancestors contribute only their
/// identifiers here, never their text, for the same reason.
///
/// Returns nil when there is no identifier, and the caller keeps the richer key: without one,
/// role and text are all that distinguish two sibling buttons.
public func snapshotStableKey(_ row: [String:Any], ancestors: [[String:Any]] = []) throws -> String? {
    guard let id = row["AXIdentifier"] as? String, !id.isEmpty else { return nil }
    let identity: [String: Any] = [
        "role": row["role"] as? String ?? "",
        "subrole": row["AXSubrole"] as? String ?? "",
        "identifier": id,
    ]
    let ancestorIdentifiers = ancestors.suffix(4).compactMap { $0["AXIdentifier"] as? String }

    // 🛑 NOT "identity": snapshotDigest strips a key by that name, because an AX wrapper hash
    // belongs to a client connection rather than to the observed UI. Naming the payload "identity"
    // silently deleted it, and every element with the same role then hashed to one value: measured
    // here as 14 rows with distinct identifiers sharing a single key.
    return try snapshotDigest([["target": identity, "ancestorIdentifiers": ancestorIdentifiers]])
}

/// Undo the identifier-based stable key wherever that identifier is not unique.
///
/// An AXIdentifier is only an identity if ONE element carries it. Apps reuse them for repeated
/// rows — measured here, four `focus-hud-mix` rows in one HUD — and SwiftUI propagates a
/// container's identifier to every descendant, which can make dozens share one. Keeping the
/// identifier-based key there would turn a previously actionable row into a permanent
/// "ambiguous" refusal, so those rows go back to the richer key that still tells them apart.
public func demoteSharedStableKeys(_ rows: inout [[String: Any]]) {
    var counts: [String: Int] = [:]
    for row in rows {
        guard let id = row["AXIdentifier"] as? String, !id.isEmpty else { continue }
        counts[id, default: 0] += 1
    }

    for index in rows.indices {
        guard let id = rows[index]["AXIdentifier"] as? String, (counts[id] ?? 0) > 1 else { continue }
        rows[index]["stableKey"] = rows[index]["targetKey"]
    }
}

/// After the binders have finalized every `targetKey`: a `stableKey` that more than one row still
/// carries is no identity, so each such row falls back to its final `targetKey`.
///
/// `demoteSharedStableKeys` repairs only rows whose AXIdentifier repeats. A row with NO
/// identifier took its pre-binding targetKey as its stable key, so two unlabeled "Delete" buttons
/// in two list rows shared one. The binders exist to separate exactly those rows, and element-scope
/// revalidation then found two rows for one key and refused every press on either.
public func promoteSharedStableKeys(_ rows: inout [[String: Any]]) {
    var counts: [String: Int] = [:]
    for row in rows {
        guard let key = row["stableKey"] as? String else { continue }
        counts[key, default: 0] += 1
    }

    for index in rows.indices {
        guard let key = rows[index]["stableKey"] as? String, (counts[key] ?? 0) > 1 else { continue }
        rows[index]["stableKey"] = rows[index]["targetKey"]
    }
}

public func preparedTargetIndex(key: String, rows: [[String:Any]], field: String = "targetKey") throws -> Int {

    let matches = rows.indices.filter { rows[$0][field] as? String == key }
    guard matches.count == 1, let index = matches.first else {
        throw SnapshotError.refusal(.missingTarget,"observed target changed, disappeared or became ambiguous")
    }
    return index
}

/// Resolve by the volatile identity first, then the stable one.
///
/// A caller copies one hash out of a `see` row and should not have to know which of the two it
/// is. Trying targetKey first keeps the prepared path byte-identical; falling back to stableKey is
/// what lets a window with a running clock be acted on at all.
public func resolvedTargetIndex(key: String, rows: [[String:Any]]) throws -> Int {
    if let index = try? preparedTargetIndex(key: key, rows: rows) {
        return index
    }

    return try preparedTargetIndex(key: key, rows: rows, field: "stableKey")
}

public func bindTargetsToBrowserDocument(_ rows: inout [[String: Any]]) throws {
    let documents = rows.filter { $0["role"] as? String == "AXWebArea" && $0["AXURL"] is String }
    guard let depth = documents.compactMap({ $0["depth"] as? Int }).min() else { return }
    let urls = documents.filter { $0["depth"] as? Int == depth }.compactMap { $0["AXURL"] as? String }.sorted()
    for index in rows.indices {
        guard let key = rows[index]["targetKey"] as? String else { continue }
        rows[index]["targetKey"] = try snapshotDigest([["target": key, "browserDocuments": urls]])

        if let stable = rows[index]["stableKey"] as? String {
            rows[index]["stableKey"] = try snapshotDigest([["target": stable, "browserDocuments": urls]])
        }
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
