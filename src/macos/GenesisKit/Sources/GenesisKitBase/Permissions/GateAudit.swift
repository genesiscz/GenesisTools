import Darwin
import Foundation

/// One audit trail for every gate a person answers: the vault key, an AI account's token, a link that runs a saved
/// command, Touch ID, and the privacy-permission dialogs. `~/.genesis-tools/audit/gates.jsonl` (under
/// `GENESIS_TOOLS_HOME` when set), one JSON object per line, readable only by its owner. Each line names the gate, the
/// event (`prompted`, `allowed`, `denied`, `remembered`, `granted`, `not-now`, `recorded`, ...), the process that wrote
/// it, and everything the gate showed, warnings included, so a decision can be audited later from the file alone
/// (Martin, 2026-10-16: "I want all permission gates to be audited"). Secrets are never written. The TypeScript side
/// writes the same file (`src/utils/audit/gates.ts`).
public enum GateCredentialRedactor {
    private static let flags: Set<String> = ["--token", "--api-key", "--key", "--password", "--secret"]

    private static func shortToken(_ words: [String]) -> Bool {
        words.contains { ["wakeup", "gt-wakeup"].contains(($0 as NSString).lastPathComponent) || $0.contains("/src/wakeup/") }
            && words.contains("daemon") && words.contains("register")
    }

    public static func arguments(_ words: [String]) -> [String] {
        let short = shortToken(words)
        var hideNext = false
        return words.map { word in
            if hideNext { hideNext = false; return "[REDACTED]" }
            let parts = word.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let flag = parts.first.map(String.init) ?? ""
            guard flags.contains(flag) || (short && flag == "-t") else { return headers(word) }
            hideNext = parts.count == 1
            return parts.count == 1 ? word : "\(flag)=[REDACTED]"
        }
    }

    private static let sensitiveQueryNames: Set<String> = [
        "token", "accesstoken", "refreshtoken", "idtoken", "apikey", "key", "password", "passwd", "secret",
        "clientsecret", "authorization", "auth", "credential", "credentials", "prompt", "command", "cmd", "argv", "args",
    ]

    private static func url(_ raw: String, depth: Int) -> String {
        guard var url = URLComponents(string: raw) else { return "[REDACTED URL]" }
        if url.user != nil || url.password != nil { url.user = "[REDACTED]"; url.password = nil }
        if let items = url.queryItems {
            url.queryItems = params(items, depth: depth)
        }
        // An OAuth implicit-flow callback carries its tokens in the fragment (`#access_token=…`).
        if let fragment = url.percentEncodedFragment, fragment.contains("=") {
            var pairs = URLComponents()
            pairs.percentEncodedQuery = fragment
            pairs.queryItems = params(pairs.queryItems ?? [], depth: depth)
            url.percentEncodedFragment = pairs.percentEncodedQuery
        }
        return url.string ?? "[REDACTED URL]"
    }

    private static func params(_ items: [URLQueryItem], depth: Int) -> [URLQueryItem] {
        items.map { item in
            let name = item.name.lowercased().replacingOccurrences(of: "-", with: "").replacingOccurrences(of: "_", with: "")
            let value: String? = sensitiveQueryNames.contains(name) ? "[REDACTED]" : item.value.map { text($0, depth: depth + 1) }
            return URLQueryItem(name: item.name, value: value)
        }
    }

    /// Use UTF-16 units to match NSRegularExpression offsets and treat CRLF as two newline units.
    private static func headerValueEnd(_ units: [UInt16], from start: Int, outer: UInt16?) -> Int {
        func space(_ index: Int) -> Bool { index < units.count && (units[index] == 32 || units[index] == 9) }
        func lineEnd(_ index: Int) -> Bool { index >= units.count || units[index] == 13 || units[index] == 10 }
        func letter(_ unit: UInt16) -> Bool { (65...90).contains(unit) || (97...122).contains(unit) }
        func name(_ unit: UInt16) -> Bool { letter(unit) || (48...57).contains(unit) || [95, 46, 45].contains(unit) }
        func boundary(_ index: Int) -> (next: Int, found: Bool) {
            var next = index
            while space(next) { next += 1 }
            if next == index { return (next, false) }
            var token = next
            while token < units.count && (units[token] == 34 || units[token] == 39) { token += 1 }
            var flag = token
            if flag < units.count && units[flag] == 45 {
                flag += 1
                if flag < units.count && units[flag] == 45 { flag += 1 }
            }
            let isFlag = flag > token && flag < units.count && letter(units[flag])
            let nameStart = token
            while token < units.count && name(units[token]) { token += 1 }
            let named = token > nameStart
            while space(token) { token += 1 }
            return (next, isFlag || (named && token < units.count && units[token] == 58))
        }
        var index = start
        var previous: UInt16 = 0
        while !lineEnd(index) {
            if space(index) {
                let run = boundary(index)
                if run.found { return index }
                index = run.next
                continue
            }
            let quote = units[index]
            if quote != 34 && quote != 39 { previous = quote; index += 1; continue }
            // A wrapper before a flag/header is complete; a value quote after '=' is still secret.
            let next = index + 1
            if outer == quote && index > start && previous != 61 && (lineEnd(next) || boundary(next).found) {
                return index
            }
            var close = next
            while !lineEnd(close) && units[close] != quote {
                close += units[close] == 92 && !lineEnd(close + 1) ? 2 : 1
            }
            if lineEnd(close) { return close }
            previous = quote
            index = close + 1
        }
        return index
    }

    private static func redactedHeaderValue(_ name: String, value: String) -> String {
        let pattern = try! NSRegularExpression(pattern: #"^([a-z][a-z0-9+.-]*)[ \t]+\S"#, options: .caseInsensitive)
        var scheme = ""
        if ["authorization", "proxy-authorization"].contains(name.lowercased()),
           let match = pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) {
            scheme = String(value[Range(match.range(at: 1), in: value)!]) + " "
        }
        return scheme + "[REDACTED]"
    }

    private static func headers(_ value: String) -> String {
        let names = #"(?:Proxy-)?Authorization|[a-z0-9_.-]*(?:key|token|secret|cookie)[a-z0-9_.-]*"#
        let exact = try! NSRegularExpression(pattern: #"^([ \t]*)("# + names + #")([ \t]*:[ \t]*)([^\r\n]*)$"#, options: .caseInsensitive)
        let range = NSRange(value.startIndex..., in: value)
        if let match = exact.firstMatch(in: value, range: range) {
            let payload = Range(match.range(at: 4), in: value)!
            let name = String(value[Range(match.range(at: 2), in: value)!])
            return String(value[..<payload.lowerBound]) + redactedHeaderValue(name, value: String(value[payload]))
                + String(value[payload.upperBound...])
        }
        let inline = try! NSRegularExpression(pattern: #"(^|[\s"']|(?:--header|-H)=["']?)("# + names + #")([ \t]*:[ \t]*)"#, options: .caseInsensitive)
        let units = Array(value.utf16)
        let source = value as NSString
        var safe = ""
        var copied = 0
        var cursor = 0
        while cursor < units.count,
              let match = inline.firstMatch(in: value, options: .withoutAnchoringBounds,
                                            range: NSRange(location: cursor, length: units.count - cursor)) {
            let start = NSMaxRange(match.range)
            let prefix = source.substring(with: match.range(at: 1)).utf16.last
            let name = source.substring(with: match.range(at: 2))
            let beforeFlag = match.range.location > 0 ? units[match.range.location - 1] : nil
            let wrapper = prefix == 34 || prefix == 39 ? prefix : beforeFlag
            let outer = wrapper == 34 || wrapper == 39 ? wrapper : nil
            let end = headerValueEnd(units, from: start, outer: outer)
            safe += source.substring(with: NSRange(location: copied, length: start - copied))
                + redactedHeaderValue(name, value: source.substring(with: NSRange(location: start, length: end - start)))
            copied = end
            cursor = end
        }
        return safe + source.substring(from: copied)
    }

    public static func text(_ value: String) -> String { text(value, depth: 0) }

    private static func text(_ value: String, depth: Int) -> String {
        guard depth < 8 else { return "[REDACTED]" }
        let links = try! NSRegularExpression(pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#, options: .caseInsensitive)
        let matches = links.matches(in: value, range: NSRange(value.startIndex..., in: value))
        var safe = value
        for match in matches.reversed() {
            guard let range = Range(match.range, in: safe) else { continue }
            safe.replaceSubrange(range, with: url(String(safe[range]), depth: depth))
        }
        let words = safe.components(separatedBy: .whitespacesAndNewlines)
        let flags = shortToken(words) ? "--(?:token|api-key|key|password|secret)|-t" : "--(?:token|api-key|key|password|secret)"
        let pattern = #"(^|[\s"'])("# + flags + #")(=|\s+)("(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\?(?=$|[\r\n]))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|\\?(?=$|[\r\n]))|[^\s;]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return "[REDACTED]" }
        let redacted = regex.stringByReplacingMatches(in: safe, range: NSRange(safe.startIndex..., in: safe),
                                                      withTemplate: "$1$2$3[REDACTED]")
        return headers(redacted)
    }

    public static func fields(_ value: Any) -> Any {
        if let text = value as? String { return self.text(text) }
        if let words = value as? [String] { return arguments(words).map(text) }
        if let array = value as? [Any] { return array.map(fields) }
        if let object = value as? [String: Any] { return object.mapValues(fields) }
        return value
    }
}

public enum GateAudit {
    public static var path: String {
        let override = ProcessInfo.processInfo.environment["GENESIS_TOOLS_HOME"]
        let home = override?.isEmpty == false ? override! : NSHomeDirectory()
        return (home as NSString).appendingPathComponent(".genesis-tools/audit/gates.jsonl")
    }

    /// O_APPEND makes the single write atomic with other Swift and TypeScript writers, including file creation.
    public static func appendLine(_ data: Data, to file: String) {
        do {
            try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent,
                                                    withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let fd = open(file, O_WRONLY | O_CREAT | O_APPEND, 0o600)
            guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            defer { close(fd) }
            let line = data + Data("\n".utf8)
            let written = line.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            guard written == line.count else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        } catch {
            KitHost.log("gate audit: could not append to \(file): \(error)")
        }
    }

    /// What an approval window showed: its title, why, every fact and detail with its full value, the warning.
    public static func shown(title: String, purpose: String, facts: [ApprovalFact], warning: String?,
                             onceOnly: String? = nil) -> [String: Any] {
        var shown: [String: Any] = [
            "title": title,
            "purpose": GateCredentialRedactor.text(purpose),
            "facts": facts.map { ["label": $0.label, "value": GateCredentialRedactor.text($0.help ?? $0.value)] },
        ]
        if let warning { shown["warning"] = warning }
        if let onceOnly { shown["onceOnly"] = onceOnly }
        return shown
    }

    /// Appends one line. A value that is not JSON (an optional left in, a custom type) is dropped from the line and
    /// logged, never thrown: an audit write must not stop a gate.
    public static func write(gate: String, event: String, _ fields: [String: Any] = [:]) {
        var entry = fields.filter { JSONSerialization.isValidJSONObject(["value": $0.value]) }
        if entry.count != fields.count {
            KitHost.log("gate audit \(gate) \(event): dropped non-JSON fields \(Set(fields.keys).subtracting(entry.keys).sorted())")
        }
        entry["at"] = ISO8601DateFormatter().string(from: Date())
        entry["gate"] = gate
        entry["event"] = event
        entry["writer"] = [
            "pid": Int(getpid()),
            "app": Bundle.main.bundleIdentifier ?? "",
            "executable": Bundle.main.executablePath ?? "",
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: GateCredentialRedactor.fields(entry), options: [.sortedKeys]) else {
            KitHost.log("gate audit \(gate) \(event): the entry is not JSON")
            return
        }

        appendLine(data, to: path)
    }
}
