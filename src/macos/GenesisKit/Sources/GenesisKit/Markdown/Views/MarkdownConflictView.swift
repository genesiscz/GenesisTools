//
//  MarkdownConflictView.swift
//  GenesisKit
//
//  What the reader sees when a file changes on disk under unsaved edits: a
//  banner in the document (not a modal, per the editor survey in the vault
//  note Dev/Swift/ExternalFileChangeDetectAndMerge.md) with the four ways out,
//  and a compare sheet that shows mine against disk line by line.
//

import SwiftUI

struct MarkdownConflictBanner: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.genWarning)
            Text(message)
                .lineLimit(2)
            Spacer(minLength: 8)
            if doc.hasDiskChange {
                action("Compare", id: "markdown-conflict-compare", tip: "Show my edits against the version on disk") { model.compareOpen = true }
                action("Merge", id: "markdown-conflict-merge", tip: "Combine both versions; conflicts are marked in the text") { doc.mergeDiskChange() }
                action("Keep mine", id: "markdown-conflict-keep", tip: "Keep my edits; the next save overwrites the disk file") { doc.keepMine() }
                action("Reload", id: "markdown-conflict-reload", destructive: true, tip: "Discard my edits and load the version on disk") { doc.takeDisk() }
            } else if doc.mergeConflicts > 0 {
                // After a merge `text` already is the disk version, so the
                // watcher's `reload` would see nothing new and do nothing.
                action("Reload from disk", id: "markdown-conflict-reload", destructive: true, tip: "Discard the merged text and load the file from disk") {
                    doc.discardDraft()
                }
            } else {
                action("Save", id: "markdown-missing-save") { model.saveSelected() }
                action("Discard", id: "markdown-missing-discard", destructive: true) { doc.discardDraft() }
            }
        }
        .font(GenTypography.body(12))
        .foregroundColor(model.theme.text)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.genWarning.opacity(model.theme.isDark ? 0.12 : 0.18))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.genWarning.opacity(0.4)).frame(height: 1)
        }
        .accessibilityIdentifier("markdown-conflict-banner")
    }

    private var message: String {
        if doc.hasDiskChange {
            return "This file changed on disk while you have unsaved edits. Saving is paused until you choose."
        }
        if doc.mergeConflicts == 0 {
            return "The file is gone from disk. Your unsaved edits are still here; Save writes them back to \(doc.url.path)."
        }
        let n = doc.mergeConflicts
        return "Merged with \(n) conflict\(n == 1 ? "" : "s") to resolve: look for <<<<<<< mine and >>>>>>> on disk, then save."
    }

    private func action(_ title: String, id: String, destructive: Bool = false, tip: String = "", _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title)
                .font(GenTypography.mono(11, weight: .semibold))
                .foregroundColor(destructive ? .genError : model.theme.text)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).fill(model.theme.fill))
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: destructive ? .genError : model.theme.accent, cornerRadius: 6, fillOpacity: 0.12)
        .instantTooltip(tip)
        .accessibilityIdentifier(id)
    }
}

/// Mine against the file on disk. Lines only on disk read as removed from my
/// version; lines only in mine read as added. The same four ways out sit at
/// the bottom, so the decision is taken with the diff in view.
struct MarkdownCompareSheet: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(doc.title): mine ↔ on disk")
                    .font(GenTypography.headline(13))
                Spacer()
                legend("on disk only", color: .genError)
                legend("mine only", color: .genSuccess)
            }
            .padding(12)
            .background(model.theme.chrome)

            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(doc.diskDiff.enumerated()), id: \.offset) { _, line in
                        row(line)
                    }
                }
                .padding(.vertical, 6)
            }
            .background(model.theme.page)

            HStack(spacing: 8) {
                Spacer()
                Button("Close") { model.compareOpen = false }
                    .keyboardShortcut(.cancelAction)
                if doc.hasDiskChange {
                    Button("Reload") { doc.takeDisk(); model.compareOpen = false }
                        .instantTooltip("Discard my edits and load the version on disk")
                    Button("Keep mine") { doc.keepMine(); model.compareOpen = false }
                        .instantTooltip("Keep my edits; the next save overwrites the disk file")
                    Button("Merge") { doc.mergeDiskChange(); model.compareOpen = false }
                        .keyboardShortcut(.defaultAction)
                        .instantTooltip("Combine both versions; conflicts are marked (↩)")
                }
            }
            .padding(12)
            .background(model.theme.chrome)
        }
        .frame(minWidth: 720, idealWidth: 900, minHeight: 420, idealHeight: 640)
        .foregroundColor(model.theme.text)
        .accessibilityIdentifier("markdown-compare-sheet")
    }

    private func legend(_ text: String, color: Color) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(color.opacity(0.35)).frame(width: 10, height: 10)
            Text(text).font(GenTypography.mono(10)).foregroundColor(model.theme.textSecondary)
        }
    }

    @ViewBuilder
    private func row(_ line: TextMerge.DiffLine) -> some View {
        switch line {
        case .equal(let s): diffRow(" ", s, tint: nil)
        case .removed(let s): diffRow("-", s, tint: .genError)
        case .inserted(let s): diffRow("+", s, tint: .genSuccess)
        }
    }

    private func diffRow(_ sign: String, _ text: Substring, tint: Color?) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(sign)
                .foregroundColor(tint ?? model.theme.textMuted)
                .frame(width: 12)
            Text(String(text))
                .foregroundColor(tint == nil ? model.theme.textSecondary : model.theme.text)
            Spacer(minLength: 0)
        }
        .font(GenTypography.mono(11))
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.map { $0.opacity(0.12) } ?? Color.clear)
    }
}
