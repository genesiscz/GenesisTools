import SwiftUI

/// The "cmux" block of a session's sidebar: where the session last ran (window, workspace, pane,
/// tab), then Focus, Open in last pane and Choose a pane…, with the target picker under them. The
/// app runs the actions (GenesisTools through its terminal host, Genesis through `MonitorModel`)
/// and says how they went through `notice`.
public struct CmuxSessionPanel: View {
    /// A status line under the actions.
    public struct Notice: Equatable {
        public var text: String
        public var isError: Bool

        public init(text: String, isError: Bool) {
            self.text = text
            self.isError = isError
        }
    }

    let sessionId: String
    let refs: [(label: String, value: String)]
    let tree: CmuxTree?
    let loading: Bool
    let busy: Bool
    let lastPane: CmuxTarget?
    @Binding var choosing: Bool
    @Binding var notice: Notice?
    var modeKey: String
    var modeStore: UserDefaults
    let focus: (() -> Void)?
    let open: (CmuxTarget) -> Void
    let reload: () -> Void

    /// `refs`: the journalled cmux refs ("window:1", "workspace:3", …); `focus` nil hides Focus.
    /// Focus also hides while the loaded tree has no tab for the session.
    public init(
        sessionId: String,
        window: String?,
        workspace: String?,
        pane: String?,
        surface: String?,
        tree: CmuxTree?,
        loading: Bool,
        busy: Bool,
        lastPane: CmuxTarget?,
        choosing: Binding<Bool>,
        notice: Binding<Notice?>,
        modeKey: String = CmuxTargetPicker.defaultModeKey,
        modeStore: UserDefaults = .standard,
        focus: (() -> Void)?,
        open: @escaping (CmuxTarget) -> Void,
        reload: @escaping () -> Void
    ) {
        self.sessionId = sessionId
        refs = Self.refs(window: window, workspace: workspace, pane: pane, surface: surface)
        self.tree = tree
        self.loading = loading
        self.busy = busy
        self.lastPane = lastPane
        _choosing = choosing
        _notice = notice
        self.modeKey = modeKey
        self.modeStore = modeStore
        self.focus = focus
        self.open = open
        self.reload = reload
    }

    /// "window:1" → ("window", "1"); a ref without a number stays whole; empty refs drop out.
    public static func refs(window: String?, workspace: String?, pane: String?, surface: String?) -> [(label: String, value: String)] {
        let named: [(String, String?)] = [("window", window), ("workspace", workspace), ("pane", pane), ("tab", surface)]
        return named.compactMap { label, ref in
            guard let ref, !ref.isEmpty else { return nil }
            let value = ref.split(separator: ":").last.map(String.init) ?? ref
            return (label, value)
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("cmux".uppercased())
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(KitPalette.dim)
            if !refs.isEmpty {
                refsGrid
            }
            VStack(alignment: .leading, spacing: 4) {
                if let focus, tree?.surface(of: sessionId) != nil {
                    GhostButton("Focus", symbol: "scope", tooltip: "Raise the tab this session runs in", fullWidth: true, height: 28, identifier: "cmux-focus", action: focus)
                }
                if let lastPane {
                    GhostButton("Open in last pane", symbol: "rectangle.portrait.and.arrow.right", tooltip: "Resume in the pane it last ran in, as a new tab", fullWidth: true, height: 28, identifier: "cmux-open-last-pane") {
                        open(lastPane)
                    }
                }
                GhostButton(
                    choosing ? "Hide targets" : "Choose a pane…",
                    symbol: "square.grid.2x2",
                    tooltip: "Pick a window, workspace, pane or tab to resume this session in",
                    trailingSymbol: choosing ? "chevron.up" : "chevron.down",
                    fullWidth: true,
                    height: 28,
                    identifier: "cmux-targets"
                ) {
                    choosing.toggle()
                }
            }
            if let current = notice {
                NoticePill(text: current.text, isError: current.isError) { notice = nil }
            }
            if choosing {
                CmuxTargetPicker(tree: tree, loading: loading, highlightSession: sessionId, modeKey: modeKey, modeStore: modeStore, reload: reload, onPick: open)
                    .padding(.top, 2)
            }
        }
        .disabled(busy)
    }

    /// One labelled value per cell, two per row: as one "window:1 · workspace:1 · …" line it
    /// wrapped mid-ref in a narrow sidebar.
    private var refsGrid: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 3) {
            ForEach(Array(stride(from: 0, to: refs.count, by: 2)), id: \.self) { index in
                GridRow {
                    refCell(refs[index])
                    if index + 1 < refs.count {
                        refCell(refs[index + 1])
                    }
                }
            }
        }
        .textSelection(.enabled)
    }

    private func refCell(_ ref: (label: String, value: String)) -> some View {
        HStack(spacing: 5) {
            Text(verbatim: ref.label)
                .font(.system(size: 10.5))
                .foregroundColor(KitPalette.faint)
            Text(verbatim: ref.value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Color.white.opacity(0.8))
        }
        .fixedSize()
        .instantTooltip("\(ref.label) \(ref.value) in cmux")
    }
}
