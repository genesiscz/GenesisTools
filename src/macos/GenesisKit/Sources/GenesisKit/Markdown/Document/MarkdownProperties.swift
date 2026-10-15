//
//  MarkdownProperties.swift
//  GenesisKit
//
//  YAML frontmatter as Obsidian's Properties: an ordered list of typed
//  key/value rows that the reading pane renders and edits in place. The
//  types are Obsidian's (text, number, checkbox, date, date & time, list,
//  tags), inferred from the value the way Obsidian does for a property with
//  no declared type. Writing back keeps the original lines of every row the
//  reader did not touch, so an edit to one property is a one-line diff.
//

import Foundation

public enum MarkdownPropertyKind: String, Codable, CaseIterable, Sendable {
    case text, number, checkbox, date, datetime, list, tags
}

public struct MarkdownProperty: Equatable, Sendable {
    var key: String
    var kind: MarkdownPropertyKind
    /// Scalar kinds. Numbers, dates and booleans keep their YAML spelling.
    var value: String = ""
    /// `list` and `tags`.
    var items: [String] = []
    /// A list written as `[a, b]` stays that way when re-serialized.
    var inline = false
    /// The source lines this row came from, reused verbatim when the row is unchanged.
    var raw: [String]? = nil
    /// Lines under this row that belong to no row (comments, blank lines,
    /// anything the subset does not read). Written back after the row even
    /// when the row itself changed, so an edit never deletes them.
    var trailing: [String] = []

    public static func == (a: MarkdownProperty, b: MarkdownProperty) -> Bool {
        a.key == b.key && a.kind == b.kind && a.value == b.value && a.items == b.items && a.inline == b.inline
    }

    var isList: Bool { kind == .list || kind == .tags }
}

public enum MarkdownFrontmatter {
    /// The leading `---` block, or nil. `body` is the markdown after it.
    static func split(_ markdown: String) -> (yaml: String?, body: String) {
        let lines = markdown.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---", lines.count > 1 else {
            return (nil, markdown)
        }
        guard let end = (1..<lines.count).first(where: { lines[$0].trimmingCharacters(in: .whitespaces) == "---" }) else {
            return (nil, markdown)
        }
        let yaml = lines[1..<end].joined(separator: "\n")
        let body = lines[(end + 1)...].joined(separator: "\n")
        return (yaml, body)
    }

    /// The line the body starts on: the frontmatter rows plus its two fences.
    /// Split view's scroll sync counts editor lines over the whole file and
    /// page lines over the body alone, so this is the difference.
    static func bodyLineOffset(in markdown: String) -> Int {
        guard let yaml = split(markdown).yaml else { return 0 }
        return yaml.components(separatedBy: "\n").count + 2
    }

    static func properties(in markdown: String) -> [MarkdownProperty] {
        guard let yaml = split(markdown).yaml else { return [] }
        return parse(yaml: yaml)
    }

    // MARK: Parse

    /// Subset of YAML: `key: scalar`, `key: [a, b]`, `key:` + `- item` lines,
    /// `key: |` / `key: >` block scalars, single or double quoted scalars,
    /// `#` comments. Anything else is kept as text so it survives a round trip.
    static func parse(yaml: String) -> [MarkdownProperty] {
        parseDocument(yaml: yaml).rows
    }

    /// The rows, plus the lines above the first row that belong to none of
    /// them (a leading comment). Lines between rows ride on the row above as
    /// its `trailing`, and indented lines under a key are part of that key.
    static func parseDocument(yaml: String) -> (leading: [String], rows: [MarkdownProperty]) {
        let lines = yaml.components(separatedBy: "\n")
        var out: [MarkdownProperty] = []
        var leading: [String] = []
        func keep(_ line: String) {
            if out.isEmpty { leading.append(line) } else { out[out.count - 1].trailing.append(line) }
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") || trimmed.hasPrefix("-") {
                keep(line)
                i += 1
                continue
            }
            guard let colon = keyColon(in: trimmed) else { keep(line); i += 1; continue }
            let key = unquote(String(trimmed[..<colon]).trimmingCharacters(in: .whitespaces))
            let rest = String(trimmed[trimmed.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            var raw = [line]
            var prop = MarkdownProperty(key: key, kind: .text)
            let blockScalar = isBlockScalarHeader(stripComment(rest))
            if rest.isEmpty || blockScalar {
                // A block list, a block scalar, a nested map, or an empty value.
                let keyIndent = indent(of: line)
                var items: [String] = []
                var nested: [String] = []
                var j = i + 1
                while j < lines.count {
                    let t = lines[j].trimmingCharacters(in: .whitespaces)
                    if t.isEmpty { raw.append(lines[j]); j += 1; continue }
                    if !blockScalar, t == "-" { items.append(""); raw.append(lines[j]); j += 1; continue }
                    if !blockScalar, t.hasPrefix("- ") { items.append(unquote(stripComment(String(t.dropFirst(2))))); raw.append(lines[j]); j += 1; continue }
                    // Deeper than the key: the block scalar's text, or a
                    // nested value this subset does not edit. Either way it
                    // belongs to this row, never to a row of its own.
                    if indent(of: lines[j]) > keyIndent { nested.append(lines[j]); raw.append(lines[j]); j += 1; continue }
                    break
                }
                while raw.count > 1, raw.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
                    raw.removeLast(); j -= 1
                }
                if blockScalar {
                    prop.kind = .text
                    prop.value = blockText(Array(raw.dropFirst()))
                } else if !items.isEmpty || (raw.count > 1 && nested.isEmpty) {
                    prop.kind = key == "tags" ? .tags : .list
                    prop.items = items
                } else {
                    prop.kind = .text
                    prop.value = ""
                }
                i = j
            } else if rest.hasPrefix("[") && rest.hasSuffix("]") {
                prop.kind = key == "tags" ? .tags : .list
                prop.inline = true
                prop.items = splitInline(String(rest.dropFirst().dropLast()))
                i += 1
            } else {
                let scalar = stripComment(rest)
                let quoted = isQuoted(scalar)
                let value = unquote(scalar)
                prop.kind = quoted ? .text : inferKind(value)
                prop.value = value
                i += 1
            }
            prop.raw = raw
            out.append(prop)
        }
        return (leading, out)
    }

    /// `|`, `>`, and their chomping / indentation variants (`|-`, `>+`, `|2`).
    private static func isBlockScalarHeader(_ s: String) -> Bool {
        s.range(of: #"^[|>][+-]?[1-9]?[+-]?$"#, options: .regularExpression) != nil
    }

    private static func indent(of line: String) -> Int {
        line.prefix(while: { $0 == " " || $0 == "\t" }).count
    }

    /// A block scalar's lines without their common indentation.
    private static func blockText(_ lines: [String]) -> String {
        let depth = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(indent(of:)).min() ?? 0
        return lines.map { $0.count >= depth ? String($0.dropFirst(depth)) : "" }.joined(separator: "\n")
    }

    static func inferKind(_ s: String) -> MarkdownPropertyKind {
        if s == "true" || s == "false" { return .checkbox }
        if s.range(of: #"^-?\d+(\.\d+)?$"#, options: .regularExpression) != nil { return .number }
        if s.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$"#, options: .regularExpression) != nil { return .datetime }
        if s.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil { return .date }
        return .text
    }

    private static func keyColon(in line: String) -> String.Index? {
        // `"a: b": 1` — the key may be quoted; otherwise the first `:` that
        // ends the key (followed by a space or the end of the line).
        if line.hasPrefix("\"") || line.hasPrefix("'") {
            let q = line.first!
            guard let close = line.dropFirst().firstIndex(of: q) else { return nil }
            let after = line.index(after: close)
            return line[after...].firstIndex(of: ":")
        }
        var idx = line.startIndex
        while let c = line[idx...].firstIndex(of: ":") {
            let next = line.index(after: c)
            if next == line.endIndex || line[next] == " " { return c }
            idx = next
        }
        return nil
    }

    private static func isQuoted(_ s: String) -> Bool {
        s.count >= 2 && ((s.hasPrefix("\"") && s.hasSuffix("\"")) || (s.hasPrefix("'") && s.hasSuffix("'")))
    }

    private static func unquote(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard isQuoted(t) else { return t }
        let inner = String(t.dropFirst().dropLast())
        if t.hasPrefix("'") { return inner.replacingOccurrences(of: "''", with: "'") }
        return inner
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }

    /// Drops a trailing ` # comment` outside quotes.
    private static func stripComment(_ s: String) -> String {
        if isQuoted(s) { return s }
        if let r = s.range(of: " #") { return String(s[..<r.lowerBound]).trimmingCharacters(in: .whitespaces) }
        return s
    }

    private static func splitInline(_ s: String) -> [String] {
        var items: [String] = []
        var current = ""
        var quote: Character? = nil
        for c in s {
            if let q = quote {
                current.append(c)
                if c == q { quote = nil }
            } else if c == "\"" || c == "'" {
                quote = c; current.append(c)
            } else if c == "," {
                items.append(unquote(current)); current = ""
            } else {
                current.append(c)
            }
        }
        let last = current.trimmingCharacters(in: .whitespaces)
        if !last.isEmpty || !items.isEmpty { items.append(unquote(last)) }
        return items.filter { !$0.isEmpty || items.count > 1 }
    }

    // MARK: Serialize

    static func yaml(_ props: [MarkdownProperty]) -> String {
        props.flatMap { lines(for: $0) }.joined(separator: "\n")
    }

    static func lines(for p: MarkdownProperty) -> [String] {
        let key = keyText(p.key)
        switch p.kind {
        case .list, .tags:
            if p.items.isEmpty { return ["\(key): []"] }
            if p.inline { return ["\(key): [\(p.items.map { itemText($0, inline: true) }.joined(separator: ", "))]"] }
            return ["\(key):"] + p.items.map { "  - \(itemText($0, inline: false))" }
        case .checkbox:
            return ["\(key): \(p.value == "true" ? "true" : "false")"]
        case .number, .date, .datetime:
            return ["\(key): \(p.value)"]
        case .text:
            if p.value.contains("\n") {
                // Several lines stay a block scalar rather than one quoted line.
                return ["\(key): |"] + p.value.components(separatedBy: "\n").map { $0.isEmpty ? "" : "  " + $0 }
            }
            return p.value.isEmpty ? ["\(key):"] : ["\(key): \(scalarText(p.value))"]
        }
    }

    private static func keyText(_ k: String) -> String {
        k.contains(":") || k.hasPrefix("#") || k.hasPrefix("-") || k.isEmpty ? quoted(k) : k
    }

    /// Quotes a text scalar when YAML would read it as something else.
    static func scalarText(_ s: String) -> String {
        if s.isEmpty { return "\"\"" }
        let firsts: Set<Character> = ["[", "{", "\"", "'", "#", "&", "*", "!", "|", ">", "%", "@", "`", "-", "?", ":"]
        let needs = firsts.contains(s.first!)
            || s.contains(": ") || s.contains(" #") || s.hasSuffix(":")
            || s != s.trimmingCharacters(in: .whitespaces)
            || inferKind(s) != .text
            || ["null", "~", "yes", "no", "on", "off"].contains(s.lowercased())
        return needs ? quoted(s) : s
    }

    /// List items are always text in the properties model, so a number-like
    /// item stays bare (`- 302921`) like Obsidian writes it; only YAML syntax
    /// hazards get quotes.
    static func itemText(_ s: String, inline: Bool) -> String {
        if s.isEmpty { return "\"\"" }
        let firsts: Set<Character> = ["[", "{", "\"", "'", "#", "&", "*", "!", "|", ">", "%", "@", "`", "-", "?", ":"]
        let needs = firsts.contains(s.first!)
            || s.contains(": ") || s.contains(" #") || s.hasSuffix(":")
            || s != s.trimmingCharacters(in: .whitespaces)
            || (inline && (s.contains(",") || s.contains("]")))
        return needs ? quoted(s) : s
    }

    private static func quoted(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// The markdown with its frontmatter replaced by `props`. Rows equal to a
    /// row already in the file keep their original lines, and lines that are
    /// no row at all (comments, blank lines) stay where they were. No rows
    /// removes the block; a file without a block gets one.
    public static func replacing(properties: [MarkdownProperty], in markdown: String) -> String {
        let (yaml, body) = split(markdown)
        let (leading, existing) = yaml.map(parseDocument(yaml:)) ?? ([], [])
        if properties.isEmpty { return body.hasPrefix("\n") ? String(body.dropFirst()) : body }
        let kept = Set(properties.map(\.key))
        var lines = leading
        lines += properties.flatMap { p -> [String] in
            let old = existing.first(where: { $0.key == p.key })
            let own = old.flatMap { $0 == p ? $0.raw : nil } ?? Self.lines(for: p)
            return own + (old?.trailing ?? [])
        }
        // A removed or renamed row takes its own lines with it, not the
        // comments that happened to sit under it.
        lines += existing.filter { !kept.contains($0.key) }.flatMap(\.trailing)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let block = "---\n" + lines.joined(separator: "\n") + "\n---"
        if yaml == nil { return block + "\n" + (body.isEmpty ? "" : "\n" + body) }
        return block + (body.isEmpty ? "\n" : "\n" + body)
    }

    // MARK: Bridge

    /// The rows as the web view's `gnRender` wants them.
    static func json(_ props: [MarkdownProperty]) -> String {
        let objs: [[String: Any]] = props.map {
            ["key": $0.key, "kind": $0.kind.rawValue, "value": $0.value, "items": $0.items, "inline": $0.inline]
        }
        let data = (try? JSONSerialization.data(withJSONObject: objs)) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Rows posted back by the web view's properties editor.
    static func properties(fromBridge any: Any?) -> [MarkdownProperty]? {
        guard let arr = any as? [[String: Any]] else { return nil }
        return arr.compactMap { o in
            guard let key = o["key"] as? String,
                  let kind = (o["kind"] as? String).flatMap(MarkdownPropertyKind.init(rawValue:)) else { return nil }
            var p = MarkdownProperty(key: key, kind: kind)
            p.value = o["value"] as? String ?? ""
            p.items = o["items"] as? [String] ?? []
            p.inline = o["inline"] as? Bool ?? false
            return p
        }
    }
}
