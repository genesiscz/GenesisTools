import Foundation

struct WidgetAgentTree {
    struct Row: Identifiable {
        let session: WidgetSession
        let depth: Int
        var id: String { session.key }
    }
    struct Group: Identifiable {
        let parent: WidgetSession
        let children: [Row]
        var id: String { parent.key }
        var running: Int { children.filter { $0.session.agentStatus == "running" || $0.session.status == "working" }.count }
    }

    static func groups(_ sessions: [WidgetSession], query: String = "", onlyPinned: Bool = false) -> [Group] {
        let byKey = Dictionary(sessions.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        var parentOf: [String: String] = [:]
        var children: [String: [WidgetSession]] = [:]
        for session in sessions {
            let parent = session.parentKey.flatMap { byKey[$0] }
            if let parent, parent.key != session.key {
                parentOf[session.key] = parent.key
                children[parent.key, default: []].append(session)
            }
        }
        var included = Set<String>()
        for session in sessions {
            let text = [session.title, session.project, session.target.provider, session.target.cwd,
                        session.model ?? "", session.account ?? "", session.role ?? ""].joined(separator: " ")
            guard (!onlyPinned || session.pinned), query.isEmpty || text.localizedCaseInsensitiveContains(query) else { continue }
            var cursor: String? = session.key
            var seen = Set<String>()
            while let key = cursor, seen.insert(key).inserted {
                included.insert(key)
                cursor = parentOf[key]
            }
            if !query.isEmpty, parentOf[session.key] == nil {
                var pending = children[session.key] ?? []
                var descendants = Set<String>()
                while let child = pending.popLast() {
                    guard descendants.insert(child.key).inserted else { continue }
                    pending.append(contentsOf: children[child.key] ?? [])
                    if !onlyPinned || child.pinned {
                        var ancestor: String? = child.key
                        var visited = Set<String>()
                        while let key = ancestor, visited.insert(key).inserted {
                            included.insert(key)
                            ancestor = parentOf[key]
                        }
                    }
                }
            }
        }
        var visited = Set<String>()
        var result: [Group] = []
        let roots = sessions.filter { parentOf[$0.key] == nil }
        // A malformed cycle or orphan must not hide a session or render it twice.
        for root in roots + sessions {
            guard included.contains(root.key), visited.insert(root.key).inserted else { continue }
            var rows: [Row] = []
            var pending = (children[root.key] ?? []).reversed().map { Row(session: $0, depth: 0) }
            while let row = pending.popLast() {
                guard included.contains(row.id), visited.insert(row.id).inserted else { continue }
                rows.append(row)
                pending.append(contentsOf: (children[row.id] ?? []).reversed().map { Row(session: $0, depth: row.depth + 1) })
            }
            result.append(Group(parent: root, children: rows))
        }
        return result
    }
}
