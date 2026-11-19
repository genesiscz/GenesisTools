import Foundation
import GenesisKitBase

/// The selected item from work.show, including its relationships and journal.
public struct WorkItemDetail: Decodable, Equatable, Sendable {
    public struct Item: Decodable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var type: String
        public var state: String
        public var project: String?
        public var body: String?
        public var acceptance: String?
        public var severity: String?
        public var worker: String?
        public var tags: [String]?
        public var rev: Int?
        public var fields: [String: String]?
        public var checkoutPath: String?

        public init(id: String, title: String, type: String, state: String, project: String? = nil,
                    body: String? = nil, acceptance: String? = nil, severity: String? = nil,
                    worker: String? = nil, tags: [String]? = nil, rev: Int? = nil,
                    fields: [String: String]? = nil) {
            self.id = id; self.title = title; self.type = type; self.state = state
            self.project = project; self.body = body; self.acceptance = acceptance
            self.severity = severity; self.worker = worker; self.tags = tags; self.rev = rev; self.fields = fields
        }

        private enum CodingKeys: String, CodingKey {
            case id, title, type, state, project, body, acceptance, severity, worker, tags, rev, fields, createdBy
        }

        public init(from decoder: Decoder) throws {
            let box = try decoder.container(keyedBy: CodingKeys.self)
            id = try box.decode(String.self, forKey: .id)
            title = try box.decode(String.self, forKey: .title)
            type = try box.decode(String.self, forKey: .type)
            state = try box.decode(String.self, forKey: .state)
            project = try box.decodeIfPresent(String.self, forKey: .project)
            struct Origin: Decodable { var repoRoot: String?; var project: String? }
            if let origin = try box.decodeIfPresent(Origin.self, forKey: .createdBy), let project,
               origin.project?.caseInsensitiveCompare(project) == .orderedSame,
               origin.repoRoot?.hasPrefix("/") == true {
                checkoutPath = origin.repoRoot
            }
            body = try box.decodeIfPresent(String.self, forKey: .body)
            acceptance = try box.decodeIfPresent(String.self, forKey: .acceptance)
            severity = try box.decodeIfPresent(String.self, forKey: .severity)
            worker = try box.decodeIfPresent(WorkDetailActor.self, forKey: .worker)?.label
            tags = try box.decodeIfPresent([String].self, forKey: .tags)
            rev = try box.decodeIfPresent(Int.self, forKey: .rev)
            fields = try box.decodeIfPresent([String: GenesisToolsJSON].self, forKey: .fields)?
                .mapValues { $0.workDetailText }
        }
    }

    public struct Ref: Decodable, Equatable, Sendable, Identifiable {
        public var kind: String
        public var other: String
        public var outgoing: Bool
        public var byTitle: String?
        public var id: String { (outgoing ? "out:" : "in:") + kind + ":" + other }

        public init(kind: String, other: String, outgoing: Bool, byTitle: String? = nil) {
            self.kind = kind; self.other = other; self.outgoing = outgoing; self.byTitle = byTitle
        }

        private enum CodingKeys: String, CodingKey { case kind, other, outgoing, byTitle, to, from, by }
        public init(from decoder: Decoder) throws {
            let box = try decoder.container(keyedBy: CodingKeys.self)
            kind = try box.decode(String.self, forKey: .kind)
            outgoing = try box.decodeIfPresent(Bool.self, forKey: .outgoing) ?? box.contains(.to)
            if let value = try box.decodeIfPresent(String.self, forKey: .other) { other = value }
            else { other = try box.decode(String.self, forKey: outgoing ? .to : .from) }
            byTitle = try box.decodeIfPresent(String.self, forKey: .byTitle)
                ?? box.decodeIfPresent(WorkDetailActor.self, forKey: .by)?.sessionTitle
        }
    }

    public struct Pointer: Decodable, Equatable, Sendable, Identifiable {
        public var kind: String
        public var target: String
        public var id: String { kind + ":" + target }
        public init(kind: String, target: String) { self.kind = kind; self.target = target }
    }

    public struct Event: Decodable, Equatable, Sendable, Identifiable {
        public var seq: Int
        public var ts: Date
        public var kind: String
        public var actor: String
        public var summary: String?
        /// The event's verb and subject, derived from its payload before the view reads it.
        public var action: String
        public var id: Int { seq }

        public init(seq: Int, ts: Date, kind: String, actor: String, summary: String? = nil,
                    action: String? = nil) {
            self.seq = seq; self.ts = ts; self.kind = kind; self.actor = actor; self.summary = summary
            self.action = action ?? Self.action(kind, payload: [:])
        }

        private enum CodingKeys: String, CodingKey { case seq, ts, kind, actor, summary, payload }
        public init(from decoder: Decoder) throws {
            let box = try decoder.container(keyedBy: CodingKeys.self)
            seq = try box.decode(Int.self, forKey: .seq)
            let timestamp = try box.decode(String.self, forKey: .ts)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = fractional.date(from: timestamp) ?? ISO8601DateFormatter().date(from: timestamp) else {
                throw DecodingError.dataCorruptedError(forKey: .ts, in: box, debugDescription: "Invalid work event timestamp")
            }
            ts = date
            kind = try box.decode(String.self, forKey: .kind)
            actor = try box.decode(WorkDetailActor.self, forKey: .actor).label
            let payload = try box.decodeIfPresent([String: GenesisToolsJSON].self, forKey: .payload) ?? [:]
            summary = try box.decodeIfPresent(String.self, forKey: .summary)
                ?? payload["text"]?.workDetailString ?? payload["why"]?.workDetailString
                ?? payload["proof"]?.workDetailObject?["text"]?.workDetailString
                ?? payload["note"]?.workDetailString
            if let measured = payload["measured"]?.workDetailString {
                summary = [summary, measured].compactMap { $0 }.joined(separator: "\n")
            }
            action = Self.action(kind, payload: payload)
        }

        private static func action(_ kind: String, payload: [String: GenesisToolsJSON]) -> String {
            switch kind {
            case "created": return "created it"
            case "claimed": return "claimed it"
            case "released": return "released it"
            case "moved":
                switch payload["to"]?.workDetailString {
                case "open": return payload["from"]?.workDetailString == "active" ? "released it" : "accepted it"
                case "active": return "claimed it"
                case "done": return "finished it"
                case "dropped": return "dropped it"
                case "reopened": return "reopened it"
                default: return "changed its state"
                }
            case "edited":
                let changes = payload["set"]?.workDetailObject ?? [:]
                let names = changes.keys.sorted().flatMap { key -> [String] in
                    if key == "fields", let fields = changes[key]?.workDetailObject { return fields.keys.sorted() }
                    return [key]
                }
                return names.isEmpty ? "edited it" : "edited " + names.map(WorkWords.field).joined(separator: ", ")
            case "linked", "unlinked":
                let relationship = WorkWords.ref(kind: payload["kind"]?.workDetailString ?? "related", outgoing: true)
                let target = payload["to"]?.workDetailString ?? ""
                return "\(kind == "linked" ? "linked" : "unlinked") \(relationship.lowercased()) \(target)".trimmingCharacters(in: .whitespaces)
            case "commented": return "commented"
            case "pointed":
                guard let pointer = payload["pointer"]?.workDetailObject else { return "added a reference" }
                let label = WorkWords.pointer(pointer["kind"]?.workDetailString ?? "reference").lowercased()
                return "added \(label) \(pointer["target"]?.workDetailString ?? "")".trimmingCharacters(in: .whitespaces)
            case "logged":
                let outcome = payload["result"]?.workDetailString.map(WorkWords.word) ?? "unknown"
                return "logged an attempt: \(outcome.lowercased())"
            case "delivered":
                let receipt = payload["receipt"]?.workDetailObject
                if let target = receipt?["to"]?.workDetailObject {
                    let label = target["sessionTitle"]?.workDetailString ?? target["harness"]?.workDetailString
                    if let label { return "delivered to \(label)" }
                }
                return "delivery: " + (receipt?["outcome"]?.workDetailString.map(WorkWords.word) ?? "Unknown").lowercased()
            case "paired": return "paired it"
            case "unpaired": return "unpaired it"
            default: return WorkWords.word(kind)
            }
        }
    }

    public var item: Item
    public var members: [WorkRowValue]?
    public var refs: [Ref]
    public var pointers: [Pointer]
    public var log: [Event]

    public init(item: Item, members: [WorkRowValue]? = nil, refs: [Ref] = [], pointers: [Pointer] = [], log: [Event] = []) {
        self.item = item; self.members = members; self.refs = refs; self.pointers = pointers; self.log = log
    }

    private enum CodingKeys: String, CodingKey { case item, members, refs, pointers, log }
    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        item = try box.decode(Item.self, forKey: .item)
        members = try box.decodeIfPresent([WorkRowValue].self, forKey: .members)
        let relationships = try box.decodeIfPresent(References.self, forKey: .refs)
        refs = (relationships?.out ?? []).map { Ref(kind: $0.kind, other: $0.to, outgoing: true, byTitle: $0.by?.sessionTitle) }
            + (relationships?.incoming ?? []).map { Ref(kind: $0.kind, other: $0.from, outgoing: false, byTitle: $0.by?.sessionTitle) }
        pointers = try box.decodeIfPresent([Pointer].self, forKey: .pointers) ?? []
        log = try box.decodeIfPresent([Event].self, forKey: .log) ?? []
    }

    private struct References: Decodable {
        struct Out: Decodable { var kind: String; var to: String; var by: WorkDetailActor? }
        struct In: Decodable { var kind: String; var from: String; var by: WorkDetailActor? }
        var out: [Out]?
        var incoming: [In]?
        enum CodingKeys: String, CodingKey { case out; case incoming = "in" }
    }
}

private struct WorkDetailActor: Decodable {
    var sessionTitle: String?
    var label: String
    private enum CodingKeys: String, CodingKey { case sessionTitle, kind, harness }
    init(from decoder: Decoder) throws {
        if let string = try? decoder.singleValueContainer().decode(String.self) {
            sessionTitle = nil; label = string; return
        }
        let box = try decoder.container(keyedBy: CodingKeys.self)
        sessionTitle = try box.decodeIfPresent(String.self, forKey: .sessionTitle)
        let kind = try box.decodeIfPresent(String.self, forKey: .kind)
        let harness = try box.decodeIfPresent(String.self, forKey: .harness)
        label = sessionTitle.flatMap { $0.isEmpty ? nil : $0 } ?? (kind == "owner" ? "you" : harness ?? "Unknown")
    }
}

private extension GenesisToolsJSON {
    var workDetailString: String? { if case .string(let value) = self { return value }; return nil }
    var workDetailObject: [String: GenesisToolsJSON]? { if case .object(let value) = self { return value }; return nil }
    var workDetailText: String {
        if let value = workDetailString { return value }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}
