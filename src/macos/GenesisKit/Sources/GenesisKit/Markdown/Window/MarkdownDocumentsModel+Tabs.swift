//
//  MarkdownDocumentsModel+Tabs.swift
//  GenesisKit
//
//  Preview tabs, the way an editor's file explorer has them: a single click shows the file in one
//  italic tab that the next single click reuses, so browsing a folder does not leave a tab per file.
//  The tab is kept (a normal tab) once the reader edits it, double-clicks it, opens the same file on
//  purpose, or picks Keep Tab. `GenesisKitMarkdownConfiguration.previewTabs` off: every open is a kept tab.
//

import Combine
import Foundation

extension MarkdownDocumentsModel {
    /// Shows `url` in the preview tab: an open file is only selected, a new one takes the preview
    /// tab's place (or a new tab at the end when there is none, or it has unsaved edits).
    func openPreview(_ url: URL) {
        guard configuration.previewTabs else {
            open([url])
            return
        }
        let std = url.standardizedFileURL
        if docs.contains(where: { $0.url == std }) {
            // Already a tab, preview or kept: a second single click must not keep it.
            select(std.path)
            return
        }
        open([std], asPreview: true)
    }

    /// The preview tab, with the configuration's switch applied: nil when previews are off.
    var previewTab: MarkdownDocument? {
        guard configuration.previewTabs, let id = previewTabId else { return nil }
        return docs.first { $0.id == id }
    }

    func isPreview(_ doc: MarkdownDocument) -> Bool {
        configuration.previewTabs && previewTabId == doc.id
    }

    /// The preview tab becomes a normal tab. Nothing for any other tab.
    func keep(_ doc: MarkdownDocument) {
        keep(doc.id)
    }

    func keep(_ id: String) {
        guard previewTabId == id else { return }
        previewTabId = nil
        previewEditWatch = nil
    }

    /// `doc` is the preview tab now, until its first edit.
    func markPreview(_ doc: MarkdownDocument) {
        previewTabId = doc.id
        // `draft` is published before it changes; the first value is the current one, and an edit is any
        // later value that is not nil. A watch on `isDirty` would let an undone edit fall back to preview.
        previewEditWatch = doc.$draft
            .dropFirst()
            .first { $0 != nil }
            .sink { [weak self, weak doc] _ in
                guard let self, let doc else { return }
                keep(doc)
            }
    }
}
