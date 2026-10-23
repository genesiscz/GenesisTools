//
//  MarkdownTabGrouping.swift
//  GenesisKit
//
//  Groups the open tabs into named, collapsible groups (Martin, 2026-10-23: 72 tabs wrapped into nine rows). The engine
//  is pure: tabs, a rule and the reader's own edits in, ordered groups out. Both hosts (GenesisTools' markdown face and
//  Genesis Markdown.app) get it through `MarkdownDocumentsView`, and a host may call it for its own lists.
//

import Foundation

/// How tabs fall into groups by themselves. The reader's own moves and names win over every rule.
public enum MarkdownTabGroupRule: String, CaseIterable, Codable, Sendable {
    /// One flat row of tabs.
    case off
    /// The top folder under the folder every open tab shares; a group past `splitAbove` tabs splits by its next folder.
    case smart
    /// The folder each file sits in.
    case folder
    /// The date a note's name starts with (`2026-10-23-…`): today, yesterday, this week, this month, earlier, undated.
    case day
    /// The file's kind: notes, data, logs, diffs.
    case kind

    public var title: String {
        switch self {
        case .off: return "Off"
        case .smart: return "Project"
        case .folder: return "Folder"
        case .day: return "Date in Name"
        case .kind: return "Kind"
        }
    }
}

/// One open tab as the engine sees it.
public struct MarkdownTabGroupItem: Equatable, Sendable {
    public var id: String
    public var path: String
    public var title: String

    public init(id: String, path: String, title: String) {
        self.id = id
        self.path = path
        self.title = title
    }
}

/// A group of tabs, in the order the tab bar shows them.
public struct MarkdownTabGroup: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    /// Where the group is, for a title two folders share ("Notes" in two projects) and for the chip's tooltip.
    public var detail: String?
    public var tabIDs: [String]
    /// Made by the reader (a new group, or tabs moved into it); never merged into "Other".
    public var manual: Bool
}

/// What the reader changed in place: group order, collapsed groups, names, and tabs moved by hand.
public struct MarkdownTabGroupState: Codable, Equatable, Sendable {
    public var order: [String] = []
    public var collapsed: Set<String> = []
    public var names: [String: String] = [:]
    /// Tab id to group id. A tab moved into a group stays there while that group exists under the current rule, or
    /// always when the group is one the reader made (`manual:` ids).
    public var assigned: [String: String] = [:]

    public init() {}
}

public enum MarkdownTabGrouping {
    public static let otherID = "other"
    public static let manualPrefix = "manual:"

    /// The tabs as ordered groups. Empty for `.off`, which the tab bar shows as one flat row.
    public static func groups(
        _ items: [MarkdownTabGroupItem], rule: MarkdownTabGroupRule, state: MarkdownTabGroupState,
        minimumSize: Int = 2, splitAbove: Int = 12, now: Date = Date(), calendar: Calendar = .current
    ) -> [MarkdownTabGroup] {
        guard rule != .off, !items.isEmpty else { return [] }
        let automatic = keys(items, rule: rule, splitAbove: splitAbove, minimumSize: minimumSize, now: now,
                             calendar: calendar)
        let automaticIDs = Set(automatic.values.map(\.id))
        var members: [String: [String]] = [:]
        var info: [String: (title: String, detail: String?, manual: Bool)] = [:]
        var firstSeen: [String] = []
        for item in items {
            let key: (id: String, title: String, detail: String?, manual: Bool)
            if let wanted = state.assigned[item.id],
               wanted.hasPrefix(manualPrefix) || automaticIDs.contains(wanted) || wanted == otherID {
                let known = automatic.values.first { $0.id == wanted }
                key = (wanted, known?.title ?? (wanted == otherID ? "Other" : "Group"), known?.detail,
                       wanted.hasPrefix(manualPrefix))
            } else {
                let auto = automatic[item.id] ?? (otherID, "Other", nil)
                key = (auto.id, auto.title, auto.detail, false)
            }
            if members[key.id] == nil { firstSeen.append(key.id) }
            members[key.id, default: []].append(item.id)
            info[key.id] = (key.title, key.detail, key.manual || (info[key.id]?.manual ?? false))
        }
        // A one-tab automatic group is noise in the bar: it joins "Other". The reader's own groups always stay.
        for id in firstSeen where id != otherID {
            guard let tabs = members[id], tabs.count < minimumSize, info[id]?.manual == false,
                  state.names[id] == nil, !tabs.contains(where: { state.assigned[$0] == id }) else { continue }
            members[otherID, default: []].append(contentsOf: tabs)
            members[id] = nil
            if !firstSeen.contains(otherID) { firstSeen.append(otherID) }
            info[otherID] = ("Other", nil, false)
        }
        let order = Dictionary(state.order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = firstSeen.filter { members[$0] != nil }.enumerated().sorted { left, right in
            func rank(_ id: String, _ index: Int) -> (Int, Int) {
                if let placed = order[id] { return (0, placed) }
                return id == otherID ? (2, 0) : (1, index)
            }
            return rank(left.element, left.offset) < rank(right.element, right.offset)
        }.map(\.element)
        let position = Dictionary(items.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.map { id in
            MarkdownTabGroup(
                id: id, title: state.names[id] ?? info[id]?.title ?? "Group", detail: info[id]?.detail,
                tabIDs: (members[id] ?? []).sorted { (position[$0] ?? 0) < (position[$1] ?? 0) },
                manual: info[id]?.manual ?? false)
        }
    }

    /// The order Next Tab and Previous Tab walk: the groups' order, tabs in a collapsed group skipped unless selected.
    public static func visualOrder(_ groups: [MarkdownTabGroup], collapsed: Set<String>, selected: String?) -> [String] {
        groups.flatMap { group in
            collapsed.contains(group.id) ? group.tabIDs.filter { $0 == selected } : group.tabIDs
        }
    }

    // MARK: Automatic keys

    typealias Key = (id: String, title: String, detail: String?)

    static func keys(
        _ items: [MarkdownTabGroupItem], rule: MarkdownTabGroupRule, splitAbove: Int, minimumSize: Int = 2, now: Date,
        calendar: Calendar
    ) -> [String: Key] {
        switch rule {
        case .off: return [:]
        case .folder:
            return Dictionary(items.map { item in
                let folder = (item.path as NSString).deletingLastPathComponent
                return (item.id, ("dir:" + folder, (folder as NSString).lastPathComponent,
                                  parentName(folder)))
            }, uniquingKeysWith: { first, _ in first })
        case .day:
            return Dictionary(items.map { ($0.id, dayKey($0.title, now: now, calendar: calendar)) },
                              uniquingKeysWith: { first, _ in first })
        case .kind:
            return Dictionary(items.map { ($0.id, kindKey($0.path)) }, uniquingKeysWith: { first, _ in first })
        case .smart:
            return smartKeys(items, splitAbove: splitAbove, minimumSize: minimumSize)
        }
    }

    /// Folders below the folder every tab shares: the first level names the group; a group larger than `splitAbove`
    /// whose tabs sit in different folders one level deeper splits by that level, up to three times.
    static func smartKeys(_ items: [MarkdownTabGroupItem], splitAbove: Int, minimumSize: Int = 2) -> [String: Key] {
        let folders = items.map { item in
            ((item.path as NSString).deletingLastPathComponent as NSString).pathComponents
        }
        var common = folders.first ?? []
        for components in folders.dropFirst() {
            common = Array(zip(common, components).prefix { $0 == $1 }.map(\.0))
        }
        // Depth of the component that names each tab's group; tabs right in the common folder stay at it.
        var depth = Array(repeating: common.count, count: items.count)
        func key(_ index: Int) -> String {
            let components = folders[index]
            return NSString.path(withComponents: Array(components.prefix(min(depth[index] + 1, components.count))))
        }
        // A big group goes one level down when that level divides it into at least two real groups, or when the
        // level holds one folder only (every note under `Vault/Notes/…`), which is passed through. A split into
        // single tabs is refused: it would send the whole group to "Other" (72 vault notes did, 2026-10-23). A tab
        // that sits higher than the level stays where it is. Bounded, as a path is.
        for _ in 0 ..< 8 {
            var byKey: [String: [Int]] = [:]
            for index in items.indices { byKey[key(index), default: []].append(index) }
            var moved = false
            for (_, indexes) in byKey where indexes.count > splitAbove {
                let deeper = indexes.filter { folders[$0].count > depth[$0] + 1 }
                guard !deeper.isEmpty else { continue }
                var sizes: [String: Int] = [:]
                for index in deeper { sizes[folders[index][depth[index] + 1], default: 0] += 1 }
                // A subfolder with tabs enough for a group of its own moves down; single tabs stay in the parent group.
                let real = Set(sizes.filter { $0.value >= max(2, minimumSize) }.keys)
                guard sizes.count == 1 || !real.isEmpty else { continue }
                for index in deeper where sizes.count == 1 || real.contains(folders[index][depth[index] + 1]) {
                    depth[index] += 1
                }
                moved = true
            }
            if !moved { break }
        }
        var result: [String: Key] = [:]
        for (index, item) in items.enumerated() {
            let path = key(index)
            let components = (path as NSString).pathComponents
            let title = components.last ?? path
            let detail = components.count > 1 && depth[index] > common.count ? components[components.count - 2] : nil
            result[item.id] = ("dir:" + path, title, detail)
        }
        return result
    }

    static func dayKey(_ title: String, now: Date, calendar: Calendar) -> Key {
        // The date in the name is a calendar day in the reader's calendar, not an instant in some other zone.
        let parts = title.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard title.count >= 10, title.prefix(10).filter({ $0 == "-" }).count == 2, parts.count == 3,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else {
            return ("day:none", "Undated", nil)
        }
        let today = calendar.startOfDay(for: now)
        let day = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        switch days {
        case ...0: return ("day:today", "Today", nil)
        case 1: return ("day:yesterday", "Yesterday", nil)
        case 2 ..< 7: return ("day:week", "This Week", nil)
        case 7 ..< 31: return ("day:month", "This Month", nil)
        default: return ("day:earlier", "Earlier", nil)
        }
    }

    static func kindKey(_ path: String) -> Key {
        switch (path as NSString).pathExtension.lowercased() {
        case "md", "markdown", "mdx", "txt": return ("kind:notes", "Notes", nil)
        case "json", "jsonl", "yaml", "yml", "toml", "plist": return ("kind:data", "Data", nil)
        case "log": return ("kind:logs", "Logs", nil)
        case "diff", "patch": return ("kind:diffs", "Diffs", nil)
        case "": return ("kind:other", "No Extension", nil)
        case let ext: return ("kind:" + ext, ext.uppercased(), nil)
        }
    }

    private static func parentName(_ folder: String) -> String? {
        let parent = (folder as NSString).deletingLastPathComponent
        let name = (parent as NSString).lastPathComponent
        return name.isEmpty || name == "/" ? nil : name
    }

}
