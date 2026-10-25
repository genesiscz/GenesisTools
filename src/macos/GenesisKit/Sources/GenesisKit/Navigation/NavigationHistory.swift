import Foundation

// A browser's history plus a log: every place a window showed, who took it there (the person, an agent, a link) and
// why, with back and forward that walk it and a hop to any entry. The host owns the target type (the hub's is its
// link query) and the storage (`NavigationHistoryStore`); this type only decides the order.

/// Who moved the window to a place.
public enum NavigationActor: String, Codable, CaseIterable, Sendable {
    /// A click, a key or a menu in the window itself.
    case user
    /// An agent that asked for it (`tools hub nav open --actor agent`), usually with a note.
    case agent
    /// A link from outside the window (a browser, a notification, `tools hub open`) that named no actor.
    case link

    public var title: String {
        switch self {
        case .user: return "User"
        case .agent: return "Agent"
        case .link: return "Link"
        }
    }
}

/// One place in the log.
public struct NavigationEntry<Target: Codable & Hashable>: Identifiable, Codable, Hashable {
    public var id: String
    public var at: Date
    public var target: Target
    /// What the place is, for the arrows' tooltips and the history list ("PR #563 Fix the login").
    public var title: String
    public var actor: NavigationActor
    /// The agent session that asked for it, when an agent did.
    public var agentSession: String?
    /// Why the agent opened it ("the commit that broke the build").
    public var note: String?

    public init(
        id: String = UUID().uuidString, at: Date = Date(), target: Target, title: String,
        actor: NavigationActor = .user, agentSession: String? = nil, note: String? = nil
    ) {
        self.id = id
        self.at = at
        self.target = target
        self.title = title
        self.actor = actor
        self.agentSession = agentSession
        self.note = note
    }
}

extension NavigationEntry: Sendable where Target: Sendable {}

/// Where a host keeps the log. `load` runs once at start, `record` after each new or changed entry; both may be
/// slow (a `tools` call), so the host runs them off the main thread.
public protocol NavigationHistoryStore<Target>: AnyObject {
    associatedtype Target: Codable & Hashable
    /// Every kept entry, in any order.
    func load() throws -> [NavigationEntry<Target>]
    /// Adds the entry, or replaces the one with its id, and keeps at most `keep` entries (the newest).
    func record(_ entry: NavigationEntry<Target>, keep: Int) throws
}

/// The log and the cursor in it. A value type with no clock and no I/O, so tests drive it.
///
/// - `visit` adds an entry and moves to it; the places ahead of the cursor leave the forward stack, as in a
///   browser, but stay in the log, so a hop still reaches them. Nothing is ever replaced.
/// - `goBack` / `goForward` move the cursor; `hop(to:)` moves it to any entry.
/// - A provisional place (a mode whose list still loads) is shown but never kept: the next visit takes its
///   spot, so the history holds no stop with nothing in it.
public struct NavigationHistory<Target: Codable & Hashable>: Equatable {
    public typealias Entry = NavigationEntry<Target>

    public static var defaultLimit: Int { 200 }

    /// Oldest first.
    public private(set) var entries: [Entry] = []
    /// Ids, oldest first; the last is the place Back goes to.
    public private(set) var backIDs: [String] = []
    /// Ids, farthest first; the last is the place Forward goes to.
    public private(set) var forwardIDs: [String] = []
    public private(set) var currentID: String?
    /// The place on screen is not in the log (see `visit(…provisional:)`).
    public private(set) var currentTarget: Target?
    /// How many entries the log keeps; the oldest go first.
    public private(set) var limit: Int

    public init(limit: Int = Self.defaultLimit) {
        self.limit = max(1, limit)
    }

    /// A log read back from the store: every entry is behind the cursor, the newest is the current place.
    public init(entries: [Entry], limit: Int = Self.defaultLimit) {
        self.limit = max(1, limit)
        let sorted = entries.sorted { $0.at < $1.at }
        self.entries = Array(sorted.suffix(self.limit))
        backIDs = self.entries.dropLast().map(\.id)
        currentID = self.entries.last?.id
        currentTarget = self.entries.last?.target
    }

    public var canGoBack: Bool { !backIDs.isEmpty }
    public var canGoForward: Bool { !forwardIDs.isEmpty }
    public var current: Entry? { currentID.flatMap(entry) }
    public var backEntry: Entry? { backIDs.last.flatMap(entry) }
    public var forwardEntry: Entry? { forwardIDs.last.flatMap(entry) }
    /// Newest first, for a list.
    public var newestFirst: [Entry] { entries.reversed() }

    public func entry(_ id: String) -> Entry? {
        entries.last { $0.id == id }
    }

    /// Where an entry sits relative to the cursor: negative behind it (−1 is Back), positive ahead, 0 for the
    /// current place, nil for an entry that only the log holds (left by a visit after going back).
    public func offset(of id: String) -> Int? {
        if id == currentID { return 0 }
        if let index = backIDs.lastIndex(of: id) { return index - backIDs.count }
        if let index = forwardIDs.lastIndex(of: id) { return forwardIDs.count - index }
        return nil
    }

    /// A new place on screen. Returns the entry the store must write: the new one, an existing one an agent
    /// annotated, or nil when nothing changed (the same place again, a provisional place, a return).
    ///
    /// - The same place as the current one: a user's visit is nothing; an agent's or a link's replaces the current
    ///   entry's who, note and id in place, so an agent opening what is already shown still leaves its note.
    /// - After a provisional place: the new place takes its spot; when it is the place right behind, the cursor
    ///   goes back to it rather than logging a copy ("out to an empty mode and straight back").
    @discardableResult
    public mutating func visit(
        _ target: Target, title: String, actor: NavigationActor = .user, agentSession: String? = nil,
        note: String? = nil, id: String? = nil, at: Date = Date(), provisional: Bool = false
    ) -> Entry? {
        if target == currentTarget, currentID != nil || provisional {
            guard !provisional, let currentID, actor != .user, let index = entries.lastIndex(where: { $0.id == currentID })
            else { return nil }
            var annotated = entries[index]
            annotated.actor = actor
            annotated.agentSession = agentSession
            annotated.note = note
            annotated.at = at
            if !title.isEmpty { annotated.title = title }
            if let id, id != currentID {
                // The id the agent's CLI already stored, so the store keeps one row for it.
                annotated.id = id
                self.currentID = id
            }
            entries.remove(at: index)
            entries.append(annotated)
            return annotated
        }
        let wasProvisional = currentID == nil && currentTarget != nil
        if provisional {
            if !wasProvisional, let currentID {
                backIDs.append(currentID)
                forwardIDs.removeAll()
            }
            self.currentID = nil
            currentTarget = target
            trim()
            return nil
        }
        if wasProvisional, let last = backIDs.last, entry(last)?.target == target {
            backIDs.removeLast()
            currentID = last
            currentTarget = target
            return nil
        }
        let made = Entry(id: id ?? UUID().uuidString, at: at, target: target, title: title, actor: actor,
                         agentSession: agentSession, note: note)
        if let currentID {
            backIDs.append(currentID)
        }
        forwardIDs.removeAll()
        entries.removeAll { $0.id == made.id }
        entries.append(made)
        currentID = made.id
        currentTarget = target
        trim()
        return made
    }

    /// Adds an entry to the log without moving to it: an agent's place while agents may only add to the list.
    @discardableResult
    public mutating func record(
        _ target: Target, title: String, actor: NavigationActor, agentSession: String? = nil, note: String? = nil,
        id: String? = nil, at: Date = Date()
    ) -> Entry {
        let made = Entry(id: id ?? UUID().uuidString, at: at, target: target, title: title, actor: actor,
                         agentSession: agentSession, note: note)
        entries.removeAll { $0.id == made.id }
        entries.append(made)
        trim()
        return made
    }

    public mutating func goBack() -> Entry? {
        guard let previous = backIDs.popLast() else { return nil }
        if let currentID {
            forwardIDs.append(currentID)
        }
        return move(to: previous)
    }

    public mutating func goForward() -> Entry? {
        guard let next = forwardIDs.popLast() else { return nil }
        if let currentID {
            backIDs.append(currentID)
        }
        return move(to: next)
    }

    /// Moves to any entry. One behind or ahead keeps the stacks a browser would (the places passed over stay on
    /// the other side); an entry only the log holds goes on top, as a visit does, without a new entry.
    public mutating func hop(to id: String) -> Entry? {
        guard id != currentID, entry(id) != nil else { return nil }
        if let index = backIDs.lastIndex(of: id) {
            let passed = Array(backIDs[(index + 1)...]) + (currentID.map { [$0] } ?? [])
            forwardIDs.append(contentsOf: passed.reversed())
            backIDs.removeSubrange(index...)
        } else if let index = forwardIDs.lastIndex(of: id) {
            let passed = (currentID.map { [$0] } ?? []) + forwardIDs[(index + 1)...].reversed()
            backIDs.append(contentsOf: passed)
            forwardIDs.removeSubrange(index...)
        } else {
            if let currentID {
                backIDs.append(currentID)
            }
            forwardIDs.removeAll()
        }
        return move(to: id)
    }

    /// Changes the cap; the oldest entries beyond it go.
    public mutating func setLimit(_ limit: Int) {
        self.limit = max(1, limit)
        trim()
    }

    /// Gives an entry a better title once its place has loaded (a PR's title arrives after its number).
    public mutating func retitle(_ id: String, _ title: String) -> Entry? {
        guard !title.isEmpty, let index = entries.lastIndex(where: { $0.id == id }), entries[index].title != title
        else { return nil }
        entries[index].title = title
        return entries[index]
    }

    /// Gives an entry the place its target turned out to be once shown (an agent's `pr=563` becomes the hub's own
    /// form of that PR), so the place on screen and its entry stay equal and the next look at it adds nothing.
    public mutating func retarget(_ id: String, to target: Target, title: String? = nil) -> Entry? {
        guard let index = entries.lastIndex(where: { $0.id == id }) else { return nil }
        let unchanged = entries[index].target == target && (title.map { $0.isEmpty || $0 == entries[index].title } ?? true)
        guard !unchanged else { return nil }
        entries[index].target = target
        if let title, !title.isEmpty { entries[index].title = title }
        if id == currentID { currentTarget = target }
        return entries[index]
    }

    /// Puts a log read back from the store behind what this window already did since it opened: entries it does
    /// not hold yet, oldest first, become the oldest places Back reaches. When the log ends on the place this window
    /// opened on (a relaunch on the place it left), the two are one entry, the log's: its id, who and note. Returns
    /// the ids of this window's entries that merged away, which the host must not store.
    @discardableResult
    public mutating func adoptOlder(_ older: [Entry]) -> [String] {
        let known = Set(entries.map(\.id))
        var fresh = older.filter { !known.contains($0.id) }.sorted { $0.at < $1.at }
        guard !fresh.isEmpty else { return [] }
        var merged: [String] = []
        if let newest = fresh.last, let oldest = entries.first, newest.target == oldest.target {
            fresh.removeLast()
            merged.append(oldest.id)
            entries[0] = newest
            backIDs = backIDs.map { $0 == oldest.id ? newest.id : $0 }
            forwardIDs = forwardIDs.map { $0 == oldest.id ? newest.id : $0 }
            if currentID == oldest.id { currentID = newest.id }
        }
        entries = fresh + entries
        backIDs = fresh.map(\.id) + backIDs
        if currentID == nil, currentTarget == nil, let last = backIDs.popLast() {
            currentID = last
            currentTarget = entry(last)?.target
        }
        trim()
        return merged
    }

    private mutating func move(to id: String) -> Entry? {
        currentID = id
        let landed = entry(id)
        currentTarget = landed?.target
        return landed
    }

    private mutating func trim() {
        guard entries.count > limit else { return }
        let keep = currentID
        let dropped = Set(entries.map(\.id).filter { $0 != keep }.prefix(entries.count - limit))
        entries.removeAll { dropped.contains($0.id) }
        backIDs.removeAll { dropped.contains($0) }
        forwardIDs.removeAll { dropped.contains($0) }
    }
}
