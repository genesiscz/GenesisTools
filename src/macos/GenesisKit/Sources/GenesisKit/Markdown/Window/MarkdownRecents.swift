//
//  MarkdownRecents.swift
//  GenesisKit
//
//  File → Open Recent: the files opened lately, newest first. One still open in a tab carries a check mark, a closed
//  one says when it was closed ("closed 3h ago"), a file gone from disk cannot be picked. Kept in the window's
//  defaults, at most 40 entries.
//

import AppKit

struct MarkdownRecent: Codable, Equatable {
    var path: String
    var opened: Date
    /// When its tab was closed; nil while it is open (a tab the app reopens at launch stays open).
    var closed: Date?
}

struct MarkdownRecents: Equatable {
    static let limit = 40
    private(set) var entries: [MarkdownRecent] = []

    init(entries: [MarkdownRecent] = []) {
        self.entries = entries
    }

    mutating func opened(_ url: URL, at now: Date = Date()) {
        let path = url.standardizedFileURL.path
        entries.removeAll { $0.path == path }
        entries.insert(MarkdownRecent(path: path, opened: now, closed: nil), at: 0)
        if entries.count > Self.limit { entries.removeLast(entries.count - Self.limit) }
    }

    mutating func closed(_ url: URL, at now: Date = Date()) {
        let path = url.standardizedFileURL.path
        guard let index = entries.firstIndex(where: { $0.path == path }) else { return }
        entries[index].closed = now
    }

    mutating func clear(keeping open: Set<String>) {
        entries.removeAll { !open.contains($0.path) }
    }

    /// The note beside an entry: "open", "closed 3h ago".
    static func note(for entry: MarkdownRecent, isOpen: Bool, now: Date = Date()) -> String {
        if isOpen { return "open" }
        guard let closed = entry.closed else { return "not open" }
        return "closed " + (LiveTimeFormat.text(.ago, closed, now: now) ?? "")
    }
}

/// The Open Recent submenu, built each time it opens, so the ages and the open marks are current.
@MainActor
final class MarkdownRecentMenu: NSObject, NSMenuDelegate {
    static let shared = MarkdownRecentMenu()

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let model = MarkdownDocumentWindowController.shared.model
        let open = Set(model.docs.map(\.id))
        let entries = model.recents.entries
        if entries.isEmpty {
            menu.addItem(withTitle: "No recent files", action: nil, keyEquivalent: "").isEnabled = false
            return
        }
        let now = Date()
        for entry in entries {
            let isOpen = open.contains(entry.path)
            let exists = FileManager.default.fileExists(atPath: entry.path)
            let name = (entry.path as NSString).lastPathComponent
            let item = NSMenuItem(title: name, action: exists ? #selector(openRecent(_:)) : nil, keyEquivalent: "")
            item.target = self
            item.representedObject = entry.path
            item.state = isOpen ? .on : .off
            item.isEnabled = exists
            item.toolTip = entry.path
            let note = exists ? MarkdownRecents.note(for: entry, isOpen: isOpen, now: now) : "missing"
            let title = NSMutableAttributedString(string: name, attributes: [.font: NSFont.menuFont(ofSize: 0)])
            title.append(NSAttributedString(string: "   \(note)", attributes: [
                .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
                .foregroundColor: isOpen ? NSColor.secondaryLabelColor : NSColor.systemOrange,
            ]))
            item.attributedTitle = title
            if !isOpen, exists {
                item.image = NSImage(systemSymbolName: "clock.arrow.circlepath", accessibilityDescription: "closed")
            }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let clear = menu.addItem(withTitle: "Clear Closed", action: #selector(clearClosed(_:)), keyEquivalent: "")
        clear.target = self
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        MarkdownDocumentWindowController.shared.show(paths: [path], focus: true)
    }

    @objc func clearClosed(_ sender: Any?) {
        let model = MarkdownDocumentWindowController.shared.model
        model.clearRecents()
    }
}
