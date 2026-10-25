//
//  MarkdownDocumentsView.swift
//  GenesisKit
//
//  The window's screen: the toolbar, the tab row, the sidebar and the document panes.
//

import AppKit
import Combine
import SwiftUI
import os
import UniformTypeIdentifiers

struct MarkdownDocumentsView: View {
    @ObservedObject var model: MarkdownDocumentsModel

    /// The empty state's "Open…": Markdown and plain-text files, several at once.
    @MainActor
    static func chooseFiles(into model: MarkdownDocumentsModel) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [
            UTType(filenameExtension: "md"), UTType(filenameExtension: "markdown"), .plainText,
        ].compactMap { $0 }
        if panel.runModal() == .OK { model.open(panel.urls) }
    }

    @State private var filesDragStart: Double?
    /// A Finder drag is over the window: the content gets an accent outline (UX audit W10).
    @State private var dropTargeted = false

    /// The sidebar's right edge: drag to resize, double-click for the standard width, arrows when focused.
    private var filesDivider: some View {
        MarkdownSplitDivider(
            line: NSColor(model.theme.border),
            accent: NSColor(model.theme.accent),
            onBegin: { filesDragStart = model.filesWidth },
            onDrag: { dx in
                model.filesWidth = MarkdownSidebarWidth.clamped((filesDragStart ?? model.filesWidth) + dx)
            },
            onEnd: { filesDragStart = nil },
            onReset: { model.filesWidth = MarkdownSidebarWidth.standard },
            onStep: { direction in
                model.filesWidth = MarkdownSidebarWidth.clamped(
                    model.filesWidth + Double(direction) * MarkdownSidebarWidth.keyboardStep
                )
            },
            label: "File sidebar divider",
            valueText: "\(Int(model.filesWidth)) points wide"
        )
        .frame(width: 6)
        .accessibilityIdentifier("markdown-files-divider")
    }

    @State private var gitDragStart: Double?

    /// The git sidebar's left edge: the same divider, mirrored (a drag to the left widens the sidebar).
    private var gitDivider: some View {
        MarkdownSplitDivider(
            line: NSColor(model.theme.border),
            accent: NSColor(model.theme.accent),
            onBegin: { gitDragStart = model.gitWidth },
            onDrag: { dx in
                model.gitWidth = MarkdownSidebarWidth.clamped((gitDragStart ?? model.gitWidth) - dx, fallback: MarkdownSidebarWidth.gitStandard)
            },
            onEnd: { gitDragStart = nil },
            onReset: { model.gitWidth = MarkdownSidebarWidth.gitStandard },
            onStep: { direction in
                model.gitWidth = MarkdownSidebarWidth.clamped(
                    model.gitWidth - Double(direction) * MarkdownSidebarWidth.keyboardStep,
                    fallback: MarkdownSidebarWidth.gitStandard
                )
            },
            label: "Git sidebar divider",
            valueText: "\(Int(model.gitWidth)) points wide"
        )
        .frame(width: 6)
        .accessibilityIdentifier("markdown-git-divider")
    }

    var body: some View {
        let _ = RenderProbe.hit("md.window")
        VStack(spacing: 0) {
            if let doc = model.selected {
                MarkdownDocumentToolbar(doc: doc, model: model)
            }
            if model.docs.count > 1 {
                tabBar
                    .background(model.theme.chrome)
                    // Chrome too, under the zone's strip: the same double-click as the title bar.
                    .onTapGesture(count: 2) {
                        MarkdownDocumentWindow.input.notice("tab bar double click")
                        if let window = MarkdownDocumentWindowController.shared.window {
                            WindowTitlebar.performDoubleClick(on: window)
                        }
                    }
                // The wrapped bar draws its own bottom line: the divider that sets its height.
                if !model.configuration.wrapTabs {
                    Rectangle().fill(model.theme.border).frame(height: 1)
                }
            }
            if let doc = model.selected {
                HStack(spacing: 0) {
                    // Files first, then the outline: both are sidebars, and the
                    // one that answers "which document" belongs outside the one
                    // that answers "where in this document".
                    if model.showFiles {
                        MarkdownFileTreeView(model: model)
                            .frame(width: model.filesWidth)
                        filesDivider
                    }
                    if model.showOutline {
                        MarkdownOutlineView(doc: doc, model: model)
                            .frame(width: MarkdownSidebarWidth.outline)
                        Rectangle().fill(model.theme.border).frame(width: 1)
                    }
                    // The old tab's page stays until the new one has rendered: no blank frame on a switch. The fade is
                    // Core Animation's: a SwiftUI one re-rendered the whole window on each of its frames.
                    GenRenderSwap(value: doc, id: \.id, fade: .layer) { shown, ready in
                        MarkdownDocumentPane(doc: shown, model: model, leaving: shown.id != model.selected?.id)
                            .environment(\.genRenderReady, ready)
                            .onAppear {
                                if !MarkdownDocumentPane.waitsForPage(shown, model: model) { ready() }
                            }
                    }
                    if model.showGit && model.configuration.git {
                        gitDivider
                        MarkdownGitSidebar(doc: doc, model: model)
                            .frame(width: model.gitWidth)
                    }
                }
                .overlay(alignment: .topTrailing) { MarkdownNoticeSlot(model: model) }
                MarkdownStatusBar(doc: doc, model: model)
            } else {
                // A bare grey line gave no way forward. Say what the window
                // is for and offer the three ways to get a file into it.
                VStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 30, weight: .light))
                        .foregroundStyle(model.theme.textMuted)
                    Text("No document open")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(model.theme.text)
                    Text("Drop a Markdown file here, or open one.")
                        .font(.system(size: 12))
                        .foregroundStyle(model.theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 340)
                    Button("Open…") { Self.chooseFiles(into: model) }
                        .buttonStyle(.genHover(accent: model.theme.accent))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(model.theme.accent)
                        .instantTooltip(MarkdownKeymap.hint("Choose Markdown files to open as tabs", "markdown.file.open"))
                        .accessibilityIdentifier("markdown-viewer-open-files")
                    MarkdownEmptyRecents(model: model)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .topTrailing) { MarkdownNoticeSlot(model: model) }
            }
        }
        // Paints the whole window but takes no clicks in the toolbar row: its empty part belongs to
        // the window's `.titlebarZone(below:)` (Window/WindowTitlebar.swift). Below the row it still
        // takes clicks and drops, as the plain fill did.
        .background { model.theme.page.allowsHitTesting(false) }
        .background {
            Color.clear
                .contentShape(Rectangle())
                .padding(.top, MarkdownDocumentToolbar.height)
        }
        .sheet(isPresented: $model.goToOpen) {
            MarkdownGoToSheet(model: model)
        }
        // The views read the configuration through the model (`model.theme` carries its contrast), so a
        // change to it is a change to the model.
        .onReceive(model.configuration.objectWillChange) { _ in model.objectWillChange.send() }
        // The AppKit panes take their own drops (they would otherwise navigate
        // or paste a path); this covers the chrome around them.
        .dropDestination(for: URL.self) { urls, _ in
            model.acceptDrop(urls)
            return true
        } isTargeted: { targeted in
            if dropTargeted != targeted { dropTargeted = targeted }
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(model.theme.accent.opacity(0.8), lineWidth: 2)
                    .padding(.top, MarkdownDocumentToolbar.height)
                    .padding(3)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        // The window's keys run through `MarkdownKeymap.registerWindowCommands`, in Genesis.app's process as well
        // as the viewer's own.
    }

    private var tabBar: some View {
        MarkdownTabBar(model: model, configuration: model.configuration)
    }
}

/// The empty window's next step besides Open…: the last few files that are still on disk, one button each
/// (UX audit W23).
private struct MarkdownEmptyRecents: View {
    @ObservedObject var model: MarkdownDocumentsModel

    private var files: [URL] {
        model.recents.entries.lazy
            .filter { FileManager.default.fileExists(atPath: $0.path) }
            .prefix(5)
            .map { URL(fileURLWithPath: $0.path) }
    }

    var body: some View {
        let files = files
        if !files.isEmpty {
            VStack(spacing: 4) {
                Text("Recent").font(.system(size: 11, weight: .semibold)).foregroundStyle(model.theme.textMuted)
                    .padding(.top, 8)
                ForEach(files, id: \.self) { file in
                    Button { model.open([file]) } label: {
                        HStack(spacing: 6) {
                            Text(MarkdownDocument.title(for: file)).foregroundStyle(model.theme.text)
                            Text(file.deletingLastPathComponent().lastPathComponent)
                                .foregroundStyle(model.theme.textSecondary)
                        }
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(file.path)
                    .accessibilityLabel("Open \(MarkdownDocument.title(for: file)), in \(file.deletingLastPathComponent().lastPathComponent)")
                }
            }
            .frame(maxWidth: 340)
        }
    }
}

/// How tall the wrapped tab bar may be.
enum MarkdownTabBarHeight {
    /// One row of tabs with the bar's padding.
    static let minimum: Double = 40
    static let maximum: Double = 640
    /// One arrow-key or VoiceOver step: half a row.
    static let keyboardStep: Double = 16

    static func clamped(_ height: Double) -> Double { min(max(height, minimum), maximum) }

    /// The tallest the bar shows: the dragged height, else the row count (0 rows is no limit).
    @MainActor static func limit(_ configuration: GenesisKitMarkdownConfiguration) -> CGFloat {
        if configuration.tabBarHeight > 0 { return CGFloat(clamped(configuration.tabBarHeight)) }
        let rows = configuration.wrapTabsMaxRows
        return rows > 0 ? CGFloat(rows) * 32 + 8 : 10_000
    }
}

/// The tab row: one scrolling strip, or every tab on as many rows as it takes (`wrapTabs`). Either way the
/// selected tab is on screen. With enough tabs open they fall into groups (`MarkdownTabGrouping`): a chip per group
/// that folds it, drags that move tabs and groups, and menus that rename, regroup and close. A right-click on its
/// empty part offers Wrap Tabs and the grouping rule.
private struct MarkdownTabBar: View {
    @ObservedObject var model: MarkdownDocumentsModel
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration
    /// The wrapped content's own height, and the bar's shown height when a drag of its bottom edge began.
    @State private var contentHeight: CGFloat = 0
    @State private var dragStart: Double?

    var body: some View {
        let _ = RenderProbe.hit("md.tabBar")
        // Read once per pass: `selected` searches the tabs, and asking it per tab made a pass N² (2026-10-15).
        let selectedID = model.selected?.id
        let groups = model.tabGroups
        Group {
            if groups.isEmpty {
                if configuration.wrapTabs {
                    capped(selectedID: selectedID) {
                        MarkdownTabFlow(spacing: 2, rowSpacing: 2) {
                            ForEach(model.docs) { doc in
                                tab(doc, selectedID: selectedID).id(doc.id)
                            }
                        }
                    }
                } else {
                    strip(selectedID: selectedID)
                }
            } else if configuration.wrapTabs {
                capped(selectedID: selectedID) {
                    if configuration.tabGroupRows {
                        wrapped(groups, selectedID: selectedID)
                    } else {
                        flowing(groups, selectedID: selectedID)
                    }
                }
            } else {
                groupedStrip(groups, selectedID: selectedID)
            }
        }
        .contentShape(Rectangle())
        .contextMenu {
            MarkdownTabGroupingMenu(configuration: configuration, notices: model)
            Divider()
            MarkdownWrapTabsToggle(configuration: configuration)
        }
        .accessibilityIdentifier("markdown-tab-bar")
    }

    /// A tab gets the few model values it shows. It does not observe the model, so an unrelated publish (the
    /// preview's section, a find count) skips all tab bodies: with 24 tabs each publish re-ran 24 of them
    /// (2026-10-14, MarkdownTreeLagBenchTests: 480 tab bodies for 20 section changes).
    private func tab(_ doc: MarkdownDocument, selectedID: String?) -> some View {
        MarkdownDocumentTab(
            doc: doc, model: model, active: doc.id == selectedID, preview: model.isPreview(doc),
            fill: model.theme.fill
        )
        .equatable()
    }

    /// A newly opened or switched-to tab can sit past the edge of an
    /// overflowing strip, so the strip follows the selection. A nil anchor
    /// scrolls the least amount that shows the whole tab.
    private func strip(selectedID: String?) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(model.docs) { doc in
                        tab(doc, selectedID: selectedID)
                            .id(doc.id)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.top, 6)
                .padding(.bottom, 6)
            }
            .onChange(of: selectedID, initial: true) { _, id in
                guard let id else { return }
                proxy.scrollTo(id, anchor: nil)
            }
        }
    }

    // MARK: Groups

    private var collapsed: Set<String> { configuration.tabGroupState.collapsed }

    /// The tabs a group shows: all of them, or only the selected one while it is folded, so the tab you read never
    /// disappears into a folded group.
    private func shown(_ group: MarkdownTabGroup, selectedID: String?) -> [MarkdownDocument] {
        let ids = collapsed.contains(group.id) ? group.tabIDs.filter { $0 == selectedID } : group.tabIDs
        let byID = Dictionary(model.docs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.compactMap { byID[$0] }
    }

    private func chip(_ group: MarkdownTabGroup) -> some View {
        MarkdownTabGroupChip(group: group, collapsed: collapsed.contains(group.id), model: model)
    }

    /// The wrapped bar: at most `wrapTabsMaxRows` rows (about 32 pt each) or the height dragged on its bottom edge,
    /// scrolling past that with a fade at the cut edge, and following the selected tab. Shorter content keeps its own
    /// height (`FittedScroll`).
    private func capped<Content: View>(selectedID: String?, @ViewBuilder content: @escaping () -> Content) -> some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                FittedScroll(maxHeight: MarkdownTabBarHeight.limit(configuration), measured: { contentHeight = $0 }) {
                    content()
                        .padding(.horizontal, 8)
                        .padding(.top, 6)
                        .padding(.bottom, 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: selectedID, initial: true) { _, id in
                    guard let id else { return }
                    proxy.scrollTo(id, anchor: nil)
                }
            }
            heightDivider
        }
    }

    /// The bar's bottom line: the sidebars' divider laid flat. A drag sets the bar's tallest height, a double-click
    /// goes back to the row count, the arrows step half a row.
    private var heightDivider: some View {
        let shown = min(MarkdownTabBarHeight.limit(configuration), contentHeight)
        return MarkdownSplitDivider(
            orientation: .horizontal,
            line: NSColor(model.theme.border),
            accent: NSColor(model.theme.accent),
            onBegin: { dragStart = shown },
            onDrag: { dy in configuration.tabBarHeight = MarkdownTabBarHeight.clamped((dragStart ?? shown) + dy) },
            onEnd: { dragStart = nil },
            onReset: { configuration.tabBarHeight = 0 },
            onStep: { direction in
                configuration.tabBarHeight = MarkdownTabBarHeight.clamped(shown + Double(direction) * MarkdownTabBarHeight.keyboardStep)
            },
            label: "Tab bar height",
            valueText: "\(Int(shown)) points tall"
        )
        .frame(height: 5)
        .frameProbe("md.tabBarDivider")
        .accessibilityIdentifier("markdown-tab-bar-divider")
    }

    /// Wrapped, the default: every group's chip and its tabs flow on, one group after another.
    private func flowing(_ groups: [MarkdownTabGroup], selectedID: String?) -> some View {
        MarkdownTabFlow(spacing: 2, rowSpacing: 2) {
            ForEach(groups) { group in
                chip(group).padding(.leading, group.id == groups.first?.id ? 0 : 6)
                ForEach(shown(group, selectedID: selectedID)) { doc in
                    tab(doc, selectedID: selectedID).id(doc.id)
                }
            }
        }
    }

    /// Wrapped with "Each Group on Its Own Rows": an open group starts its own rows with its chip; folded groups next
    /// to each other share a row.
    private func wrapped(_ groups: [MarkdownTabGroup], selectedID: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(MarkdownTabGroupRows.rows(groups, collapsed: collapsed)) { row in
                MarkdownTabFlow(spacing: 2, rowSpacing: 2) {
                    ForEach(row.groups) { group in
                        chip(group)
                        ForEach(shown(group, selectedID: selectedID)) { doc in
                            tab(doc, selectedID: selectedID).id(doc.id)
                        }
                    }
                }
            }
        }
    }

    private func groupedStrip(_ groups: [MarkdownTabGroup], selectedID: String?) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(groups) { group in
                        chip(group).padding(.leading, group.id == groups.first?.id ? 0 : 8)
                        ForEach(shown(group, selectedID: selectedID)) { doc in
                            tab(doc, selectedID: selectedID).id(doc.id)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .onChange(of: selectedID, initial: true) { _, id in
                guard let id else { return }
                proxy.scrollTo(id, anchor: nil)
            }
        }
    }
}

/// Which groups share a row in the wrapped bar: every open group is a row of its own, and a run of folded groups
/// is one row of chips.
enum MarkdownTabGroupRows {
    struct Row: Identifiable, Equatable {
        var groups: [MarkdownTabGroup]
        var id: String { groups.map(\.id).joined(separator: "|") }
    }

    static func rows(_ groups: [MarkdownTabGroup], collapsed: Set<String>) -> [Row] {
        var rows: [Row] = []
        for group in groups {
            if collapsed.contains(group.id), let last = rows.last, last.groups.allSatisfy({ collapsed.contains($0.id) }) {
                rows[rows.count - 1].groups.append(group)
            } else {
                rows.append(Row(groups: [group]))
            }
        }
        return rows
    }
}

/// A group's chip: its colour, a chevron, its name and its count. A click folds or opens it, ⌥-click shows only
/// this group, a double-click renames it. Drop a tab on it to move the tab in; drag it onto another chip to reorder.
private struct MarkdownTabGroupChip: View {
    let group: MarkdownTabGroup
    let collapsed: Bool
    let model: MarkdownDocumentsModel
    @State private var renaming = false
    @State private var name = ""
    @FocusState private var nameFocused: Bool
    @State private var dropSide: MarkdownTabDropSide?
    @State private var width: CGFloat = 0

    private var color: Color { MarkdownTabGroupChip.color(for: group.id) }

    var body: some View {
        Button(action: click) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .bold))
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                Text(group.title).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                Text(verbatim: "\(group.tabIDs.count)")
                    .font(.system(size: 10.5, weight: .medium)).monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Capsule().fill(color.opacity(dropSide == .into ? 0.32 : 0.16)))
            .overlay(Capsule().strokeBorder(color.opacity(dropSide == .into ? 0.9 : 0.4), lineWidth: 1))
            .foregroundStyle(color)
            .contentShape(Capsule())
        }
        .buttonStyle(.genHoverPlain())
        .padding(.vertical, 2)
        .instantTooltip(tooltip)
        .accessibilityLabel("\(group.title) group, \(group.tabIDs.count) \(group.tabIDs.count == 1 ? "tab" : "tabs"), \(collapsed ? "folded" : "open")")
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("markdown-tab-group-" + group.id)
        .draggable(MarkdownTabDrag.begin(.group(group.id)))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onDrop(of: [.utf8PlainText, .plainText], delegate: MarkdownTabDropDelegate(
            width: width, chip: true, side: $dropSide, perform: drop))
        .markdownTabDropLine(dropSide)
        .contextMenu { menu }
        // The field takes the focus when the popover opens, and the name is kept on Return and on any other way
        // the popover closes (a click outside); Esc puts the old name back (UX audit W17).
        .popover(isPresented: $renaming, arrowEdge: .bottom) {
            TextField("Group name", text: $name)
                .textFieldStyle(.roundedBorder)
                .frame(width: 220)
                .padding(12)
                .focused($nameFocused)
                .onAppear { nameFocused = true }
                .onSubmit { renaming = false }
                .onExitCommand {
                    name = group.title
                    renaming = false
                }
        }
        .onChange(of: renaming) { _, open in
            guard !open else { return }
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, trimmed != group.title { model.renameGroup(group.id, to: trimmed) }
        }
    }

    private var tooltip: TooltipContent {
        TooltipContent(title: group.title + (group.detail.map { " · " + $0 } ?? ""), bullets: [
            "Click folds or opens the group, ⌥-click shows only this group",
            "Double-click renames it",
            "Drag a tab onto it to move the tab in; drag the group to reorder",
        ])
    }

    /// A tab on the chip goes into the group; a group lands before or after this one.
    private func drop(_ drag: MarkdownTabDrag, _ side: MarkdownTabDropSide) {
        switch drag {
        case .tab(let id): model.dropTab(id, onGroup: group.id)
        case .group(let id): model.moveGroup(id, beside: group.id, after: side == .after)
        }
    }

    private func click() {
        if MouseClick.current >= 2 {
            // The first click of the double-click already folded or opened it: put that back, then rename.
            model.toggleGroup(group.id)
            startRename()
        } else if NSEvent.modifierFlags.contains(.option) {
            model.focusGroup(group.id)
        } else {
            model.toggleGroup(group.id)
        }
    }

    private func startRename() {
        name = group.title
        renaming = true
    }

    @ViewBuilder private var menu: some View {
        Button("Rename Group…", action: startRename)
        Button(collapsed ? "Open Group" : "Fold Group") { model.toggleGroup(group.id) }
        Button("Show Only This Group") { model.focusGroup(group.id) }
        Button("Open All Groups") { model.setAllGroups(collapsed: false) }
        Button("Fold All Groups") { model.setAllGroups(collapsed: true) }
        Divider()
        Button("Move Group Left") { model.shiftGroup(group.id, by: -1) }
        Button("Move Group Right") { model.shiftGroup(group.id, by: 1) }
        if group.manual || model.configuration.tabGroupState.names[group.id] != nil {
            Button(group.manual ? "Ungroup" : "Undo Changes to This Group") { model.ungroup(group.id) }
        }
        Divider()
        Button("Close \(group.tabIDs.count == 1 ? "Tab" : "\(group.tabIDs.count) Tabs") in Group") {
            model.closeGroup(group.id)
        }
        Divider()
        MarkdownTabGroupingMenu(configuration: model.configuration, notices: model)
    }

    /// A stable colour per group id, so a group keeps its colour across launches and reorders.
    static func color(for id: String) -> Color {
        let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .green, .indigo, .mint, .cyan, .yellow, .red, .brown]
        let hash = id.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
        return palette[Int(hash % UInt32(palette.count))]
    }
}

/// What a drag in the tab bar carries: a tab or a group, as text with a prefix, so a drop knows which it got.
enum MarkdownTabDrag: Equatable {
    case tab(String)
    case group(String)

    static func tab(_ id: String) -> String { "genesis-tab:" + id }
    static func group(_ id: String) -> String { "genesis-tab-group:" + id }

    static func parse(_ text: String) -> MarkdownTabDrag? {
        if text.hasPrefix("genesis-tab-group:") { return .group(String(text.dropFirst("genesis-tab-group:".count))) }
        if text.hasPrefix("genesis-tab:") { return .tab(String(text.dropFirst("genesis-tab:".count))) }
        return nil
    }
}

/// "Group Tabs By" and "Group From", in the tab bar's menu, every chip's and every tab's.
struct MarkdownTabGroupingMenu: View {
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration
    /// Where the reset's Undo note goes.
    var notices: MarkdownDocumentsModel?

    var body: some View {
        Picker("Group Tabs By", selection: $configuration.tabGrouping) {
            ForEach(MarkdownTabGroupRule.allCases, id: \.self) { Text($0.title).tag($0) }
        }
        // An option its parent switch makes moot is dimmed, and its parent is named in the title (UX audit W21).
        let grouping = configuration.tabGrouping != .off
        Picker(grouping ? "Group From" : "Group From (Grouping Is Off)", selection: $configuration.tabGroupFrom) {
            Text("Always").tag(0)
            Text("6 Open Tabs").tag(6)
            Text("10 Open Tabs").tag(10)
            Text("20 Open Tabs").tag(20)
        }
        .disabled(!grouping)
        Toggle(configuration.wrapTabs && grouping ? "Each Group on Its Own Rows" : "Each Group on Its Own Rows (Needs Wrap Tabs and Grouping)",
               isOn: $configuration.tabGroupRows)
            .disabled(!configuration.wrapTabs || !grouping)
        Picker(configuration.wrapTabs ? "Wrapped Tabs Show" : "Wrapped Tabs Show (Wrap Tabs Is Off)",
               selection: $configuration.wrapTabsMaxRows) {
            Text("2 Rows").tag(2)
            Text("4 Rows").tag(4)
            Text("6 Rows").tag(6)
            Text("Every Row").tag(0)
        }
        .disabled(!configuration.wrapTabs)
        if configuration.tabBarHeight > 0 {
            Button("Reset Tab Bar Height") { configuration.tabBarHeight = 0 }
        }
        if configuration.tabGroupState != MarkdownTabGroupState() {
            Button("Reset Group Names, Order and Moves") { resetGroups() }
        }
    }
}

extension MarkdownTabGroupingMenu {
    /// Every hand edit to the groups goes at once, so the reset says so and offers Undo (UX audit W22).
    private func resetGroups() {
        let before = configuration.tabGroupState
        configuration.tabGroupState = MarkdownTabGroupState()
        guard let model = notices else { return }
        model.post(MarkdownNotice("Group names, order and moves were reset.", tone: .info, actions: [
            .button("Undo", symbol: "arrow.uturn.backward") { [weak model, configuration] in
                configuration.tabGroupState = before
                model?.dismissNotice()
            },
        ]))
    }
}

/// "Move to Group" in a tab's menu: the groups there are, a new group, or back to the rule.
private struct MarkdownTabMoveMenu: View {
    let doc: MarkdownDocument
    let model: MarkdownDocumentsModel

    var body: some View {
        let groups = model.tabGroups
        let current = model.group(of: doc.id)?.id
        Menu("Move to Group") {
            // With the detail (the folder above, the project) two groups of one name can be told apart (UX audit W20).
            ForEach(groups.filter { $0.id != current }) { group in
                Button(group.title + (group.detail.map { " · " + $0 } ?? "")) { model.dropTab(doc.id, onGroup: group.id) }
            }
            if groups.count > 1 { Divider() }
            Button("New Group with This Tab") { model.newGroup(with: doc.id) }
            if model.configuration.tabGroupState.assigned[doc.id] != nil {
                Button("Back to Its Own Group") { model.assign(doc.id, to: nil) }
            }
        }
    }
}

/// "Wrap Tabs", in the tab bar's menu and in every tab's.
private struct MarkdownWrapTabsToggle: View {
    @ObservedObject var configuration: GenesisKitMarkdownConfiguration

    var body: some View {
        Toggle("Wrap Tabs", isOn: $configuration.wrapTabs)
    }
}

/// One tab. Its own view so it observes its document: the model publishes the
/// list of tabs, not the edits inside them, so the dirty dot and the
/// changed-on-disk mark would otherwise wait for an unrelated model update.
/// Selecting is a real button, so the keyboard and VoiceOver can reach it.
private struct MarkdownDocumentTab: View, Equatable {
    @ObservedObject var doc: MarkdownDocument
    /// For the tab's actions only: not observed (see `MarkdownTabBar.tab`).
    let model: MarkdownDocumentsModel
    let active: Bool
    let preview: Bool
    let fill: Color
    @ObservedObject private var configuration = GenesisKitMarkdownConfiguration.shared
    @State private var dropSide: MarkdownTabDropSide?
    @State private var width: CGFloat = 0

    static func == (left: MarkdownDocumentTab, right: MarkdownDocumentTab) -> Bool {
        left.doc === right.doc && left.model === right.model && left.active == right.active
            && left.preview == right.preview && left.fill == right.fill
    }

    var body: some View {
        let _ = RenderProbe.hit("md.tab")
        // A tab that previews on hover shows its path in the preview's header instead: a tooltip there
        // would sit under the preview.
        let previews = !active && model.configuration.hoverPreview
        // No gap and no outer tap gesture: the select button's label carries the tab's left and vertical padding and
        // the close button's carries the right, so the whole drawn tab shows the hover and the hand, and every click
        // lands on a button (UX audit W15).
        HStack(spacing: 0) {
            Button {
                selectOrKeep(via: "button")
            } label: {
                HStack(spacing: 6) {
                    if doc.hasDiskChange {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.genWarning)
                            .instantTooltip("Changed on disk while you have unsaved edits")
                    }
                    Text(doc.isDirty ? "\(doc.title) •" : doc.title)
                        .lineLimit(1)
                        .font(.system(size: 12, weight: active ? .semibold : .regular))
                        // The preview tab, which the next single click in the file tree replaces.
                        .italic(preview)
                    if configuration.gitShows(\.gitTreeDecorations) {
                        GitFileMark(file: doc.url)
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, 3)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(previews ? "" : tooltip)
            .accessibilityLabel(accessibilityTitle)
            .accessibilityAddTraits(active ? .isSelected : [])
            .accessibilityAction(named: "Move Left") { model.shiftTab(doc.id, by: -1) }
            .accessibilityAction(named: "Move Right") { model.shiftTab(doc.id, by: 1) }
            Button {
                MarkdownDocumentWindow.input.notice("\(MarkdownTabLog.note(action: "close", index: tabIndex), privacy: .public)")
                model.close(doc)
            } label: {
                // A 22 pt target around the 9 pt glyph (UX audit W11). With the 9 pt right padding inside the label
                // and no gap before it, the glyph's centre and the tab's width stay where the old 16 pt frame, 6 pt
                // gap and 12 pt padding put them.
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .opacity(0.6)
                    .frame(width: 22, height: 22)
                    .padding(.trailing, 9)
                    .padding(.vertical, 3)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(MarkdownKeymap.hint("Close tab", "markdown.tab.close"))
            .accessibilityLabel("Close \(doc.title)")
        }
        .background(active ? fill : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .contextMenu {
            if preview {
                Button("Keep Tab") { model.keep(doc) }
                Divider()
            }
            MarkdownTabMenu(doc: doc, model: model)
            Button("Move Tab Left") { model.shiftTab(doc.id, by: -1) }
                .disabled(!model.canShiftTab(doc.id, by: -1))
            Button("Move Tab Right") { model.shiftTab(doc.id, by: 1) }
                .disabled(!model.canShiftTab(doc.id, by: 1))
            Divider()
            if model.groupsTabs {
                MarkdownTabMoveMenu(doc: doc, model: model)
            }
            MarkdownTabGroupingMenu(configuration: model.configuration, notices: model)
            MarkdownWrapTabsToggle(configuration: model.configuration)
        }
        .draggable(MarkdownTabDrag.begin(.tab(doc.id))) {
            Text(doc.title).font(.system(size: 12, weight: .medium)).padding(.horizontal, 12).padding(.vertical, 7)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onDrop(of: [.utf8PlainText, .plainText], delegate: MarkdownTabDropDelegate(
            width: width, chip: false, side: $dropSide, perform: drop))
        .markdownTabDropLine(dropSide)
        .markdownHoverPreview(active ? nil : doc.url, model: model)
        .frameProbe("md.tab." + doc.id)
    }

    /// A click selects. The second click of a double-click also keeps a preview tab, as in an editor;
    /// a separate double-tap gesture would hold every single click back by the double-click interval.
    private var tabIndex: Int {
        model.docs.firstIndex { $0.id == doc.id } ?? 0
    }

    /// A tab lands before or after this one, in its group; a group moves before or after this tab's group.
    private func drop(_ drag: MarkdownTabDrag, _ side: MarkdownTabDropSide) {
        switch drag {
        case .tab(let id):
            model.dropTab(id, beside: doc.id, after: side == .after)
        case .group(let id):
            guard let target = model.group(of: doc.id)?.id else { return }
            model.moveGroup(id, beside: target, after: side == .after)
        }
    }

    private func selectOrKeep(via gesture: String) {
        MarkdownDocumentWindow.input.notice("\(MarkdownTabLog.note(action: "select", index: tabIndex, gesture: gesture), privacy: .public)")
        model.select(doc.id)
        if MouseClick.current >= 2 {
            model.keep(doc)
        }
    }

    /// The path, and for the italic preview tab what italic means (UX audit W24).
    private var tooltip: String {
        guard preview else { return doc.url.path }
        return "Preview tab: the next file you open from the sidebar replaces it. Double-click to keep it.\n" + doc.url.path
    }

    private var accessibilityTitle: String {
        var parts = [doc.title]
        if preview { parts.append("preview") }
        if doc.isDirty { parts.append("unsaved") }
        if doc.hasDiskChange { parts.append("changed on disk") }
        return parts.joined(separator: ", ")
    }
}

/// The preview text in split view: a beat behind the keystrokes, because a
/// render runs markdown-it, highlight.js and mermaid over the whole document,
/// which is far too much work to repeat on every character.
@MainActor
final class MarkdownLivePreview: ObservableObject {
    @Published private(set) var text: String

    /// The document's text from the start: an empty first value went to the page as an empty render.
    init(_ text: String = "") {
        self.text = text
    }
    static let delay: Duration = .milliseconds(220)
    private var task: Task<Void, Never>?

    /// What the pending task will publish. nil = nothing is pending, so the
    /// preview already shows `text`.
    private var pending: String?

    /// Show `new` at once (a new document, or the pane entering split view).
    func reset(_ new: String) {
        task?.cancel()
        task = nil
        pending = nil
        text = new
    }

    func update(_ new: String) {
        // Typing and undoing inside one delay: the pending render targets the
        // text that no longer exists, so it has to be cancelled rather than
        // left to fire. Comparing against `text` alone misses this.
        guard new != (pending ?? text) else { return }
        task?.cancel()
        if new == text {
            task = nil
            pending = nil
            return
        }
        pending = new
        task = Task { [weak self] in
            try? await Task.sleep(for: Self.delay)
            guard !Task.isCancelled, let self else { return }
            text = new
            pending = nil
        }
    }
}

/// What a document pane shows, apart from the view: a binary tab has no web page, and a draft or a past
/// revision stays on screen when the file on disk is no longer text.
@MainActor
enum MarkdownPaneContent {
    /// An image request changes with the file's contents and the pane's pixel size.
    struct PictureRequest: Hashable {
        /// The image file to decode for this pane.
        let url: URL
        /// The document's observed modification date, which invalidates the picture task.
        let modifiedAt: Date?
        /// The bucketed pixel limit used by the shared thumbnail decoder.
        let pixels: CGFloat

        /// Builds a request whose identity changes only with the file, timestamp or decode bucket.
        init(url: URL, modifiedAt: Date?, pixels: CGFloat) {
            self.url = url
            self.modifiedAt = modifiedAt
            self.pixels = CGFloat(MediaThumbnailCache.bucket(forPixels: pixels))
        }

        /// The file part of the request: what makes a shown picture wrong, as opposed to only the wrong size.
        var file: PictureFile { PictureFile(url: url, modifiedAt: modifiedAt) }

        /// Loads the picture through the shared off-main decoder and thumbnail cache.
        func load() async -> MarkdownHoverImage.Picture {
            await MarkdownHoverImage.picture(url: url, pixels: pixels, draft: nil)
        }
    }

    struct PictureFile: Hashable {
        let url: URL
        let modifiedAt: Date?
    }

    /// Whether the current pane renders a web page whose completion must precede the tab swap.
    static func waitsForPage(_ doc: MarkdownDocument, model: MarkdownDocumentsModel) -> Bool {
        guard model.renderer == .web, !(doc.missing && !doc.isDirty), !showsBinary(doc, model: model),
              model.revisionView?.docID != doc.id else { return false }
        return model.mode == .preview || model.mode == .split
    }

    /// A picture replaces the editor only for the clean current file. A draft, Changes, and a past revision stay.
    static func showsBinary(_ doc: MarkdownDocument, model: MarkdownDocumentsModel) -> Bool {
        doc.binary && !doc.isDirty && model.mode != .changes && model.revisionView?.docID != doc.id
    }
}

private struct MarkdownDocumentPane: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    @StateObject private var live: MarkdownLivePreview
    @StateObject private var gutter = GitGutterModel()
    @StateObject private var blame = AgentBlameModel()
    @State private var binaryPicture: MarkdownHoverImage.Picture = .loading
    /// The file and date the shown picture was decoded from: a new size of the same file keeps it on screen while
    /// the new size decodes (UX audit W9).
    @State private var binaryPictureFile: MarkdownPaneContent.PictureFile?
    /// Try Again after a failed decode.
    @State private var binaryPictureAttempt = 0

    private var showsPicture: Bool {
        if case .ready = binaryPicture { return true }
        return false
    }
    @Environment(\.displayScale) private var displayScale
    @ObservedObject private var configuration = GenesisKitMarkdownConfiguration.shared

    /// The tab being switched away from, on screen until the new tab's page has rendered: it owns no sheet, no find
    /// panel and not the window's page proxy.
    let leaving: Bool

    init(doc: MarkdownDocument, model: MarkdownDocumentsModel, leaving: Bool = false) {
        self.doc = doc
        self.model = model
        self.leaving = leaving
        _live = StateObject(wrappedValue: MarkdownLivePreview(doc.displayText))
    }

    /// Whether this tab shows a rendered page, so a tab switch waits for its render before it swaps.
    static func waitsForPage(_ doc: MarkdownDocument, model: MarkdownDocumentsModel) -> Bool {
        MarkdownPaneContent.waitsForPage(doc, model: model)
    }
    /// The ratio when the drag started, so the pointer stays on the divider.
    @State private var dragStartRatio: Double?
    /// The body line the editor is showing, sent to the preview in split view.
    @State private var syncLine: MarkdownLineSync?
    /// This pane's links, as one anchor of the hover preview.
    @State private var linkHoverOwner = UUID()

    var body: some View {
        let _ = RenderProbe.hit("md.pane")
        VStack(spacing: 0) {
            if doc.hasDiskChange || doc.mergeConflicts > 0 || (doc.missing && doc.isDirty) {
                MarkdownConflictBanner(doc: doc, model: model)
            }
            content
                // ⌘F: a panel floating over the document's top right, below any banner.
                .overlay {
                    if !leaving { MarkdownFindOverlay(model: model) }
                }
        }
        .sheet(isPresented: leaving ? .constant(false) : $model.compareOpen) {
            MarkdownCompareSheet(doc: doc, model: model)
        }
        .sheet(item: leaving ? .constant(nil) : $model.commitSheet) { sheet in
            MarkdownCommitSheetView(sheet: sheet, model: model)
        }
        .onAppear { live.reset(doc.displayText) }
        .onChange(of: doc.displayText) { _, new in
            live.update(new)
            gutter.textChanged(new)
        }
        .onAppear { followGutter() }
        .onChange(of: configuration.git) { _, _ in followGutter() }
        .onChange(of: configuration.gitGutter) { _, _ in followGutter() }
        .onChange(of: configuration.gitAgentAttribution) { _, _ in followGutter() }
        .onChange(of: doc.modifiedAt) { _, _ in blame.reload() }
        .onChange(of: model.modeRaw) { _, _ in live.reset(doc.displayText) }
        // A render moves every block, so the page needs the line again.
        .onChange(of: live.text) { _, _ in
            guard let current = syncLine else { return }
            syncLine = MarkdownLineSync(line: current.line, token: current.token + 1)
        }
        // A text hit from the file sidebar: the page counts body lines, the
        // hit counts file lines, so the frontmatter comes off first.
        .onChange(of: model.lineTarget) { _, target in
            guard let target else { return }
            follow(target.line)
        }
        .onAppear {
            if let target = model.lineTarget { follow(target.line) }
        }
        // A link preview waiting on this pane's page has no anchor once the pane is gone.
        .onDisappear { MarkdownHoverPreviewController.shared.exit(owner: linkHoverOwner) }
    }

    /// The file's path under "File is gone" or "Not a text file": a click opens it in its default app, its folder in
    /// Finder, or the folder in the sidebar (Martin, 2026-10-15).
    private var pathButton: some View {
        let folder = doc.url.deletingLastPathComponent()
        return PathMenuButton(entries: {
            PathMenu.entries(for: doc.url, kind: .file, actions: [.openInDefaultApp],
                             handlers: model.pathHandlers(for: doc.url, kind: .file))
                + PathMenu.entries(for: folder, kind: .folder, actions: [.openInFinder, .navigateInSidebar],
                                   handlers: model.pathHandlers(for: folder, kind: .folder))
        }) {
            Text(doc.url.path)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .underline()
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Open, show in Finder or navigate to the folder")
        .accessibilityIdentifier("markdown-missing-path")
    }

    /// A file that is not text: a picture is drawn to fit the pane; anything else names the file.
    @ViewBuilder
    private var binaryView: some View {
        if MarkdownHoverImage.isImage(doc.url) {
            GeometryReader { geometry in
                let request = MarkdownPaneContent.PictureRequest(
                    url: doc.url, modifiedAt: doc.modifiedAt,
                    pixels: MarkdownHoverImage.pixels(for: geometry.size, scale: displayScale)
                )
                Group {
                    if case .ready(let thumbnail) = binaryPicture {
                        Image(decorative: thumbnail.image, scale: max(1, displayScale))
                            .resizable()
                            .interpolation(.high)
                            .scaledToFit()
                            .accessibilityLabel(doc.url.lastPathComponent)
                            .accessibilityIdentifier("markdown-binary-image")
                    } else if case .failed = binaryPicture {
                        VStack(spacing: 8) {
                            Text("The picture could not be shown")
                                .font(.headline)
                            pathButton
                            Button("Try Again") { binaryPictureAttempt += 1 }
                                .buttonStyle(.genHover(accent: model.theme.accent))
                                .foregroundStyle(model.theme.accent)
                                .accessibilityIdentifier("markdown-binary-retry")
                        }
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .task(id: [AnyHashable(request), AnyHashable(binaryPictureAttempt)]) {
                    // Only another file (or a changed one) takes the picture away; a new size decodes behind it.
                    if binaryPictureFile != request.file || !showsPicture { binaryPicture = .loading }
                    let picture = await request.load()
                    guard !Task.isCancelled else { return }
                    binaryPicture = picture
                    binaryPictureFile = request.file
                }
            }
        } else {
            VStack(spacing: 8) {
                Text("Not a text file")
                    .font(.headline)
                pathButton
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var content: some View {
        // A deleted or renamed file with unsaved edits keeps its draft on
        // screen (with the banner above), so it can still be read, copied or
        // saved back. Only a clean document shows the empty state.
        if model.showsMissingFile(doc) {
            VStack(spacing: 8) {
                Text("File is gone")
                    .font(.headline)
                pathButton
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if MarkdownPaneContent.showsBinary(doc, model: model) {
            binaryView
        } else if let revision = model.revisionView, revision.docID == doc.id {
            VStack(spacing: 0) {
                MarkdownRevisionBanner(revision: revision, doc: doc, model: model)
                revisionBody(revision)
            }
        } else {
            switch model.mode {
            case .source: sourceView(onTopLine: nil).onAppear { model.webProxy.web = nil }
            case .preview: previewView(doc.displayText, sync: syncLine)
            case .split: splitView
            case .changes: MarkdownChangesPane(doc: doc, model: model).onAppear { model.webProxy.web = nil }
            }
        }
    }

    /// Editor on the left, the rendered document on the right, divider dragged
    /// to taste and remembered. The preview lags the typing by a beat.
    private var splitView: some View {
        GeometryReader { geo in
            let total = geo.size.width
            HStack(spacing: 0) {
                // BOTH panes get a definite size from the geometry, never an
                // intrinsic one. An NSTextView and a WKWebView answer
                // `sizeThatFits` from their own content, so leaving either
                // dimension free lets the stack propose a width, get a content
                // height back, re-propose, and never settle — the layout
                // transaction that wedged the app on 2026-09-10 11:33 (79
                // minutes at 100% of a core, 5.9 GB, stuck in
                // `StackLayout.prioritize` → `PlatformViewLayoutEngine`).
                sourceView(onTopLine: follow)
                    .frame(
                        width: MarkdownSplit.editorWidth(total: total, ratio: model.splitRatio),
                        height: geo.size.height
                    )
                divider(total: total)
                previewView(live.text, sync: syncLine)
                    .frame(
                        width: MarkdownSplit.previewWidth(total: total, ratio: model.splitRatio),
                        height: geo.size.height
                    )
            }
        }
    }

    private func divider(total: CGFloat) -> some View {
        MarkdownSplitDivider(
            line: NSColor(model.theme.border),
            accent: NSColor(model.theme.accent),
            onBegin: { dragStartRatio = model.splitRatio },
            onDrag: { dx in
                guard MarkdownSplit.draggable(total: total) else { return }
                let start = dragStartRatio ?? model.splitRatio
                model.splitRatio = MarkdownSplit.ratio(afterMoving: dx, from: start, total: total)
            },
            onEnd: { dragStartRatio = nil },
            onReset: { model.splitRatio = MarkdownSplit.defaultRatio },
            onStep: { direction in
                guard MarkdownSplit.draggable(total: total) else { return }
                model.splitRatio = MarkdownSplit.ratio(
                    afterMoving: Double(direction) * MarkdownSplit.keyboardStep,
                    from: model.splitRatio,
                    total: total
                )
            },
            ratio: MarkdownSplit.editorWidth(total: total, ratio: model.splitRatio) / max(1, total)
        )
        .frame(width: MarkdownSplit.dividerWidth)
        .accessibilityIdentifier("markdown-split-divider")
    }

    @ViewBuilder
    private func previewView(_ markdown: String, sync: MarkdownLineSync? = nil) -> some View {
        // A json, csv, yaml or log tab is not markdown, and handing it to the renderer as-is
        // reflowed it into a paragraph of prose. Line sync goes with it: once the preview is a
        // reformatted document, it no longer has the editor's lines to scroll to.
        let native = DocumentPreview.presentation(for: doc.url) == .markdown
        let rendered = native ? markdown : DocumentPreview.markdown(for: doc.url, text: markdown)

        if model.renderer == .web {
            MarkdownWebView(
                markdown: rendered,
                scrollTarget: model.scrollTarget,
                highlightQuery: nil,
                highlightToken: 0,
                onWikilink: { model.follow($0, from: doc) },
                onActiveSection: { model.activeSectionSlug = $0 },
                onRelativeLink: { model.follow($0, from: doc) },
                findCommand: model.findCommand,
                onFindResult: { model.webFindResult(index: $0, count: $1) },
                onLinkHover: { previewLink($0) },
                zoom: model.zoom,
                proxy: leaving ? nil : model.webProxy,
                cssVariables: model.theme.cssVariables,
                // In split view the divider owns the width, so the page fills
                // its pane and its own column grips step aside.
                articleWidth: model.mode == .split || model.articleWidth <= 0 ? nil : model.articleWidth,
                onArticleWidth: { model.articleWidth = $0 },
                columnResizable: model.mode != .split,
                restoreScroll: model.scrollOffset(for: doc.id, pane: .preview),
                onScroll: { model.rememberScroll($0, for: doc.id, pane: .preview) },
                syncLine: native ? sync : nil,
                lineNumbers: !native && DocumentPreview.presentation(for: doc.url) != .table,
                lineHighlight: webHighlight,
                // Faded out by a click: gone until a new range is opened, also
                // when the page is rebuilt (a mode switch).
                onLineHighlightCleared: { model.lineHighlight = nil },
                gitMarks: gitMarks(native: native),
                onGitMark: { index, rect in
                    guard index < gutter.hunks.count, let web = model.webProxy.web else { return }
                    let hunk = gutter.hunks[index]
                    GitHunkPopover.show(hunk, source: attribution(hunk), at: rect, in: web) { revert(hunk) }
                },
                propertyVocabulary: { MarkdownVaultSuggestions.shared.propertyVocabularyJSON() },
                onProperties: { doc.edit(MarkdownFrontmatter.replacing(properties: $0, in: doc.displayText)) },
                onDropFiles: { model.acceptDrop($0) },
                documentURL: doc.url,
                vaultRoot: GenesisKit.host?.markdownVaultRoot
            )
        } else {
            MarkdownPreviewView(
                markdown: rendered,
                scrollTarget: model.scrollTarget,
                onWikilink: { model.follow($0, from: doc) },
                highlightQuery: nil,
                highlightToken: 0,
                rich: model.renderer == .nativeRich,
                zoom: model.zoom,
                theme: model.theme
            )
        }
    }

    /// `model.lineHighlight` in the page's terms. A markdown note's blocks carry
    /// 0-based body lines (frontmatter off), so every block whose source lines
    /// overlap the range is marked; a code, json or text file is numbered by its
    /// own lines; a CSV table has one row per file line.
    private var webHighlight: MarkdownWebView.LineHighlight? {
        guard let h = model.lineHighlight else { return nil }
        switch DocumentPreview.presentation(for: doc.url) {
        case .markdown:
            let offset = MarkdownFrontmatter.bodyLineOffset(in: doc.displayText)
            return .init(
                first: max(0, h.range.first - 1 - offset), last: max(0, h.range.last - 1 - offset),
                mode: .blocks, token: h.token
            )
        case .fenced:
            return .init(first: h.range.first, last: h.range.last, mode: .lines, token: h.token)
        case .table:
            return .init(first: h.range.first, last: h.range.last, mode: .rows, token: h.token)
        }
    }

    /// The source, editable. ⌘S writes it; the preview shows the draft too.
    private func sourceView(onTopLine: ((Int) -> Void)?) -> some View {
        MarkdownSourceEditor(
            text: Binding(get: { doc.displayText }, set: { doc.edit($0) }),
            font: .monospacedSystemFont(ofSize: 12 * model.zoom, weight: .regular),
            textColor: NSColor(model.theme.text),
            background: NSColor(model.theme.page),
            theme: model.theme,
            restoreScroll: model.scrollOffset(for: doc.id, pane: .source),
            onScroll: { model.rememberScroll($0, for: doc.id, pane: .source) },
            selection: model.sourceSelection,
            onSelectionChange: { model.editorSelectionChanged($0, byUser: $1, in: doc.id) },
            onTopLine: onTopLine,
            onOpenLink: { model.follow($0, from: doc) },
            completions: { MarkdownVaultSuggestions.shared.values(for: $0) },
            onDropFiles: { model.acceptDrop($0) },
            gitHunks: gutterShows ? gutter.hunks : [],
            onHunk: { hunk, rect, view in
                GitHunkPopover.show(hunk, source: attribution(hunk), at: rect, in: view) { revert(hunk) }
            }
        )
    }

    /// A past version, read-only: a note rendered (its properties block cannot be edited), any other file as text.
    @ViewBuilder
    private func revisionBody(_ revision: MarkdownRevision) -> some View {
        if DocumentPreview.presentation(for: doc.url) == .markdown && model.renderer == .web {
            MarkdownWebView(
                markdown: revision.text,
                scrollTarget: nil,
                highlightQuery: nil,
                highlightToken: 0,
                onWikilink: { model.follow($0, from: doc) },
                onActiveSection: { _ in },
                onRelativeLink: { model.follow($0, from: doc) },
                zoom: model.zoom,
                cssVariables: model.theme.cssVariables,
                articleWidth: model.articleWidth <= 0 ? nil : model.articleWidth,
                documentURL: doc.url,
                vaultRoot: GenesisKit.host?.markdownVaultRoot
            )
        } else {
            ScrollView {
                Text(verbatim: revision.text)
                    .font(.system(size: 12 * model.zoom, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        }
    }

    // MARK: Git gutter

    private var gutterShows: Bool { configuration.gitShows(\.gitGutter) }

    private func followGutter() {
        gutter.follow(gutterShows ? doc.url : nil, text: doc.displayText)
        blame.follow(gutterShows && configuration.gitShows(\.gitAgentAttribution) ? doc.url : nil)
    }

    /// The agent session that wrote a hunk's lines. The blame is of the file on disk, so a draft gets none.
    private func attribution(_ hunk: GitHunk) -> AgentBlameSource? {
        guard !doc.isDirty, hunk.kind != .deleted else { return nil }
        return blame.source(forLines: hunk.newLines)
    }

    /// The hunk's lines put back as HEAD had them, as one edit (undo takes it back).
    private func revert(_ hunk: GitHunk) {
        doc.edit(GitHunks.revert(hunk, in: doc.displayText))
    }

    /// The hunks in the page's terms: body lines, after the frontmatter. A change only inside the frontmatter has no
    /// block to mark.
    private func gitMarks(native: Bool) -> [MarkdownWebView.GitMark] {
        guard gutterShows, native, !gutter.hunks.isEmpty else { return [] }
        let offset = MarkdownFrontmatter.bodyLineOffset(in: doc.displayText)
        return gutter.hunks.enumerated().compactMap { index, hunk in
            let last = hunk.newStart + max(1, hunk.newCount) - 1 - offset
            guard hunk.kind == .deleted ? hunk.newStart >= offset : last >= 0 else { return nil }
            let first = max(0, hunk.newStart - offset)
            return MarkdownWebView.GitMark(first: first, last: max(first, last), kind: hunk.kind, index: index)
        }
    }

    /// The pointer on a link in the page: the note or file it points at previews next to the link, as a
    /// tab does. A web address, a heading in this note or a folder shows nothing.
    private func previewLink(_ hover: MarkdownLinkHover?) {
        let controller = MarkdownHoverPreviewController.shared
        guard let hover,
              let url = MarkdownHoverTarget.url(
                  forLink: hover.href, folder: doc.folder, text: doc.displayText, vaultRoot: GenesisKit.host?.markdownVaultRoot
              ),
              let web = model.webProxy.web,
              let anchor = MarkdownHoverPlacement.screenRect(ofTopLeft: hover.rect, in: web)
        else {
            controller.exit(owner: linkHoverOwner)
            return
        }
        controller.enter(owner: linkHoverOwner, url: url, model: model, view: web) { anchor }
    }

    /// The editor scrolled to `line` (counted over the whole file). The page
    /// counts lines over the body alone, so the frontmatter comes off first.
    private func follow(_ line: Int) {
        let body = max(0, line - MarkdownFrontmatter.bodyLineOffset(in: doc.displayText))
        syncLine = MarkdownLineSync(line: body, token: (syncLine?.token ?? 0) + 1)
    }
}
