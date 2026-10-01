import AppKit
import SwiftUI

/// Where to open something in cmux, as a tree (window, workspace, pane, tab, each saying what a
/// click creates) or as the real layout (pane rectangles where cmux draws them). With `selection`
/// it only marks the choice (a launch sheet confirms); without it a click opens right away through
/// `onPick`. The app loads the tree (`tools ai cmux tree --json`) and passes it in.
public struct CmuxTargetPicker: View {
    /// The Tree / Layout choice, shared by every picker that uses the same key.
    public static let defaultModeKey = "cmux.picker.mode"

    let tree: CmuxTree?
    let loading: Bool
    var selection: CmuxTarget?
    var highlightSession: String?
    let reload: () -> Void
    let onPick: (CmuxTarget) -> Void

    @AppStorage private var mode: String
    @State private var layoutOpen = false

    public init(
        tree: CmuxTree?,
        loading: Bool,
        selection: CmuxTarget? = nil,
        highlightSession: String? = nil,
        modeKey: String = CmuxTargetPicker.defaultModeKey,
        modeStore: UserDefaults = .standard,
        reload: @escaping () -> Void,
        onPick: @escaping (CmuxTarget) -> Void
    ) {
        self.tree = tree
        self.loading = loading
        self.selection = selection
        self.highlightSession = highlightSession
        self.reload = reload
        self.onPick = onPick
        _mode = AppStorage(wrappedValue: "tree", modeKey, store: modeStore)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Picker("", selection: $mode) {
                    Text("Tree").tag("tree")
                    Text("Layout").tag("layout")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 130)
                .instantTooltip("Tree: every window, workspace, pane and tab. Layout: the panes where cmux draws them")
                IconButton(systemName: "arrow.up.left.and.arrow.down.right", tooltip: "Open the layout in a large popover") {
                    layoutOpen = true
                }
                .popover(isPresented: $layoutOpen, arrowEdge: .leading) {
                    ScrollView {
                        CmuxLayoutView(tree: tree, selection: selection, highlightSession: highlightSession) { target in
                            onPick(target)
                            layoutOpen = false
                        }
                        .padding(14)
                    }
                    .frame(width: 800, height: 600)
                    .background(Color(nsColor: KitPalette.background))
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Reload the cmux layout", action: reload)
                if loading {
                    ProgressView().controlSize(.mini)
                }
            }
            if let tree, !tree.available {
                Text(verbatim: tree.error ?? "cmux is not reachable")
                    .font(.system(size: 11))
                    .foregroundColor(KitPalette.removed)
            } else if tree == nil {
                Text(loading ? "Loading the cmux layout…" : "No cmux layout yet")
                    .font(.system(size: 11))
                    .foregroundColor(KitPalette.dim)
            } else if mode == "layout" {
                CmuxLayoutView(tree: tree, selection: selection, highlightSession: highlightSession, onPick: onPick)
            } else {
                CmuxTreeList(tree: tree, selection: selection, highlightSession: highlightSession, onPick: onPick)
            }
        }
    }
}

/// The tree: each level says what a click creates.
public struct CmuxTreeList: View {
    let tree: CmuxTree?
    let selection: CmuxTarget?
    let highlightSession: String?
    let onPick: (CmuxTarget) -> Void

    public init(tree: CmuxTree?, selection: CmuxTarget? = nil, highlightSession: String? = nil, onPick: @escaping (CmuxTarget) -> Void) {
        self.tree = tree
        self.selection = selection
        self.highlightSession = highlightSession
        self.onPick = onPick
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(tree?.windows ?? []) { window in
                row(.newWorkspace(window: window.target), indent: 0, label: window.label, hint: "new workspace", symbol: "macwindow")
                ForEach(window.workspaces) { workspace in
                    row(.newPane(workspace: workspace.id), indent: 1, label: workspace.name, hint: "new pane", symbol: "rectangle.split.2x1")
                    ForEach(workspace.panes) { pane in
                        row(.newTab(workspace: workspace.id, pane: pane.id), indent: 2, label: pane.id, hint: "new tab", symbol: "plus.square")
                        ForEach(pane.surfaces) { surface in
                            row(.surface(workspace: workspace.id, surface: surface.id), indent: 3, label: surface.title, hint: "type here", symbol: "terminal", surface: surface)
                        }
                    }
                }
            }
        }
    }

    private func row(_ target: CmuxTarget, indent: Int, label: String, hint: String, symbol: String, surface: CmuxTree.Surface? = nil) -> some View {
        let chosen = selection == target
        let mine = highlightSession.map { id in surface?.holds(id) ?? false } ?? false
        // The row button's hover fill is the row's own frame, the same box as the chosen fill. The
        // indent is inside the row, so a nested row still highlights across the list's width.
        return HStack(spacing: 6) {
            Color.clear.frame(width: CGFloat(indent) * 12, height: 1)
            Image(systemName: symbol).font(.system(size: 10)).foregroundColor(KitPalette.dim).frame(width: 14)
            if let provider = surface?.provider {
                ProviderBadge(provider: provider, size: 12, tooltip: "\(provider) session \(surface?.sessionId?.prefix(8) ?? "")")
            }
            Text(verbatim: label)
                .font(.system(size: 11, weight: indent < 2 ? .semibold : .regular, design: indent == 2 ? .monospaced : .default))
                .foregroundColor(mine ? Color.accentColor : Color.white.opacity(indent == 3 ? 0.8 : 0.9))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            Text(verbatim: mine ? "this session" : hint)
                .font(.system(size: 10))
                .foregroundColor(chosen || mine ? Color.accentColor : KitPalette.faint)
                .fixedSize()
        }
        .padding(.horizontal, 8)
        .frame(height: 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(chosen ? Color.accentColor.opacity(0.18) : Color.clear))
        .rowButton(cornerRadius: 6) { onPick(target) }
        .instantTooltip("Open in \(target.label)")
    }
}

/// Each workspace drawn as cmux lays it out: pane rectangles from their frames, their tabs on top.
/// Click a pane's + for a new tab, a tab to type into it, the workspace title for a new pane, the
/// window title for a new workspace. The drawing takes the width it is given and never asks for
/// more, so it fits a narrow sidebar as well as a large popover.
public struct CmuxLayoutView: View {
    let tree: CmuxTree?
    let selection: CmuxTarget?
    let highlightSession: String?
    let onPick: (CmuxTarget) -> Void
    @State private var width: CGFloat = 0

    public init(tree: CmuxTree?, selection: CmuxTarget? = nil, highlightSession: String? = nil, onPick: @escaping (CmuxTarget) -> Void) {
        self.tree = tree
        self.selection = selection
        self.highlightSession = highlightSession
        self.onPick = onPick
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(tree?.windows ?? []) { window in
                Button { onPick(.newWorkspace(window: window.target)) } label: {
                    Label(window.label + (window.key ? " (front)" : ""), systemImage: "macwindow")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(KitPalette.text)
                        .lineLimit(1)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Open in a new workspace in \(window.label)")
                ForEach(window.workspaces) { workspace in
                    workspaceView(workspace)
                }
            }
        }
        // The width comes from the parent, not from the panes: a fixed drawing width pushed a narrow
        // sidebar wider than its panel (2026-09-30).
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
    }

    private struct Placed: Identifiable {
        let pane: CmuxTree.Pane
        let frame: CmuxTree.Frame
        var id: String { pane.id }
    }

    /// The scale that fits a workspace's panes into `width`, and the drawing's height.
    static func fit(_ frames: [CmuxTree.Frame], width: CGFloat) -> (scale: CGFloat, height: CGFloat, minX: Double, minY: Double) {
        let minX = frames.map(\.x).min() ?? 0
        let minY = frames.map(\.y).min() ?? 0
        let maxX = frames.map { $0.x + $0.width }.max() ?? 1
        let maxY = frames.map { $0.y + $0.height }.max() ?? 1
        let scale = max(width, 0) / max(maxX - minX, 1)
        return (scale, max((maxY - minY) * scale, 40), minX, minY)
    }

    private func workspaceView(_ workspace: CmuxTree.Workspace) -> some View {
        let placed = workspace.panes.compactMap { pane in pane.frame.map { Placed(pane: pane, frame: $0) } }
        let fit = Self.fit(placed.map(\.frame), width: width)
        return VStack(alignment: .leading, spacing: 4) {
            Button { onPick(.newPane(workspace: workspace.id)) } label: {
                HStack(spacing: 5) {
                    Image(systemName: "rectangle.split.2x1").font(.system(size: 10))
                    Text(verbatim: workspace.name).font(.system(size: 11, weight: .medium)).lineLimit(1).truncationMode(.middle)
                }
                .foregroundColor(KitPalette.dim)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Split: a new pane in \(workspace.name)")
            if placed.isEmpty {
                Text("No pane positions from cmux: use Tree")
                    .font(.system(size: 10.5))
                    .foregroundColor(KitPalette.faint)
            } else {
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35))
                    ForEach(placed) { item in
                        paneView(item.pane, workspace: workspace)
                            .frame(width: max(item.frame.width * fit.scale - 3, 10), height: max(item.frame.height * fit.scale - 3, 10))
                            .offset(x: (item.frame.x - fit.minX) * fit.scale + 1.5, y: (item.frame.y - fit.minY) * fit.scale + 1.5)
                    }
                }
                .frame(width: width, height: fit.height, alignment: .topLeading)
                .clipped()
            }
        }
    }

    private func paneView(_ pane: CmuxTree.Pane, workspace: CmuxTree.Workspace) -> some View {
        let paneTarget = CmuxTarget.newTab(workspace: workspace.id, pane: pane.id)
        let hasMine = highlightSession.map { id in pane.surfaces.contains { $0.holds(id) } } ?? false
        // The pane is a container, not a button: a surface button inside a pane button left VoiceOver
        // and the keyboard unable to tell "type into this surface" from "new tab in this pane".
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(pane.surfaces) { surface in
                let target = CmuxTarget.surface(workspace: workspace.id, surface: surface.id)
                Button { onPick(target) } label: {
                    HStack(spacing: 3) {
                        if let provider = surface.provider {
                            Text(verbatim: ProviderBadge.style(for: provider).letter).font(.system(size: 8, weight: .bold))
                        }
                        Text(verbatim: surface.title).font(.system(size: 9.5)).lineLimit(1).truncationMode(.middle)
                    }
                    .foregroundColor(surface.selected ? Color.white : KitPalette.dim)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 3).fill(selection == target ? Color.accentColor.opacity(0.35) : Color.white.opacity(surface.selected ? 0.12 : 0.05)))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Type into \(surface.title)")
            }
            Spacer(minLength: 0)
        }
        // Room for the new-tab button in the top-right corner.
        .padding(.trailing, 16)
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(selection == paneTarget ? Color.accentColor.opacity(0.18) : Color.white.opacity(pane.active ? 0.07 : 0.03))
        )
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(hasMine ? Color.accentColor : Color.white.opacity(0.12), lineWidth: hasMine ? 1.5 : 1))
        .overlay(alignment: .topTrailing) {
            IconButton(systemName: "plus.rectangle", tooltip: "New tab in \(pane.id)", size: 10) { onPick(paneTarget) }
                .padding(2)
        }
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Pane \(pane.id)"))
    }
}
