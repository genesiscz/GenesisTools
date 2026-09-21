import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Extended AX Helpers

func axAttributeNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyAttributeNames(element, &names)
    guard err == .success, let arr = names as? [String] else { return [] }
    return arr
}

func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyActionNames(element, &names)
    guard err == .success, let arr = names as? [String] else { return [] }
    return arr
}

func axPointValue(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    guard let val = axAttribute(el, attr),
          CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    guard AXValueGetValue(val as! AXValue, .cgPoint, &pt) else { return nil }
    return pt
}

func axSizeValue(_ el: AXUIElement, _ attr: String) -> CGSize? {
    guard let val = axAttribute(el, attr),
          CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
    var sz = CGSize.zero
    guard AXValueGetValue(val as! AXValue, .cgSize, &sz) else { return nil }
    return sz
}

func serializeAXValue(_ val: CFTypeRef) -> Any {
    if let s = val as? String { return s }
    if CFGetTypeID(val) == CFBooleanGetTypeID() {
        return (val as! NSNumber).boolValue
    }
    if let n = val as? NSNumber { return n }
    if CFGetTypeID(val) == AXValueGetTypeID() {
        let axVal = val as! AXValue
        var p = CGPoint.zero; var s = CGSize.zero
        var r = CGRect.zero; var rng = CFRange(location: 0, length: 0)
        if AXValueGetValue(axVal, .cgPoint, &p) { return ["x": p.x, "y": p.y] }
        if AXValueGetValue(axVal, .cgSize, &s) { return ["w": s.width, "h": s.height] }
        if AXValueGetValue(axVal, .cgRect, &r) {
            return ["x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height]
        }
        if AXValueGetValue(axVal, .cfRange, &rng) {
            return ["loc": rng.location, "len": rng.length]
        }
        return "<AXValue>"
    }
    if let arr = val as? [AXUIElement] { return "<\(arr.count) elements>" }
    return "\(val)"
}

func fuzzyRoleMatch(_ actual: String?, _ query: String, exact: Bool) -> Bool {
    guard let a = actual else { return false }
    if a == query { return true }
    if let re = parseRegex(query) {
        return re.firstMatch(in: a, range: NSRange(a.startIndex..., in: a)) != nil
    }
    if exact { return false }
    let al = a.lowercased()
    let ql = query.lowercased()
    if al == ql { return true }
    let stripped = al.hasPrefix("ax") ? String(al.dropFirst(2)) : al
    if stripped == ql { return true }
    if stripped.contains(ql) { return true }
    return false
}

func parseRegex(_ pattern: String) -> NSRegularExpression? {
    guard pattern.hasPrefix("/"), pattern.count > 2 else { return nil }
    let body = pattern.dropFirst()
    guard let lastSlash = body.lastIndex(of: "/"), lastSlash != body.startIndex else { return nil }
    let re = String(body[body.startIndex..<lastSlash])
    let flags = String(body[body.index(after: lastSlash)...])
    var opts: NSRegularExpression.Options = []
    if flags.contains("i") { opts.insert(.caseInsensitive) }
    if flags.contains("m") { opts.insert(.anchorsMatchLines) }
    if flags.contains("s") { opts.insert(.dotMatchesLineSeparators) }
    return try? NSRegularExpression(pattern: re, options: opts)
}

func stringMatches(_ haystack: String?, _ needle: String) -> Bool {
    guard let h = haystack, !h.isEmpty else { return false }
    if let re = parseRegex(needle) {
        return re.firstMatch(in: h, range: NSRange(h.startIndex..., in: h)) != nil
    }
    return h.localizedCaseInsensitiveContains(needle)
}

// --depth applies to EVERY element search (get/press/click/wait targeting too,
// not just find/list) — browser page content easily nests past the default 15.
func targetSearchDepth() -> Int {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--depth"), i + 1 < a.count, let d = Int(a[i + 1]) { return d }
    return 15
}

/// Narrow a query's matches toward the thing the caller can actually act on.
///
/// `findByAttributes` is a pre-order walk that appends a node BEFORE its children, so an ancestor
/// always sits at index 0. A SwiftUI container that aggregates its children's labels therefore beat
/// the button it contains: reported 2026-09-21, `press --q "Previous range"` pressed the window's
/// root group, which exposes no AXPress at all, and reported success while nothing happened.
///
/// Order, and it matters: an EXACT label match beats a container that merely contains the words,
/// and only then does the ability to perform the verb decide. Doing it the other way round would
/// let an unrelated but pressable element outrank the button the caller named.
func rankQueryMatches(_ elements: [AXUIElement], query: String?, requiredAction: String?) -> [AXUIElement] {
    let candidates = elements.map {
        QueryCandidate(title: axStringAttribute($0, "AXTitle"),
                       label: axStringAttribute($0, "AXDescription"),
                       identifier: axStringAttribute($0, "AXIdentifier"),
                       actions: axActionNames($0))
    }

    return rankedQueryMatches(candidates, query: query, requiredAction: requiredAction).map { elements[$0] }
}

/// The diagnostic for a lookup that found nothing: does this app give many elements ONE identifier?
///
/// SwiftUI propagates a container's `.accessibilityIdentifier` to every descendant, so one modifier
/// on a root view makes every control report the same id and shadows the per-control ones. That
/// looks exactly like "my identifier is wrong" or "the app is broken", and cost a real session
/// twenty minutes. `.accessibilityElement(children: .contain)` on the root is the fix.
func sharedIdentifierHint(_ appElement: AXUIElement) -> String? {
    var counts: [String: Int] = [:]
    for window in axWindows(appElement) {
        for element in collectElements(window) {
            guard let id = element.identifier, !id.isEmpty else { continue }
            counts[id, default: 0] += 1
        }
    }

    guard let (id, count) = counts.max(by: { $0.value < $1.value }), count >= 5 else { return nil }

    return "\(count) elements in this app all report the identifier \"\(id)\". SwiftUI propagates a container's .accessibilityIdentifier to every descendant, which shadows per-control identifiers; .accessibilityElement(children: .contain) on the root restores them."
}

func findByAttributes(_ root: AXUIElement, role: String?, title: String?,
                       value: String?, desc: String?, subrole: String? = nil,
                       text: String? = nil, searchAll: Bool = false, exact: Bool = false,
                       depth: Int = 0, maxDepth: Int = targetSearchDepth()) -> [AXUIElement] {
    if depth > maxDepth { return [] }
    var results: [AXUIElement] = []
    var matches = true
    if let r = role, !fuzzyRoleMatch(axStringAttribute(root, "AXRole"), r, exact: exact) { matches = false }
    if matches, let s = subrole, !fuzzyRoleMatch(axStringAttribute(root, "AXSubrole"), s, exact: exact) { matches = false }
    if matches, let t = title {
        if !stringMatches(axStringAttribute(root, "AXTitle"), t) { matches = false }
    }
    if matches, let v = value {
        if !stringMatches(axAttribute(root, "AXValue").map({ "\($0)" }), v) { matches = false }
    }
    if matches, let d = desc {
        if !stringMatches(axStringAttribute(root, "AXDescription"), d) { matches = false }
    }
    if matches, let txt = text {
        var found = stringMatches(axStringAttribute(root, "AXIdentifier"), txt) ||
                    stringMatches(axStringAttribute(root, "AXTitle"), txt) ||
                    stringMatches(axStringAttribute(root, "AXDescription"), txt)
        if searchAll && !found {
            found = stringMatches(axAttribute(root, "AXValue").map({ "\($0)" }), txt) ||
                    fuzzyRoleMatch(axStringAttribute(root, "AXRole"), txt, exact: false) ||
                    fuzzyRoleMatch(axStringAttribute(root, "AXSubrole"), txt, exact: false)
        }
        if !found { matches = false }
    }
    if matches { results.append(root) }
    for child in axChildren(root) {
        results.append(contentsOf: findByAttributes(child, role: role, title: title,
                                                     value: value, desc: desc, subrole: subrole,
                                                     text: text, searchAll: searchAll, exact: exact,
                                                     depth: depth + 1, maxDepth: maxDepth))
    }
    return results
}

func resolveElement(_ appElement: AXUIElement, _ appName: String, ignoreTextFlag: Bool = false,
                    requiredAction: String? = nil) -> AXUIElement {
    if let id = argValue("--id") {
        guard let el = findInApp(appElement, id: id) else {
            // Say what was searched and how deep, and name the one mistake that produces this
            // result while the identifier is perfectly correct.
            var message = "element not found: \(id) in \(appName) (searched every window to depth 50)"
            if let hint = sharedIdentifierHint(appElement) { message += ". \(hint)" }
            errorExit(message)
        }
        return el
    }
    let role = argValue("--role")
    let title = argValue("--title")
    let desc = argValue("--desc")
    let subrole = argValue("--subrole")
    let q = argValue("--q")
    let textSearch = ignoreTextFlag ? nil : argValue("--text")
    let windowScope = argValue("--window")
    let exact = args.contains("--exact")

    if role == nil && title == nil && desc == nil && subrole == nil && q == nil && textSearch == nil {
        errorExit("--id, --q, --text, or at least one of --role/--title/--desc/--subrole required")
    }

    let scopedWindows = axWindows(appElement).filter { w in
        guard let ws = windowScope else { return true }
        return (axStringAttribute(w, "AXTitle") ?? "").localizedCaseInsensitiveContains(ws)
    }

    let searchTerm = q ?? textSearch
    let hasFilters = role != nil || title != nil || desc != nil || subrole != nil
    if let s = searchTerm, hasFilters {
        var all: [AXUIElement] = []
        for w in scopedWindows {
            all.append(contentsOf: findByAttributes(w, role: role, title: title, value: nil,
                desc: desc, subrole: subrole, text: s, searchAll: q != nil, exact: exact))
        }
        all = rankQueryMatches(all, query: s, requiredAction: requiredAction)
        if all.count == 1 { return all[0] }
        if all.count > 1 {
            var candidates: [[String: Any]] = []
            for el in all.prefix(10) {
                var c: [String: Any] = [:]
                if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                candidates.append(c)
            }
            jsonOutput(["ok": false,
                "error": "ambiguous: '\(s)' + filters matched \(all.count) elements — narrow further",
                "count": all.count, "candidates": candidates])
            exit(1)
        }
        errorExit("no element matching '\(s)' with given filters in \(appName) at --depth \(targetSearchDepth()); deeply nested UIs can exceed it, so retry with --depth 40")
    }
    if let q = q, role == nil && title == nil && desc == nil && subrole == nil {
        let isRegex = parseRegex(q) != nil
        if isRegex {
            var all: [AXUIElement] = []
            for w in scopedWindows {
                all.append(contentsOf: findByAttributes(w, role: nil, title: nil, value: nil,
                                                         desc: nil, text: q, searchAll: true))
            }
            all = rankQueryMatches(all, query: q, requiredAction: requiredAction)
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(q)' matched \(all.count) elements — narrow with --role/--desc/--window",
                    "count": all.count, "candidates": candidates])
                exit(1)
            }
            errorExit("no element matching '\(q)' in \(appName) at --depth \(targetSearchDepth()); retry with --depth 40")
        }
        let levels: [(String, (AXUIElement) -> [AXUIElement])] = [
            ("id",      { _ in findInApp(appElement, id: q).map { [$0] } ?? [] }),
            ("title",   { w in findByAttributes(w, role: nil, title: q, value: nil, desc: nil) }),
            ("desc",    { w in findByAttributes(w, role: nil, title: nil, value: nil, desc: q) }),
            ("value",   { w in findByAttributes(w, role: nil, title: nil, value: q, desc: nil) }),
            ("role",    { w in findByAttributes(w, role: q, title: nil, value: nil, desc: nil) }),
            ("subrole", { w in findByAttributes(w, role: nil, title: nil, value: nil, desc: nil, subrole: q) }),
        ]
        for (lvl, search) in levels {
            var all: [AXUIElement] = []
            if lvl == "id" { all = search(appElement) }
            else { for w in scopedWindows { all.append(contentsOf: search(w)) } }
            all = rankQueryMatches(all, query: q, requiredAction: requiredAction)
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(q)' matched \(all.count) elements by \(lvl) — narrow with --role/--desc/--window or use --id",
                    "matchedBy": lvl, "count": all.count, "candidates": candidates])
                exit(1)
            }
        }
        errorExit("no element matching '\(q)' in \(appName)")
    }

    if let t = textSearch, role == nil && title == nil && desc == nil && subrole == nil {
        let isRegex = parseRegex(t) != nil
        if isRegex {
            var all: [AXUIElement] = []
            for w in scopedWindows {
                all.append(contentsOf: findByAttributes(w, role: nil, title: nil, value: nil,
                                                         desc: nil, text: t))
            }
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(t)' matched \(all.count) elements — narrow with --role/--desc/--window",
                    "count": all.count, "candidates": candidates])
                exit(1)
            }
            errorExit("no element matching --text '\(t)' in \(appName)")
        }
        let levels: [(String, (AXUIElement) -> [AXUIElement])] = [
            ("id",    { _ in findInApp(appElement, id: t).map { [$0] } ?? [] }),
            ("title", { w in findByAttributes(w, role: nil, title: t, value: nil, desc: nil) }),
            ("desc",  { w in findByAttributes(w, role: nil, title: nil, value: nil, desc: t) }),
        ]
        for (lvl, search) in levels {
            var all: [AXUIElement] = []
            if lvl == "id" { all = search(appElement) }
            else { for w in scopedWindows { all.append(contentsOf: search(w)) } }
            all = rankQueryMatches(all, query: t, requiredAction: requiredAction)
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let tt = axStringAttribute(el, "AXTitle") { c["title"] = tt }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(t)' matched \(all.count) elements by \(lvl) — narrow with --role/--desc/--window or use --id",
                    "matchedBy": lvl, "count": all.count, "candidates": candidates])
                exit(1)
            }
        }
        errorExit("no element matching --text '\(t)' in \(appName)")
    }

    for window in scopedWindows {
        let hits = findByAttributes(window, role: role, title: title, value: nil,
                                     desc: desc, subrole: subrole, exact: exact)
        if let first = hits.first { return first }
    }
    var msg = "no element matching"
    if let r = role { msg += " role=\(r)" }
    if let s = subrole { msg += " subrole=\(s)" }
    if let t = title { msg += " title=\(t)" }
    if let d = desc { msg += " desc=\(d)" }
    if let w = windowScope { msg += " in window '\(w)'" }
    errorExit("\(msg) in \(appName)")
}

func elementInfo(_ el: AXUIElement) -> [String: Any] {
    var info: [String: Any] = [:]
    if let id = axStringAttribute(el, "AXIdentifier") { info["axId"] = id }
    if let r = axStringAttribute(el, "AXRole") { info["role"] = r }
    if let t = axStringAttribute(el, "AXTitle") { info["title"] = t }
    if let d = axStringAttribute(el, "AXDescription") { info["desc"] = d }
    return info
}

func buildTree(_ el: AXUIElement, depth: Int = 0, maxDepth: Int = 10) -> [String: Any] {
    var node: [String: Any] = [:]
    if let id = axStringAttribute(el, "AXIdentifier") { node["id"] = id }
    if let role = axStringAttribute(el, "AXRole") { node["role"] = role }
    if let title = axStringAttribute(el, "AXTitle") { node["title"] = title }
    if let sub = axStringAttribute(el, "AXSubrole") { node["subrole"] = sub }
    if let desc = axStringAttribute(el, "AXDescription") { node["desc"] = desc }
    if let v = axAttribute(el, "AXValue") { node["value"] = "\(v)" }
    if depth < maxDepth {
        let kids = axChildren(el)
        if !kids.isEmpty {
            node["children"] = kids.map { buildTree($0, depth: depth + 1, maxDepth: maxDepth) }
        }
    }
    return node
}
