import Foundation
import UserNotifications

/// One macOS notification to post through `NotificationEngine`.
public struct EngineNotification {
    /// Ledger source: `monitor.cache`, `disk`, `hang`, `tools`, ... Quiet rules match on it too.
    public var source: String
    public var title: String
    public var subtitle: String
    public var body: String
    /// A fixed id replaces the card with that id in place. nil posts a fresh `<idPrefix>.<UUID>`.
    public var identifier: String?
    public var idPrefix: String
    /// After the post, older delivered cards with the same key are removed, so one countdown or one
    /// alert leaves one card. A fresh id plus a sweep, because re-using an id lets macOS update the old
    /// card silently with no banner.
    public var replaceKey: String?
    public var category: String?
    public var threadId: String?
    public var userInfo: [String: Any]
    public var sound: UNNotificationSound?
    public var interruption: UNNotificationInterruptionLevel?
    public var attachments: [UNNotificationAttachment]
    /// Buttons for this card only. They are registered as a category named after the card's id, in a
    /// union with every category already registered.
    public var actions: [UNNotificationAction]
    /// Extra ledger fields: the session behind a banner, the alert key, ...
    public var ledgerFields: [String: Any]

    public init(
        source: String,
        title: String,
        subtitle: String = "",
        body: String,
        identifier: String? = nil,
        idPrefix: String = "genesis",
        replaceKey: String? = nil,
        category: String? = nil,
        threadId: String? = nil,
        userInfo: [String: Any] = [:],
        sound: UNNotificationSound? = .default,
        interruption: UNNotificationInterruptionLevel? = nil,
        attachments: [UNNotificationAttachment] = [],
        actions: [UNNotificationAction] = [],
        ledgerFields: [String: Any] = [:]
    ) {
        self.source = source
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.identifier = identifier
        self.idPrefix = idPrefix
        self.replaceKey = replaceKey
        self.category = category
        self.threadId = threadId
        self.userInfo = userInfo
        self.sound = sound
        self.interruption = interruption
        self.attachments = attachments
        self.actions = actions
        self.ledgerFields = ledgerFields
    }
}

public enum NotificationPostResult: Equatable, Sendable {
    case posted(id: String)
    case suppressed(reason: String)
    /// No notification center in this process (`swift test`, a raw binary outside its `.app`).
    case unavailable
}

/// A delivered card, as much of it as the engine needs.
public struct DeliveredNotification {
    public var identifier: String
    public var category: String
    public var threadId: String
    public var userInfo: [AnyHashable: Any]

    public init(identifier: String, category: String, threadId: String, userInfo: [AnyHashable: Any]) {
        self.identifier = identifier
        self.category = category
        self.threadId = threadId
        self.userInfo = userInfo
    }
}

/// The part of `UNUserNotificationCenter` the engine uses. Tests pass a recorder.
public protocol NotificationCenterPort: AnyObject {
    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void)
    func delivered(_ completion: @escaping ([DeliveredNotification]) -> Void)
    func removeDelivered(identifiers: [String])
    func categories(_ completion: @escaping (Set<UNNotificationCategory>) -> Void)
    func setCategories(_ categories: Set<UNNotificationCategory>)
}

final class SystemNotificationCenter: NotificationCenterPort {
    static let shared = SystemNotificationCenter()
    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void) {
        center.add(request, withCompletionHandler: completion)
    }

    func delivered(_ completion: @escaping ([DeliveredNotification]) -> Void) {
        center.getDeliveredNotifications { notes in
            completion(notes.map {
                DeliveredNotification(identifier: $0.request.identifier, category: $0.request.content.categoryIdentifier,
                                      threadId: $0.request.content.threadIdentifier, userInfo: $0.request.content.userInfo)
            })
        }
    }

    func removeDelivered(identifiers: [String]) {
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func categories(_ completion: @escaping (Set<UNNotificationCategory>) -> Void) {
        center.getNotificationCategories(completionHandler: completion)
    }

    func setCategories(_ categories: Set<UNNotificationCategory>) {
        center.setNotificationCategories(categories)
    }
}

/// The one door to macOS Notification Center for Genesis.app, GenesisTools.app and GenesisKit (Martin,
/// 2026-10-23: "one GenesisKit NotificationEngine"). Every post goes through the same steps: quiet rules,
/// category registration as a union, the add, the replacement sweep, and a line in `NotificationLedger`.
/// Before it, four posting paths each did their own subset (two kept a ledger of nothing, one replaced
/// the whole category set, three had no replacement).
public final class NotificationEngine: @unchecked Sendable {
    public static let shared = NotificationEngine()

    /// The userInfo key the replacement sweep reads. Posters keep their own keys beside it.
    public static let replaceKeyInfoKey = "genesis.replaceKey"
    private static let sourceInfoKey = "genesis.source"

    /// nil when this process must not touch Notification Center: `UNUserNotificationCenter.current()`
    /// aborts outside a real `.app` (raw `swift run`, `swift test`).
    public var centerProvider: () -> NotificationCenterPort?
    /// Where ledger lines go; nil is the shared ledger. Tests point it at a temp file.
    public var ledgerFile: String?

    private let lock = NSLock()
    private var rules: [(name: String, rule: (EngineNotification) -> String?)] = []
    private var registered: [String: UNNotificationCategory] = [:]
    private var replacements: [String: [() -> Void]] = [:]

    public init(centerProvider: @escaping () -> NotificationCenterPort? = NotificationEngine.systemCenterIfAvailable,
                ledgerFile: String? = nil) {
        self.centerProvider = centerProvider
        self.ledgerFile = ledgerFile
    }

    public static func systemCenterIfAvailable() -> NotificationCenterPort? {
        guard NSClassFromString("XCTestCase") == nil,
              Bundle.main.bundleIdentifier?.isEmpty == false,
              Bundle.main.bundlePath.hasSuffix(".app")
        else { return nil }
        return SystemNotificationCenter.shared
    }

    // MARK: - Quiet rules

    /// A rule returns a reason to hold the notification back, or nil. Rules run in the order added; the
    /// first reason wins and is written to the ledger as the suppression reason.
    public func addQuietRule(_ name: String, _ rule: @escaping (EngineNotification) -> String?) {
        lock.lock()
        defer { lock.unlock() }
        rules.removeAll { $0.name == name }
        rules.append((name, rule))
    }

    public func removeQuietRule(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        rules.removeAll { $0.name == name }
    }

    func suppression(for note: EngineNotification) -> String? {
        lock.lock()
        let current = rules
        lock.unlock()
        for entry in current {
            if let reason = entry.rule(note) { return "\(entry.name): \(reason)" }
        }
        return nil
    }

    // MARK: - Categories

    /// Adds categories to whatever is registered, never replacing the set: `setNotificationCategories`
    /// replaces it whole, so one feature registering `[mine]` used to wipe every other card's buttons.
    public func register(categories: [UNNotificationCategory], then: (() -> Void)? = nil) {
        guard let center = centerProvider() else {
            then?()
            return
        }
        lock.lock()
        for category in categories { registered[category.identifier] = category }
        lock.unlock()
        center.categories { [weak self] existing in
            guard let self else { return }
            self.lock.lock()
            let mine = self.registered
            self.lock.unlock()
            var next = existing.filter { mine[$0.identifier] == nil }
            next.formUnion(mine.values)
            center.setCategories(next)
            then?()
        }
    }

    // MARK: - Posting

    /// `completion` runs once macOS answered the add, with its error. It does not run for a suppressed or
    /// unavailable result: nothing was added, and the return value already says so.
    @discardableResult
    public func post(_ note: EngineNotification, completion: ((Error?) -> Void)? = nil) -> NotificationPostResult {
        if let reason = suppression(for: note) {
            record(note, outcome: .suppressed, reason: reason, id: nil)
            return .suppressed(reason: reason)
        }
        guard let center = centerProvider() else { return .unavailable }
        let identifier = note.identifier ?? "\(note.idPrefix).\(UUID().uuidString)"
        let request = UNNotificationRequest(identifier: identifier, content: content(note, identifier: identifier),
                                            trigger: nil)
        let add = { [weak self] in
            center.add(request) { error in
                if let error {
                    self?.record(note, outcome: .failed, reason: error.localizedDescription, id: identifier)
                    if let key = note.replaceKey { self?.finishReplacement(key) }
                } else if let key = note.replaceKey {
                    self?.sweep(center: center, replaceKey: key, keep: identifier) { [weak self] in
                        self?.finishReplacement(key)
                    }
                }
                completion?(error)
            }
        }
        record(note, outcome: .posted, reason: nil, id: identifier)
        let start: () -> Void = { [weak self] in
            if note.actions.isEmpty {
                add()
            } else {
                self?.register(categories: [UNNotificationCategory(identifier: identifier, actions: note.actions,
                                                                   intentIdentifiers: [], options: [])], then: add)
            }
        }
        if let key = note.replaceKey {
            lock.lock()
            replacements[key, default: []].append(start)
            let first = replacements[key]?.count == 1
            lock.unlock()
            if first { start() }
        } else {
            start()
        }
        return .posted(id: identifier)
    }

    func content(_ note: EngineNotification, identifier: String) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = note.title
        if !note.subtitle.isEmpty { content.subtitle = note.subtitle }
        content.body = note.body
        content.sound = note.sound
        if let interruption = note.interruption { content.interruptionLevel = interruption }
        if !note.actions.isEmpty {
            content.categoryIdentifier = identifier
        } else if let category = note.category {
            content.categoryIdentifier = category
        }
        if let thread = note.threadId ?? note.replaceKey { content.threadIdentifier = thread }
        var info = note.userInfo
        info[Self.sourceInfoKey] = note.source
        if let key = note.replaceKey { info[Self.replaceKeyInfoKey] = key }
        content.userInfo = info
        content.attachments = note.attachments
        return content
    }

    /// Older cards with the same replace key, never the one just posted (the delivered list is read
    /// asynchronously and may already hold it).
    static func stale(_ delivered: [DeliveredNotification], replaceKey: String, keep: String) -> [String] {
        delivered
            .filter { $0.identifier != keep && $0.userInfo[replaceKeyInfoKey] as? String == replaceKey }
            .map(\.identifier)
    }

    private func finishReplacement(_ key: String) {
        lock.lock()
        replacements[key]?.removeFirst()
        let next = replacements[key]?.first
        if next == nil { replacements.removeValue(forKey: key) }
        lock.unlock()
        next?()
    }

    private func sweep(center: NotificationCenterPort, replaceKey: String, keep: String,
                       completion: @escaping () -> Void) {
        center.delivered { delivered in
            let stale = Self.stale(delivered, replaceKey: replaceKey, keep: keep)
            if !stale.isEmpty { center.removeDelivered(identifiers: stale) }
            completion()
        }
    }

    // MARK: - Withdrawing and counting

    /// Removes delivered cards that match, and answers with their ids.
    public func withdraw(where match: @escaping (DeliveredNotification) -> Bool,
                         completion: (([String]) -> Void)? = nil) {
        guard let center = centerProvider() else {
            completion?([])
            return
        }
        center.delivered { delivered in
            let matches = delivered.filter(match)
            let ids = matches.map(\.identifier)
            if !ids.isEmpty {
                center.removeDelivered(identifiers: ids)
                for card in matches {
                    var fields: [String: Any] = ["id": card.identifier, "category": card.category]
                    if let key = card.userInfo[Self.replaceKeyInfoKey] as? String { fields["replaceKey"] = key }
                    NotificationLedger.record(source: card.userInfo[Self.sourceInfoKey] as? String ?? "notification-engine",
                                              channel: "macos", outcome: .withdrawn, fields: fields, file: self.ledgerFile)
                }
            }
            completion?(ids)
        }
    }

    public func withdraw(replaceKey: String, completion: (([String]) -> Void)? = nil) {
        withdraw(where: { $0.userInfo[Self.replaceKeyInfoKey] as? String == replaceKey }, completion: completion)
    }

    /// Delivered cards that match, without removing them.
    public func delivered(where match: @escaping (DeliveredNotification) -> Bool,
                          completion: @escaping ([String]) -> Void) {
        guard let center = centerProvider() else {
            completion([])
            return
        }
        center.delivered { completion($0.filter(match).map(\.identifier)) }
    }

    // MARK: - Ledger

    private func record(_ note: EngineNotification, outcome: NotificationLedger.Outcome, reason: String?, id: String?) {
        var fields = note.ledgerFields
        if let id { fields["id"] = id }
        if let key = note.replaceKey { fields["replaceKey"] = key }
        if let category = note.category { fields["category"] = category }
        NotificationLedger.record(source: note.source, channel: "macos", outcome: outcome, title: note.title,
                                  subtitle: note.subtitle.isEmpty ? nil : note.subtitle, body: note.body,
                                  reason: reason, fields: fields, file: ledgerFile)
    }
}
