//
//  MarkdownDocumentsModel+TabGroups.swift
//  GenesisKit
//
//  The tab groups of one window: computed by `MarkdownTabGrouping` from the open tabs, the rule and the reader's own
//  edits (`GenesisKitMarkdownConfiguration.tabGroupState`), and the in-place actions the tab bar's menus and drags call.
//

import Foundation

/// The inputs of the last grouping and its result, so a tab bar pass that changed none of them reuses it.
final class MarkdownTabGroupMemo {
    struct Inputs: Equatable {
        var ids: [String]
        var rule: MarkdownTabGroupRule
        var state: MarkdownTabGroupState
        var minimum: Int
        var splitAbove: Int
        var day: Int
    }

    var inputs: Inputs?
    var groups: [MarkdownTabGroup] = []
}

extension MarkdownDocumentsModel {
    /// Whether the tab bar shows groups now: a rule is chosen and enough tabs are open.
    var groupsTabs: Bool {
        configuration.tabGrouping != .off && docs.count >= max(1, configuration.tabGroupFrom)
    }

    /// The open tabs as groups, or none while `groupsTabs` is false.
    var tabGroups: [MarkdownTabGroup] {
        guard groupsTabs else { return [] }
        let config = configuration
        let inputs = MarkdownTabGroupMemo.Inputs(
            ids: docs.map(\.id), rule: config.tabGrouping, state: config.tabGroupState,
            minimum: config.tabGroupMinimum, splitAbove: config.tabGroupSplitAbove,
            day: Calendar.current.ordinality(of: .day, in: .era, for: Date()) ?? 0)
        if tabGroupMemo.inputs == inputs { return tabGroupMemo.groups }
        let groups = MarkdownTabGrouping.groups(
            docs.map { MarkdownTabGroupItem(id: $0.id, path: $0.url.path, title: $0.title) },
            rule: inputs.rule, state: inputs.state, minimumSize: inputs.minimum, splitAbove: inputs.splitAbove)
        tabGroupMemo.inputs = inputs
        tabGroupMemo.groups = groups
        return groups
    }

    /// The tab order the bar shows, for Next Tab and Previous Tab.
    var visibleTabOrder: [String] {
        let groups = tabGroups
        guard !groups.isEmpty else { return docs.map(\.id) }
        return MarkdownTabGrouping.visualOrder(groups, collapsed: configuration.tabGroupState.collapsed,
                                               selected: selected?.id)
    }

    func group(of tabID: String) -> MarkdownTabGroup? {
        tabGroups.first { $0.tabIDs.contains(tabID) }
    }

    // MARK: Collapse

    func toggleGroup(_ id: String) {
        editGroups { state in
            if state.collapsed.contains(id) { state.collapsed.remove(id) } else { state.collapsed.insert(id) }
        }
    }

    /// ⌥-click on a group: this one open, every other one folded.
    func focusGroup(_ id: String) {
        let others = Set(tabGroups.map(\.id)).subtracting([id])
        editGroups { state in state.collapsed = others }
    }

    func setAllGroups(collapsed: Bool) {
        let all = Set(tabGroups.map(\.id))
        editGroups { state in state.collapsed = collapsed ? all : [] }
    }

    // MARK: Names and order

    func renameGroup(_ id: String, to title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        editGroups { state in state.names[id] = trimmed.isEmpty ? nil : trimmed }
    }

    /// Moves a group before another one, or to the end with nil. The order is kept for groups that come back.
    func moveGroup(_ id: String, before target: String?) {
        guard id != target else { return }
        var order = tabGroups.map(\.id)
        order.removeAll { $0 == id }
        let slot = target.flatMap { order.firstIndex(of: $0) } ?? order.endIndex
        order.insert(id, at: slot)
        let current = configuration.tabGroupState.order
        editGroups { state in state.order = order + current.filter { !order.contains($0) } }
    }

    /// One step left or right, from a group's menu.
    func shiftGroup(_ id: String, by offset: Int) {
        let ids = tabGroups.map(\.id)
        guard let index = ids.firstIndex(of: id) else { return }
        let target = index + offset
        guard ids.indices.contains(target) else { return }
        moveGroup(id, before: offset < 0 ? ids[target] : (target + 1 < ids.count ? ids[target + 1] : nil))
    }

    // MARK: Moving tabs between groups

    /// Puts a tab in a group by hand; nil gives it back to the rule.
    func assign(_ tabID: String, to groupID: String?) {
        editGroups { state in state.assigned[tabID] = groupID }
    }

    /// A new group holding this tab, named after it until the reader renames it.
    @discardableResult
    func newGroup(with tabID: String, title: String? = nil) -> String {
        let id = MarkdownTabGrouping.manualPrefix + UUID().uuidString.prefix(8).lowercased()
        let name = title ?? "New Group"
        editGroups { state in
            state.assigned[tabID] = id
            state.names[id] = name
            state.collapsed.remove(id)
        }
        return id
    }

    /// A tab dropped on another tab: before or after it (the half of the tab under the pointer), into that tab's
    /// group.
    func dropTab(_ dragged: String, beside target: String, after: Bool) {
        guard dragged != target else { return }
        if groupsTabs, let destination = group(of: target), group(of: dragged)?.id != destination.id {
            assign(dragged, to: destination.id)
        }
        guard after else {
            moveTab(dragged, before: target)
            return
        }
        // After the target is before whatever follows it; the target's group keeps the dragged tab beside it.
        let next = docs.firstIndex { $0.id == target }.flatMap { index in
            docs[(index + 1)...].first { $0.id != dragged }?.id
        }
        moveTab(dragged, before: next)
    }

    /// A group dropped on a chip or on one of another group's tabs: before or after that group.
    func moveGroup(_ id: String, beside target: String, after: Bool) {
        guard id != target else { return }
        guard after else {
            moveGroup(id, before: target)
            return
        }
        let ids = tabGroups.map(\.id).filter { $0 != id }
        let next = ids.firstIndex(of: target).flatMap { ids.indices.contains($0 + 1) ? ids[$0 + 1] : nil }
        moveGroup(id, before: next)
    }

    /// A tab dropped on a group's chip: it joins the group at its end and the group opens.
    func dropTab(_ dragged: String, onGroup groupID: String) {
        assign(dragged, to: groupID)
        editGroups { state in state.collapsed.remove(groupID) }
        let after = tabGroups.first { $0.id == groupID }?.tabIDs.last { $0 != dragged }
        if let after, let index = docs.firstIndex(where: { $0.id == after }) {
            moveTab(dragged, before: docs.indices.contains(index + 1) ? docs[index + 1].id : nil)
        }
    }

    /// Dissolves a group the reader made, or takes back every hand move into an automatic one.
    func ungroup(_ groupID: String) {
        editGroups { state in
            state.assigned = state.assigned.filter { $0.value != groupID }
            state.names[groupID] = nil
            state.collapsed.remove(groupID)
            state.order.removeAll { $0 == groupID }
        }
    }

    /// Closes every tab of a group; a dirty one asks first, as a single close does.
    func closeGroup(_ groupID: String) {
        guard let group = tabGroups.first(where: { $0.id == groupID }) else { return }
        for id in group.tabIDs {
            guard let doc = docs.first(where: { $0.id == id }) else { continue }
            guard close(doc) else { return }
        }
    }

    /// One write per action: each assignment to the state publishes and re-runs the bar.
    private func editGroups(_ change: (inout MarkdownTabGroupState) -> Void) {
        var state = configuration.tabGroupState
        change(&state)
        // Hand moves of tabs that are no longer open are dropped, so the saved state cannot grow without end.
        let open = Set(docs.map(\.id))
        state.assigned = state.assigned.filter { open.contains($0.key) }
        if state != configuration.tabGroupState { configuration.tabGroupState = state }
    }
}
