//
//  MarkdownDocumentToolbar.swift
//  GenesisKit
//
//  The control strip of the standalone `genesis open` window. It carries the
//  controls the vault reading pane (KnowledgeView) already had — source view,
//  the three-engine renderer cycle — plus the file actions a standalone viewer
//  needs and the vault pane does not: reveal in Finder, open in Obsidian, open
//  in the default editor, copy path, and share the note when the dev dashboard
//  is answering on localhost.
//

import AppKit
import SwiftUI

/// Pure link/path logic behind the toolbar buttons, kept out of the view so it
/// can be tested without a window.
enum MarkdownDocumentActions {
    /// Deep link that opens `url` in Obsidian.
    ///
    /// Inside a known vault we address the note the way Obsidian's own "copy
    /// link" does (`vault` + vault-relative file, no extension), because that
    /// form works even when several vaults hold a file of the same name.
    /// Outside it we fall back to the absolute-path form, which makes Obsidian
    /// pick whichever vault contains the file.
    static func obsidianURL(for url: URL, vaultRoot: String?, vaultName: String?) -> URL? {
        var comps = URLComponents(string: "obsidian://open")
        let path = url.standardizedFileURL.path

        if let vaultName, !vaultName.isEmpty,
           let relative = vaultRelativePath(path, vaultRoot: vaultRoot) {
            comps?.queryItems = [
                URLQueryItem(name: "vault", value: vaultName),
                URLQueryItem(name: "file", value: relative),
            ]
        } else {
            comps?.queryItems = [URLQueryItem(name: "path", value: path)]
        }
        return comps?.url
    }

    /// `path` relative to `vaultRoot` with the `.md` suffix dropped, or nil when
    /// the file lives outside the vault.
    static func vaultRelativePath(_ path: String, vaultRoot: String?) -> String? {
        guard let vaultRoot, !vaultRoot.isEmpty else { return nil }
        var root = (vaultRoot as NSString).expandingTildeInPath
        if !root.hasSuffix("/") { root += "/" }
        guard path.hasPrefix(root) else { return nil }

        let relative = String(path.dropFirst(root.count))
        guard !relative.isEmpty else { return nil }
        return relative.hasSuffix(".md") ? String(relative.dropLast(3)) : relative
    }

    /// What VoiceOver says for an icon button: its tooltip without the
    /// shortcut, "Save (⌘S)" → "Save".
    static func spokenLabel(_ tooltip: String) -> String {
        guard let paren = tooltip.range(of: " (") else { return tooltip }
        return String(tooltip[..<paren.lowerBound])
    }

    /// The vault name Obsidian knows this vault by. Config wins; otherwise the
    /// vault directory's own name, which is what Obsidian defaults to.
    static func vaultName(configured: String?, vaultRoot: String?) -> String? {
        if let configured, !configured.isEmpty { return configured }
        guard let vaultRoot, !vaultRoot.isEmpty else { return nil }
        let name = URL(fileURLWithPath: (vaultRoot as NSString).expandingTildeInPath).lastPathComponent
        return name.isEmpty ? nil : name
    }
}

struct MarkdownDocumentToolbar: View {
    /// This row sits right under the title bar and belongs to it: the window's
    /// `.titlebarZone(below:)` takes this much of it (Window/WindowTitlebar.swift).
    static let height: CGFloat = 40

    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    @StateObject private var share = MarkdownShareModel()
    @ObservedObject private var gitConfiguration = GenesisKitMarkdownConfiguration.shared
    @ObservedObject private var repos = GitRepos.shared
    /// Observed so a key changed in Keyboard Shortcuts redraws these tooltips.
    @ObservedObject private var keymap = MarkdownKeymap.shared

    /// Read, Split, Source, and Changes while git is on and the file is in a repository (or Changes is open).
    private var modes: [MarkdownViewMode] {
        let changes = model.mode == .changes || (gitConfiguration.git && repos.model(for: doc.folder) != nil)
        return MarkdownViewMode.allCases.filter { $0 != .changes || changes }
    }

    var body: some View {
        let _ = RenderProbe.hit("md.toolbar")
        HStack(spacing: 10) {
            // The buttons with their names while the row has room for them, else icons only
            // (`GenesisKitMarkdownConfiguration.toolbarLabels`). Their priority puts them ahead of the
            // texts after them, which truncate first.
            ViewThatFits(in: .horizontal) {
                ForEach(model.configuration.toolbarLabels.candidates, id: \.self) { labels in
                    controls(labels: labels)
                }
            }
            .layoutPriority(1)
            // The window runs every other key (`MarkdownKeymap.registerWindowCommands`); these two need the share
            // model's error line.
            .keymapAction("markdown.file.pdf", in: MarkdownKeymap.shared, perform: exportPDF)
            .keymapAction("markdown.file.print", in: MarkdownKeymap.shared, perform: printDocument)

            Spacer(minLength: 8)

            if let error = share.error ?? model.exportError {
                Text(error)
                    .font(GenTypography.mono(9.5))
                    .foregroundColor(model.theme.accent)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .instantTooltip(error)
                    .accessibilityIdentifier("markdown-export-error")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        // The strip belongs to the title bar: its empty part is the window's
        // `.titlebarZone(below:)` (Window/WindowTitlebar.swift), which zooms on a double-click and
        // drags, and a button keeps its clicks. So the fill takes none.
        .background { model.theme.chrome.allowsHitTesting(false) }
        .overlay(alignment: .bottom) {
            Rectangle().fill(model.theme.border).frame(height: 1)
        }
        .task {
            await share.refresh()

            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(8))

                if Task.isCancelled {
                    break
                }

                await share.refresh()
            }
        }
    }

    /// The row of button groups. `labels`: each button shows its short name beside its icon.
    private func controls(labels: Bool) -> some View {
        HStack(spacing: 8) {
            // The two sidebar toggles sit at the very left, above the panes
            // they open, so it reads as "this opens the thing under it".
            MarkdownToolbarGroup(theme: model.theme) {
                toolButton(
                    "sidebar.left", label: "Files",
                    tint: model.showFiles ? model.theme.accent : nil,
                    tooltip: keymap.hint("Files", "markdown.view.files"), id: "markdown-files-toggle", labels: labels,
                    action: toggleFiles
                )
                groupDivider
                toolButton(
                    "list.bullet.indent", label: "Outline",
                    tint: model.showOutline ? model.theme.accent : nil,
                    tooltip: keymap.hint("Outline", "markdown.view.outline"), id: "markdown-outline-toggle", labels: labels,
                    action: toggleOutline
                )
                if modes.contains(.changes) {
                    groupDivider
                    toolButton(
                        "arrow.triangle.branch", label: "Git",
                        tint: model.showGit ? model.theme.accent : nil,
                        tooltip: "Git: this file's history and the repository", id: "markdown-git-toggle", labels: labels,
                        action: { withAnimation(GenAnimation.quick) { model.showGit.toggle() } }
                    )
                }
            }

            // No identifier on the picker itself: SwiftUI pushes a
            // container's identifier onto its children, so it would clobber
            // the three per-mode ids (vault note
            // Dev/Swift/AccessibilityIdentifierPropagationClobbersChildren).
            modePicker(labels: labels)

            MarkdownToolbarGroup(theme: model.theme) {
                toolButton(
                    "square.and.arrow.down", label: "Save",
                    tint: doc.isDirty ? model.theme.accent : model.theme.textMuted,
                    tooltip: keymap.hint("Save", "markdown.file.save")
                        + (doc.hasDiskChange ? " — resolve the change on disk first" : ""),
                    id: "markdown-save", labels: labels
                ) {
                    model.saveSelected()
                }
                groupDivider
                toolButton(
                    model.floating ? "pin.fill" : "pin", label: "On Top",
                    tint: model.floating ? model.theme.accent : nil,
                    tooltip: model.floating ? "Keep on top: on" : "Keep on top: off",
                    id: "markdown-float-toggle", labels: labels
                ) {
                    model.floating.toggle()
                }
                if model.mode.showsPreview {
                    groupDivider
                    rendererButton
                }
            }

            MarkdownToolbarGroup(theme: model.theme) {
                toolButton(
                    "arrow.triangle.2.circlepath", label: "Reload",
                    tooltip: keymap.hint("Reload from disk", "markdown.file.reload"), id: "markdown-reload", labels: labels
                ) {
                    doc.reload()
                }
                groupDivider
                toolButton("folder", label: "Finder", tooltip: keymap.hint("Reveal in Finder", "markdown.file.reveal"), id: "markdown-reveal", labels: labels, action: revealInFinder)
                groupDivider
                toolButton("square.and.pencil", label: "Editor", tooltip: "Open in the default editor", id: "markdown-open-external", labels: labels) {
                    NSWorkspace.shared.open(doc.url)
                }
                groupDivider
                toolButton("book.closed", label: "Obsidian", tooltip: "Open in Obsidian", id: "markdown-open-obsidian", labels: labels) {
                    openInObsidian()
                }
                groupDivider
                toolButton("doc.on.doc", label: "Copy Path", tooltip: "Copy the file path", id: "markdown-copy-path", labels: labels) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(doc.url.path, forType: .string)
                }
            }

            // Smaller, the size, bigger: one control, so the percentage reads as the size it sets rather
            // than as a third button.
            MarkdownToolbarGroup(theme: model.theme) {
                toolButton("textformat.size.smaller", label: "Smaller", tooltip: keymap.hint("Smaller", "markdown.view.smaller"), id: "markdown-zoom-out", labels: false) {
                    model.zoomStep(-1)
                }
                groupDivider
                Button {
                    model.zoomReset()
                } label: {
                    Text(MarkdownZoom.percent(model.zoom))
                        .font(GenTypography.mono(9, weight: .medium))
                        .foregroundColor(model.zoom == MarkdownZoom.base ? model.theme.textSecondary : model.theme.accent)
                        .frame(minWidth: 34, minHeight: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(keymap.hint("Reset the reading size", "markdown.view.actualSize"))
                .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
                .accessibilityLabel("Reading size \(MarkdownZoom.percent(model.zoom)), reset")
                .accessibilityIdentifier("markdown-zoom-reset")
                groupDivider
                toolButton("textformat.size.larger", label: "Bigger", tooltip: keymap.hint("Bigger", "markdown.view.bigger"), id: "markdown-zoom-in", labels: false) {
                    model.zoomStep(1)
                }
            }

            MarkdownToolbarGroup(theme: model.theme) {
                toolButton(
                    "arrow.down.doc", label: "PDF",
                    tint: model.canExport ? nil : model.theme.textMuted,
                    tooltip: keymap.hint("Save as PDF", "markdown.file.pdf"), id: "markdown-export-pdf", labels: labels,
                    action: exportPDF
                )
                groupDivider
                toolButton(
                    "printer", label: "Print",
                    tint: model.canExport ? nil : model.theme.textMuted,
                    tooltip: keymap.hint("Print", "markdown.file.print"), id: "markdown-print", labels: labels,
                    action: printDocument
                )
                if share.available {
                    groupDivider
                    toolButton(
                        "square.and.arrow.up", label: "Share",
                        tint: share.busy ? model.theme.textMuted : nil,
                        tooltip: "Share on the dev dashboard", id: "markdown-share", labels: labels
                    ) {
                        let note = doc.url
                        model.exportError = nil
                        Task { await share.share(note: note) }
                    }
                    .disabled(share.busy)
                }
            }
        }
        // Each candidate row at its own width: `ViewThatFits` compares it with the room there is.
        .fixedSize()
    }

    private func toggleFiles() {
        withAnimation(GenAnimation.quick) { model.showFiles.toggle() }
    }

    private func toggleOutline() {
        withAnimation(GenAnimation.quick) { model.showOutline.toggle() }
    }

    private func revealInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([doc.url])
    }

    private func exportPDF() {
        share.error = nil
        model.exportError = nil
        MarkdownExport.savePDF(from: model.webProxy, note: doc.url, in: NSApp.keyWindow) { model.exportError = $0 }
    }

    private func printDocument() {
        share.error = nil
        model.exportError = nil
        model.webProxy.printDocument(title: doc.title, in: NSApp.keyWindow) { model.exportError = $0 }
    }

    /// The reading engine, cycled by a click. Always named: the name is the state.
    private var rendererButton: some View {
        Button {
            model.rendererRaw = model.renderer.next.rawValue
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.renderer.icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(model.renderer.label)
                    .font(GenTypography.mono(9, weight: .medium))
            }
            .foregroundColor(model.theme.accent)
            .padding(.horizontal, 6)
            .frame(minHeight: 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Renderer: \(model.renderer.detail) — click to cycle")
        .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
        .accessibilityIdentifier("markdown-renderer-toggle")
    }

    /// Reading view · side by side · source, the way an editor with a preview
    /// pane offers them. The active segment carries the accent. Its fill takes
    /// no clicks, like every group's (`MarkdownToolbarGroup`).
    private func modePicker(labels: Bool) -> some View {
        HStack(spacing: 1) {
            ForEach(modes, id: \.self) { mode in
                let active = model.mode == mode
                Button {
                    model.setMode(mode)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: mode.icon)
                            .font(.system(size: 11, weight: .semibold))
                        if labels {
                            Text(mode.shortLabel)
                                .font(.system(size: 11, weight: .medium))
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .foregroundColor(active ? model.theme.accent : model.theme.textSecondary)
                    .padding(.horizontal, labels ? 6 : 0)
                    .frame(minWidth: 26, minHeight: 18)
                    .background(active ? model.theme.accent.opacity(0.14) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(mode.label(in: keymap))
                .accessibilityLabel(MarkdownDocumentActions.spokenLabel(mode.label(in: keymap)))
                .accessibilityAddTraits(active ? .isSelected : [])
                .accessibilityIdentifier("markdown-mode-\(mode.rawValue)")
            }
        }
        .padding(2)
        .background {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(model.theme.fill)
                .allowsHitTesting(false)
        }
    }

    /// The hairline between two segments of a group. It takes no clicks: they reach the title bar.
    private var groupDivider: some View {
        Rectangle()
            .fill(model.theme.text.opacity(0.14))
            .frame(width: 1, height: 12)
            .padding(.horizontal, 1)
            .allowsHitTesting(false)
    }

    /// One button of a group: its icon, and its short name when `labels` is on.
    private func toolButton(
        _ symbol: String,
        label: String,
        tint: Color? = nil,
        tooltip: String,
        id: String,
        labels: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .semibold))
                if labels {
                    Text(label)
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .foregroundColor(tint ?? model.theme.textSecondary)
            .padding(.horizontal, labels ? 6 : 0)
            .frame(minWidth: 22, minHeight: 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip)
        .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
        // The tooltip is a hover overlay, not an accessibility label, and the
        // identifier is for automation; VoiceOver needs the action's name.
        .accessibilityLabel(MarkdownDocumentActions.spokenLabel(tooltip))
        .accessibilityIdentifier(id)
    }

    private func openInObsidian() {
        let vaultRoot = GenesisKit.host?.markdownVaultRoot
        let configured = GenesisKit.host?.markdownConfiguredVault
        guard let url = MarkdownDocumentActions.obsidianURL(
            for: doc.url,
            vaultRoot: vaultRoot,
            vaultName: MarkdownDocumentActions.vaultName(configured: configured, vaultRoot: vaultRoot)
        ) else { return }
        NSWorkspace.shared.open(url)
    }
}
/// Buttons that belong together, drawn as one segmented capsule like the mode picker: a shared fill, and
/// a hairline between segments (`groupDivider`). The fill takes no clicks: the toolbar row is part of the
/// title bar (`.titlebarZone(below:)`, Window/WindowTitlebar.swift), and every point of it that is not a
/// button must still drag the window and zoom it on a double-click.
private struct MarkdownToolbarGroup<Content: View>: View {
    let theme: MarkdownTheme
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 0) {
            content
        }
        .padding(2)
        .background {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(theme.fill)
                .allowsHitTesting(false)
        }
    }
}

extension MarkdownToolbarLabels {
    /// The rows the toolbar offers `ViewThatFits`, widest first: `true` = with labels. `.whenRoom` tries
    /// the labels, then falls back to icons; the other two force one.
    var candidates: [Bool] {
        switch self {
        case .always: [true]
        case .never: [false]
        case .whenRoom: [true, false]
        }
    }
}

extension MarkdownViewMode {
    /// The mode's name beside its icon in the toolbar.
    var shortLabel: String {
        switch self {
        case .preview: "Read"
        case .split: "Split"
        case .source: "Source"
        case .changes: "Changes"
        }
    }
}
