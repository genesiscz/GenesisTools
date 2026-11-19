import Foundation

/// A window-local filter over the rows already read by Work.
public struct WorkFilter: Equatable, Sendable {
    public enum StateGroup: String, CaseIterable, Sendable {
        case open, spotted, reopened, done, dropped

        public func contains(_ state: String) -> Bool {
            self == .open ? state == "open" || state == "active" : rawValue == state
        }
    }

    public var text: String
    public var types: Set<String>
    public var states: Set<StateGroup>
    public var severities: Set<String>
    public var mine: Bool

    public init(text: String = "", types: Set<String> = [],
                states: Set<StateGroup> = [.open, .spotted, .reopened],
                severities: Set<String> = [], mine: Bool = false) {
        self.text = text; self.types = types; self.states = states
        self.severities = severities; self.mine = mine
    }

    public static let `default` = WorkFilter()
    public var isActive: Bool { self != .default }
    public var requiresIndex: Bool {
        mine || !severities.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || states.isEmpty
            || states.contains(.done) || states.contains(.dropped)
    }

    /// A whole ref, optionally followed by a task slot, can be opened even before its row is indexed.
    public var fullRef: String? {
        let candidate = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = candidate.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count <= 2, let base = parts.first else { return nil }
        let bits = base.split(separator: "_", omittingEmptySubsequences: false)
        guard bits.count == 2, ["w", "h", "t"].contains(bits[0].lowercased()),
              bits[1].count == 8, bits[1].allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        if parts.count == 2 {
            guard !parts[1].isEmpty,
                  parts[1].allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        }
        return base.lowercased() + (parts.count == 2 ? ":" + String(parts[1]) : "")
    }

    public struct Row: Equatable, Sendable {
        public var ref: String
        public var title: String
        public var type: String
        public var state: String
        public var severity: String?
        public var worker: String?
        public var text: [String]

        public init(ref: String, title: String, type: String, state: String,
                    severity: String? = nil, worker: String? = nil, text: [String] = []) {
            self.ref = ref; self.title = title; self.type = type; self.state = state
            self.severity = severity; self.worker = worker; self.text = text
        }

        public init(_ row: WorkRowValue) {
            self.init(ref: row.ref, title: row.title, type: row.type, state: row.state,
                      severity: row.severity, worker: row.worker, text: [row.slot].compactMap { $0 })
        }

        public init(_ row: WorkTriageValue) {
            self.init(ref: row.ref, title: row.title, type: row.type, state: row.state,
                      severity: row.severity, worker: row.worker,
                      text: [row.where, row.why, row.userSees].compactMap { $0 })
        }

        public init(_ row: WorkContainerValue) {
            self.init(ref: row.ref, title: row.title, type: row.type, state: row.state)
        }
    }

    public func matches(_ row: Row) -> Bool {
        matches(row, words: Self.words(text), exactRef: Self.fold(text.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    /// Stable sorts put a pasted complete ref before word-prefix matches.
    public func rank(_ row: Row) -> Int {
        let query = Self.fold(text.trimmingCharacters(in: .whitespacesAndNewlines))
        return !query.isEmpty && Self.fold(row.ref) == query ? 0 : 1
    }

    fileprivate func matches(_ row: Row, words query: [String], exactRef: String) -> Bool {
        // Text search includes the archive with the default state choice. An explicit state choice still wins.
        let searchingArchive = !query.isEmpty && states == Self.default.states
            && ["done", "dropped"].contains(row.state)
        guard states.isEmpty || states.contains(where: { $0.contains(row.state) }) || searchingArchive,
              types.isEmpty || types.contains(row.type),
              severities.isEmpty || row.severity.map({ severities.contains($0) }) == true else { return false }
        if mine, let worker = row.worker,
           !["hub ?", "unknown ?", "human ?"].contains(worker) { return false }
        guard !query.isEmpty else { return true }
        if !exactRef.isEmpty && Self.fold(row.ref) == exactRef { return true }
        let tokens = Self.words(([row.title, row.ref, row.type, row.worker ?? ""] + row.text).joined(separator: " "))
        return query.allSatisfy { word in tokens.contains(where: { $0.hasPrefix(word) }) }
    }

    fileprivate static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    fileprivate static func words(_ text: String) -> [String] {
        fold(text).components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }
}

/// The list and keyboard navigation consume this same projection. Source order is retained except for exact refs.
public struct WorkItemsProjection: Equatable, Sendable {
    public struct Container: Equatable, Sendable, Identifiable {
        public var value: WorkContainerValue
        public var members: [WorkRowValue]
        public var matchingCount: Int { members.count }
        public var isExpanded: Bool
        public var ref: String { value.ref }
        public var id: String { ref }
    }

    public struct TriageGroup: Equatable, Sendable, Identifiable {
        public var type: String
        public var rows: [WorkTriageValue]
        public var id: String { type }
    }

    public var containers: [Container]
    public var spottedGroups: [TriageGroup]
    public var reopened: [WorkTriageValue]
    public var other: [WorkRowValue]
    public var archive: [WorkRowValue]
    public var archiveCount: Int
    public var matchedCount: Int
    public var totalCount: Int
    public var visibleRefs: [String]
    public var hasMoreArchive: Bool { archiveCount > archive.count }
    public var isEmpty: Bool { matchedCount == 0 }
    public var spotted: [WorkTriageValue] { spottedGroups.flatMap(\.rows) }

    public init(snapshot: WorkSnapshotValue, filter: WorkFilter = .default, index: [WorkRowValue] = [],
                archiveLimit: Int = 200, expanded: Set<String> = [], collapsed: Set<String> = []) {
        let words = WorkFilter.words(filter.text)
        let exactRef = WorkFilter.fold(filter.text.trimmingCharacters(in: .whitespacesAndNewlines))
        let containerFacts = filter.mine || !filter.severities.isEmpty
            ? Dictionary(index.map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first }) : [:]
        // Keep the section order when a title mentions the full ref of an item in a later section.
        // A known exact hit is the result; the container around a matching member supplies context.
        let hasExact: Bool = filter.fullRef != nil && (
            index.contains { WorkFilter.fold($0.ref) == exactRef && filter.matches(.init($0)) }
            || snapshot.triage.contains { WorkFilter.fold($0.ref) == exactRef && filter.matches(.init($0)) }
            || snapshot.containers.contains { container in
                (WorkFilter.fold(container.ref) == exactRef && (!filter.mine || containerFacts[container.ref] != nil)
                    && filter.matches(containerFacts[container.ref].map(WorkFilter.Row.init) ?? .init(container)))
                    || container.members.contains { WorkFilter.fold($0.ref) == exactRef && filter.matches(.init($0)) }
            })
        func matches(_ row: WorkFilter.Row) -> Bool {
            (!hasExact || WorkFilter.fold(row.ref) == exactRef) && filter.matches(row, words: words, exactRef: exactRef)
        }
        var matched = Set<String>()
        var all = Set<String>()
        var represented = Set<String>()
        var projected: [Container] = []
        for container in snapshot.containers {
            all.insert(container.ref)
            represented.insert(container.ref)
            for member in container.members { all.insert(member.ref); represented.insert(member.ref) }
            let members = container.members.filter {
                !filter.isActive || (!["done", "dropped"].contains($0.state) && matches(.init($0)))
            }
            let facts = containerFacts[container.ref]
            let ownMatch = (!filter.mine || facts != nil) && matches(facts.map(WorkFilter.Row.init) ?? .init(container))
            guard ownMatch || !members.isEmpty else { continue }
            if ownMatch { matched.insert(container.ref) }
            matched.formUnion(members.map(\.ref))
            let opensForMatch = filter.isActive && !members.isEmpty
            projected.append(Container(value: container, members: members,
                                       isExpanded: !collapsed.contains(container.ref)
                                           && (expanded.contains(container.ref) || opensForMatch)))
        }
        containers = projected
        for row in snapshot.triage { all.insert(row.ref) }
        represented.formUnion(snapshot.spotted.map(\.ref))
        represented.formUnion(snapshot.reopened.map(\.ref))
        let spotted = snapshot.spotted.filter { matches(.init($0)) }
        spottedGroups = Dictionary(grouping: spotted, by: \.type).map { TriageGroup(type: $0.key, rows: $0.value) }
            .sorted { $0.type < $1.type }
        reopened = snapshot.reopened.filter { matches(.init($0)) }
        matched.formUnion(spotted.map(\.ref)); matched.formUnion(reopened.map(\.ref))
        var indexed = Set<String>()
        var archived: [WorkRowValue] = []
        var others: [WorkRowValue] = []
        // The index owns newest-first order. Closed members fill any rows it has not returned yet.
        let closedMembers = snapshot.containers.flatMap(\.members).filter { ["done", "dropped"].contains($0.state) }
        let triageContext = Dictionary(snapshot.triage.map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first })
        for row in index + closedMembers {
            all.insert(row.ref)
            guard indexed.insert(row.ref).inserted else { continue }
            var facts = WorkFilter.Row(row)
            if let triage = triageContext[row.ref] { facts.text += WorkFilter.Row(triage).text }
            guard matches(facts) else { continue }
            if ["done", "dropped"].contains(row.state) {
                // Closed members belong to the archive, not to a second copy beneath their container.
                if !matched.contains(row.ref) { archived.append(row) }
            } else if filter.isActive && filter.requiresIndex && !represented.contains(row.ref) {
                others.append(row)
            }
        }
        other = others
        archiveCount = archived.count
        archive = Array(archived.prefix(max(0, archiveLimit)))
        matched.formUnion(others.map(\.ref)); matched.formUnion(archived.map(\.ref))
        matchedCount = matched.count
        totalCount = all.count
        var visible: [String] = []
        for container in containers {
            visible.append(container.ref)
            if container.isExpanded { visible.append(contentsOf: container.members.map(\.ref)) }
        }
        visible.append(contentsOf: spottedGroups.flatMap { $0.rows.map(\.ref) })
        visible.append(contentsOf: reopened.map(\.ref))
        visible.append(contentsOf: other.map(\.ref))
        visible.append(contentsOf: archive.map(\.ref))
        var seen = Set<String>()
        visibleRefs = visible.filter { seen.insert($0).inserted }
    }
}

/// Store tokens have one set of readable words across the find bar and inspector.
public enum WorkWords {
    public static let types = ["epic", "handoff", "feature", "bug", "incident", "task", "test", "cleanup", "check", "idea", "risk", "limit", "todo"]
    public static let severities = ["critical", "high", "medium", "low"]

    public static func word(_ value: String) -> String { type(value) }
    public static func state(_ value: String) -> String { fallback(value) }
    public static func stateGroup(_ value: WorkFilter.StateGroup) -> String {
        value == .open ? "Open or active" : state(value.rawValue)
    }
    public static func type(_ value: String) -> String {
        ["cleanup": "Clean-up", "todo": "To-do"][value] ?? fallback(value)
    }
    public static func severity(_ value: String?) -> String { value.map(fallback) ?? "Not judged" }
    public static func pointer(_ value: String) -> String {
        ["commit": "Commit", "file": "File", "pr": "Pull request", "url": "Link"][value] ?? fallback(value)
    }
    public static func ref(kind: String, outgoing: Bool) -> String {
        let out = ["parent": "Part of", "member": "Has task", "member-of": "Task of", "related": "Related to",
                   "duplicate-of": "Duplicate of", "recheck-of": "Recheck of", "follow-up-of": "Follow-up of",
                   "blocks": "Blocks", "spotted-in": "Spotted in"]
        let incoming = ["parent": "Has part", "member": "Task of", "member-of": "Has task", "related": "Related to",
                        "duplicate-of": "Has duplicate", "recheck-of": "Rechecked by", "follow-up-of": "Followed up by",
                        "blocks": "Blocked by", "spotted-in": "Spotted here"]
        return (outgoing ? out : incoming)[kind] ?? fallback(kind)
    }
    public static func field(_ value: String) -> String {
        ["where": "Where", "why": "Why", "userSees": "What the user sees", "existedBefore": "Existed before"][value]
            ?? fallback(value)
    }
    public static func fallback(_ value: String) -> String {
        value.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ").capitalized
    }
}
