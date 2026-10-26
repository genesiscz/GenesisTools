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

/// A tab's right-click menu: the tab verbs, then the file's own (the configuration's `fileActions`).
/// A rename or a trash there tells the sidebar, which reads its folders again (`pathHandlers`).
struct MarkdownTabMenu: View {
    @ObservedObject var doc: MarkdownDocument
    let model: MarkdownDocumentsModel

    var body: some View {
        Button("Close Tab") { model.close(doc) }
        Button(model.closeOthersTitle) { model.closeOthers(doc) }
            .disabled(model.docs.count < 2)
        Divider()
        PathActionsMenu(url: doc.url, kind: .file, actions: model.pathActions(for: .file), handlers: model.pathHandlers(for: doc.url, kind: .file))
    }
}

extension Notification.Name {
    /// A tab menu's file verb changed the disk: that window's sidebar reads its folders again.
    static let markdownTabFileChanged = Notification.Name("genesis.markdown.tabFileChanged")
}
