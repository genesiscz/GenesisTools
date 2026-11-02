//
//  MarkdownFileOps.swift
//  GenesisKit
//
//  Finder's file verbs in the markdown window: the sidebar's and the tabs' menus (GenesisKit `PathMenu`
//  with the configuration's `fileActions` / `folderActions`, see MarkdownDocumentsModel+Paths.swift) and
//  what the open tabs do when their file is renamed, trashed or created. A file with unsaved edits
//  refuses a rename and a trash, so an edit is never written to a path that no longer exists.
//

import AppKit

import SwiftUI

extension MarkdownDocumentsModel {
    /// Why `url` (or, for a folder, a file under it) may not be renamed or trashed now; nil when it may.
    func unsavedReason(_ url: URL) -> String? {
        let path = url.standardizedFileURL.path
        guard let dirty = docs.first(where: { $0.isDirty && ($0.url.path == path || $0.url.path.hasPrefix(path + "/")) }) else {
            return nil
        }
        return "\(dirty.title) has unsaved edits. Save or close it first."
    }

    /// A renamed file's tab reopens at its new path (a renamed folder's tabs too); a trashed file's tab
    /// closes. The selection stays where it was unless it was on a moved file.
    func applyFileChange(_ change: FileChange) {
        switch change {
        case let .renamed(from, to):
            let old = from.standardizedFileURL.path
            let selectedBefore = selected?.id
            var reselect: String?
            // The moved tabs reopen at their new paths; that is no note the user went to, so Back and Forward keep
            // their places and follow the move instead.
            history.rename(old, to: to.standardizedFileURL.path)
            navigatingHistory = true
            defer { navigatingHistory = false }
            for doc in docs where doc.url.path == old || doc.url.path.hasPrefix(old + "/") {
                let moved = URL(fileURLWithPath: to.standardizedFileURL.path + doc.url.path.dropFirst(old.count))
                var groups = configuration.tabGroupState
                if let assigned = groups.assigned.removeValue(forKey: doc.id) {
                    groups.assigned[moved.standardizedFileURL.path] = assigned
                    configuration.tabGroupState = groups
                }
                if doc.id == selectedBefore {
                    reselect = moved.standardizedFileURL.path
                }
                close(doc, confirm: { _ in .discard }, remember: false)
                open([moved])
            }
            if let target = reselect ?? selectedBefore, docs.contains(where: { $0.id == target }) {
                select(target)
            }
        case .trashed(let url):
            let path = url.standardizedFileURL.path
            for doc in docs where doc.url.path == path || doc.url.path.hasPrefix(path + "/") {
                close(doc, confirm: { _ in .discard }, remember: false)
            }
        case .created(let url):
            // A new note is for writing in: it opens as a tab of its own. A new folder only shows in the tree.
            if PathKind.of(url) == .file, FileTree.isReadable(url) {
                open([url])
            }
        case .duplicated:
            break
        }
    }

    /// Every tab but `keep`, each asking first when it has unsaved edits; stops at the first cancel. One action:
    /// one note with Undo, and ⇧⌘T reopens them all (`closeTabs`, UX audit W3).
    func closeOthers(_ keep: MarkdownDocument, confirm: @MainActor (MarkdownDocument) -> UnsavedChoice = MarkdownDocumentsModel.askUnsaved) {
        closeTabs(docs.filter { $0.id != keep.id }, confirm: confirm)
    }

    /// "Close 5 Other Tabs": the menus name how many go.
    var closeOthersTitle: String {
        let others = max(docs.count - 1, 0)
        return others == 1 ? "Close Other Tab" : "Close \(others) Other Tabs"
    }
}

extension MarkdownDocumentsModel {
    /// One open document's verbs: the tab verbs, then the file's own (the configuration's `fileActions`). The tab's
    /// right-click, the page's right-click (`MarkdownPageMenu`) and the menu bar's Document menu all show this list,
    /// so the three never drift apart. A rename or a trash tells the sidebar, which reads its folders again
    /// (`pathHandlers`).
    func documentMenuEntries(for doc: MarkdownDocument) -> [PathMenuEntry] {
        var out: [PathMenuEntry] = [
            .item(PathMenuItem(id: "close-tab", title: "Close Tab", systemImage: "xmark") { [weak self] in self?.close(doc) }),
        ]
        if docs.count > 1 {
            out.append(.item(PathMenuItem(id: "close-others", title: closeOthersTitle, systemImage: "xmark.square") { [weak self] in
                self?.closeOthers(doc)
            }))
        }
        let verbs = PathMenu.entries(
            for: doc.url, kind: .file, actions: pathActions(for: .file), handlers: pathHandlers(for: doc.url, kind: .file)
        )
        if !verbs.isEmpty {
            out.append(.divider(id: "divider-file"))
            out += verbs
        }
        return out
    }
}

/// A tab's right-click menu: `documentMenuEntries`, built when the menu opens.
struct MarkdownTabMenu: View {
    @ObservedObject var doc: MarkdownDocument
    let model: MarkdownDocumentsModel

    var body: some View {
        PathActionsMenu(entries: model.documentMenuEntries(for: doc))
    }
}

/// The page's right-click and the menu bar's Document menu: the selected document's verbs (`documentMenuEntries`).
@MainActor
enum MarkdownPageMenu {
    /// WebKit's own item that reloads the page: it only re-ran the renderer, and was the one item a right-click on
    /// the page offered.
    static let webKitReload = NSUserInterfaceItemIdentifier("WKMenuItemIdentifierReload")

    /// The selected document's verbs in the window that holds `view`, else in the shared viewer window.
    static func entries(for view: NSView?) -> [PathMenuEntry] {
        let controller = view?.window?.windowController as? MarkdownDocumentWindowController
            ?? MarkdownDocumentWindowController.shared
        guard let doc = controller.model.selected else { return [] }
        return controller.model.documentMenuEntries(for: doc)
    }

    /// WebKit's page menu with the document's verbs: its Reload goes, its selection and link items (Copy, Look Up,
    /// Open Link) stay above the verbs. A page outside the viewer (no document) keeps WebKit's menu as it is.
    static func adapt(_ menu: NSMenu, entries: [PathMenuEntry]) {
        guard !entries.isEmpty else { return }
        for item in menu.items where item.identifier == webKitReload {
            menu.removeItem(item)
        }
        while menu.items.last?.isSeparatorItem == true {
            menu.removeItem(at: menu.items.count - 1)
        }
        if !menu.items.isEmpty {
            menu.addItem(.separator())
        }
        let built = PathMenu.nsMenu(entries)
        for item in built.items {
            built.removeItem(item)
            menu.addItem(item)
        }
    }
}

/// The menu bar's Document menu: rebuilt from the selected document each time it opens.
@MainActor
final class MarkdownDocumentMenu: NSObject, NSMenuDelegate {
    static let shared = MarkdownDocumentMenu()

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let entries = MarkdownPageMenu.entries(for: NSApp.keyWindow?.contentView)
        if entries.isEmpty {
            menu.addItem(withTitle: "No document open", action: nil, keyEquivalent: "").isEnabled = false
            return
        }
        let built = PathMenu.nsMenu(entries)
        for item in built.items {
            built.removeItem(item)
            menu.addItem(item)
        }
    }
}

extension Notification.Name {
    /// A tab menu's file verb changed the disk: that window's sidebar reads its folders again.
    static let markdownTabFileChanged = Notification.Name("genesis.markdown.tabFileChanged")
}
