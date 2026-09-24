import Foundation

/// One window's observed rows, as an app-wide identifier lookup sees them.
public struct IdentifierWindow {
    public let index: Int
    public let title: String
    public let rows: [[String: Any]]

    public init(index: Int, title: String, rows: [[String: Any]]) {
        self.index = index
        self.title = title
        self.rows = rows
    }
}

/// Where a unique AXIdentifier lives: which window of the app, and which row of that window.
public struct IdentifierTarget: Equatable {
    public let window: Int
    public let element: Int

    public init(window: Int, element: Int) {
        self.window = window
        self.element = element
    }
}

/// Every row whose AXIdentifier is EXACTLY this string, in window then row order.
///
/// Exact only, never a substring or a case fold. An AXIdentifier is the one attribute an app
/// author sets so that a machine can name a control; matching it loosely would turn a precise
/// address back into a guess, which is what `--q` already is.
public func identifierMatches(_ identifier: String, in windows: [IdentifierWindow]) -> [IdentifierTarget] {
    var found: [IdentifierTarget] = []
    for window in windows {
        for row in window.rows {
            guard row["AXIdentifier"] as? String == identifier,
                  let element = row["index"] as? Int else { continue }
            found.append(IdentifierTarget(window: window.index, element: element))
        }
    }

    return found
}

/// `window 0 "Focus" element 12 AXButton "Start"` for one match, so a refusal can be acted on.
public func describeIdentifierMatch(_ target: IdentifierTarget, in windows: [IdentifierWindow]) -> String {
    guard let window = windows.first(where: { $0.index == target.window }),
          let row = window.rows.first(where: { $0["index"] as? Int == target.element }) else {
        return "window \(target.window) element \(target.element)"
    }
    let role = row["role"] as? String ?? "?"
    let label = (row["AXTitle"] as? String) ?? (row["AXDescription"] as? String) ?? (row["AXValue"] as? String)
    let title = window.title.isEmpty ? "(untitled)" : "\"\(window.title)\""

    return "window \(target.window) \(title) element \(target.element) \(role)"
        + (label.map { " \"\($0)\"" } ?? "")
}

/// The diagnostic for a lookup that found nothing: does this app give many elements ONE identifier?
///
/// SwiftUI propagates a container's `.accessibilityIdentifier` to every descendant, so one modifier
/// on a root view makes every control report the same id and shadows the per-control ones. The
/// element the caller named then genuinely does not exist, while the app source says it should.
/// `.accessibilityElement(children: .contain)` on the root restores them. This is the row-based
/// twin of `sharedIdentifierHint` in ElementQuery, which answers the same question from live AX.
/// The shared-identifier rule, once: the worst offender is named, and every OTHER identifier
/// shared at or above the same threshold is counted, so the reader is not sent back for a second
/// pass after fixing the first. Both hints are built from it, so they can no longer disagree.
public func sharedIdentifierSummary(_ counts: [String: Int], threshold: Int = 5) -> (id: String, count: Int, others: Int)? {
    guard let (id, count) = counts.max(by: { $0.value < $1.value }), count >= threshold else { return nil }

    return (id, count, counts.filter { $0.key != id && $0.value >= threshold }.count)
}

/// The hint text for a set of identifier counts, or `nil` when nothing is shared widely enough.
public func sharedIdentifierHintText(_ counts: [String: Int]) -> String? {
    guard let summary = sharedIdentifierSummary(counts) else { return nil }

    let alsoShared = summary.others == 0
        ? ""
        : " \(summary.others) other identifier\(summary.others == 1 ? " is" : "s are") shared this way."

    return "\(summary.count) elements in this app all report the identifier \"\(summary.id)\".\(alsoShared)"
        + " SwiftUI propagates a container's .accessibilityIdentifier to every descendant, which shadows"
        + " per-control identifiers; .accessibilityElement(children: .contain) on the root restores them."
}

public func sharedIdentifierRowHint(_ windows: [IdentifierWindow]) -> String? {
    var counts: [String: Int] = [:]
    for window in windows {
        for row in window.rows {
            guard let id = row["AXIdentifier"] as? String, !id.isEmpty else { continue }
            counts[id, default: 0] += 1
        }
    }

    return sharedIdentifierHintText(counts)
}

/// The one row `act --by-identifier` may act on, or a refusal that says what to do instead.
///
/// 🛑 Zero and two are BOTH refusals, and neither may be softened into a pick. Acting on the first
/// of several rows that share an identifier is how an agent presses the wrong control and reports
/// success: the identifier stops being an address the moment it is not unique, and the caller is
/// the only one who knows which of them was meant.
/// 🛑 `skipped` carries the windows the caller could NOT observe, one string each. Leaving them
/// out makes "the element is not there" and "the window holding it could not be read" the same
/// sentence, and only one of those is the caller's fault. Measured 2026-09-22 against Genesis:
/// a four-window app reported "searched 3 window(s)" with no hint that a fourth existed.
public func resolveIdentifierTarget(_ identifier: String, app: String, depth: Int,
                                    windows: [IdentifierWindow], skipped: [String] = []) throws -> IdentifierTarget {
    guard !identifier.isEmpty else {
        throw SnapshotError.invalid("--by-identifier needs a non-empty AXIdentifier")
    }
    let matches = identifierMatches(identifier, in: windows)

    if let only = matches.first, matches.count == 1 {
        return only
    }

    if matches.isEmpty {
        var message = "no element in \(app) carries the AXIdentifier \"\(identifier)\";"
            + " searched \(windows.count) of \(windows.count + skipped.count) window(s) to depth \(depth)."
        if !skipped.isEmpty {
            message += " Not searched, because they could not be observed: \(skipped.joined(separator: "; "))."
        }

        message += " Run `tools control see --app \(app)` to list what is there."
        if let hint = sharedIdentifierRowHint(windows) {
            message += " \(hint)"
        }

        throw SnapshotError.refusal(.missingTarget, message)
    }

    let spread = Set(matches.map { $0.window }).count
    // Only a lookup whose matches sit in DIFFERENT windows can be narrowed by naming one. Telling
    // a caller to pass --window-index when every match is already in the same window would send
    // them round a loop that cannot terminate.
    let advice = spread > 1
        ? "Name one with --window-index, or run see and act on --element."
        : "Run `tools control see --app \(app)` and act on the --element you mean."
    let candidates = matches.prefix(10).map { "  " + describeIdentifierMatch($0, in: windows) }.joined(separator: "\n")

    throw SnapshotError.refusal(.refused,
        "the AXIdentifier \"\(identifier)\" matches \(matches.count) elements in \(app);"
            + " --by-identifier acts only on a unique one.\n\(candidates)\n\(advice)")
}
