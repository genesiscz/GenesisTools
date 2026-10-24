import Foundation

/// What the widget last saw of each session, so a switch shows the session's cards at once instead of "Loading this
/// session's inbox…" until a snapshot names it (Martin, 2026-10-24: "can't it just be cached and be prepared at all
/// times and the new decisions would be just appended"). Every snapshot refreshes the sessions it carries: the selected
/// one in full (cards, decision activity, changes), the warm ones (`warmKeys`, the sessions that need you) with their
/// newest cards. The snapshot that names a session after the switch replaces what is shown, so new cards just appear.
struct WidgetSessionCache {
    struct Detail: Equatable {
        var cards: [WidgetCard]
        var activity: [WidgetActivityEvent]?
        var changes: WidgetSnapshot.Changes?
    }

    /// Sessions kept; the least recently refreshed goes first.
    static let limit = 48
    private var details: [String: Detail] = [:]
    private var order: [String] = []

    subscript(key: String) -> Detail? { details[key] }

    var count: Int { details.count }

    mutating func remember(_ snapshot: WidgetSnapshot) {
        let warm = snapshot.warmKeys ?? []
        let selected = snapshot.selectedKey.flatMap { $0.isEmpty ? nil : $0 }
        guard !warm.isEmpty || selected != nil else { return }
        let grouped = Dictionary(grouping: snapshot.cards, by: \.sessionKey)
        for key in warm where key != selected {
            // Activity and changes come only with a selection; the last ones seen stay until the next.
            var detail = details[key] ?? Detail(cards: [])
            detail.cards = grouped[key] ?? []
            store(key, detail)
        }
        if let selected {
            store(selected, Detail(cards: grouped[selected] ?? [], activity: snapshot.activity, changes: snapshot.changes))
        }
    }

    private mutating func store(_ key: String, _ detail: Detail) {
        details[key] = detail
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.limit {
            details.removeValue(forKey: order.removeFirst())
        }
    }
}
