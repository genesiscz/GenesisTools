import AppKit
import SwiftUI

/// The three kinds of target the picker offers, one tab each.
public enum RecordingPickerTab: String, CaseIterable, Hashable, Sendable {
    case windows, apps, displays

    public var title: String {
        switch self {
        case .windows: return "Windows"
        case .apps: return "Apps"
        case .displays: return "Displays"
        }
    }

    static func of(_ target: RecordingTarget?) -> RecordingPickerTab {
        switch target {
        case .app: return .apps
        case .display: return .displays
        default: return .windows
        }
    }
}

/// One line of the picker: an app header over its windows, or a target that a click records.
struct RecordingPickerRow: Identifiable, Equatable {
    enum Kind: Equatable {
        case header
        case target(RecordingTarget)
    }

    let id: String
    let kind: Kind
    let title: String
    let detail: String
    let pid: Int32?
    let symbol: String
    var badge: String?

    var target: RecordingTarget? {
        if case let .target(target) = kind { return target }
        return nil
    }

    /// The rows of one tab: windows grouped under their app in the order the apps' front windows stand, apps, or
    /// displays. `query` keeps the windows whose title or app contains it (apps by name).
    static func rows(_ targets: RecordingTargets, tab: RecordingPickerTab, query: String) -> [RecordingPickerRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        func matches(_ values: String...) -> Bool {
            needle.isEmpty || values.contains { $0.localizedCaseInsensitiveContains(needle) }
        }
        switch tab {
        case .windows:
            var order: [Int32] = []
            var byApp: [Int32: [RecordingWindow]] = [:]
            for window in targets.windows where matches(window.title, window.app) {
                if byApp[window.pid] == nil { order.append(window.pid) }
                byApp[window.pid, default: []].append(window)
            }
            return order.flatMap { pid -> [RecordingPickerRow] in
                let windows = byApp[pid] ?? []
                let header = RecordingPickerRow(
                    id: "app-\(pid)", kind: .header, title: windows.first?.app ?? "App",
                    detail: Plural.count(windows.count, "window"), pid: pid, symbol: "app")
                return [header] + windows.map { window in
                    RecordingPickerRow(
                        id: "window-\(window.id)", kind: .target(window.target),
                        title: window.title.isEmpty ? "Untitled window" : window.title,
                        detail: "\(Int(window.bounds.width)) × \(Int(window.bounds.height))",
                        pid: nil, symbol: "macwindow")
                }
            }
        case .apps:
            return targets.apps.filter { matches($0.name) }.map { app in
                RecordingPickerRow(id: "apps-\(app.pid)", kind: .target(app.target), title: app.name,
                                   detail: Plural.count(app.windowCount, "window"), pid: app.pid, symbol: "app")
            }
        case .displays:
            return targets.displays.filter { matches($0.name) }.map { display in
                RecordingPickerRow(id: "display-\(display.index)", kind: .target(display.target), title: display.name,
                                   detail: "\(Int(display.width)) × \(Int(display.height))", pid: nil, symbol: "display",
                                   badge: display.isPrimary ? "Main" : nil)
            }
        }
    }
}

/// Lets the person pick what to record: one window (grouped by app, with titles), every window of an app, or a whole
/// display. Starts on `initial` (the front window of the app the person was in). ↑ ↓ move, Return records, Esc
/// cancels; a click on a row records it. Values and closures only.
public struct RecordingTargetPicker: View {
    public enum Load: Equatable {
        case loading
        case failed(String)
        case loaded(RecordingTargets)
    }

    private let load: Load
    private let title: String
    private let initial: RecordingTarget?
    private let onChoose: (RecordingTarget) -> Void
    private let onCancel: () -> Void
    private let onRetry: () -> Void
    @State private var tab: RecordingPickerTab
    @State private var query = ""
    @State private var highlighted: String?
    @FocusState private var filterFocused: Bool

    public init(load: Load, title: String = "Choose what to record", initial: RecordingTarget?,
                onChoose: @escaping (RecordingTarget) -> Void, onCancel: @escaping () -> Void,
                onRetry: @escaping () -> Void = {}) {
        self.load = load
        self.title = title
        self.initial = initial
        self.onChoose = onChoose
        self.onCancel = onCancel
        self.onRetry = onRetry
        _tab = State(initialValue: RecordingPickerTab.of(initial))
    }

    private var rows: [RecordingPickerRow] {
        guard case let .loaded(targets) = load else { return [] }
        return RecordingPickerRow.rows(targets, tab: tab, query: query)
    }

    private var targetRows: [RecordingPickerRow] { rows.filter { $0.target != nil } }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            GenSegmentedTabs("What to record", items: RecordingPickerTab.allCases.map { .init($0, $0.title) },
                             selection: $tab, minSegmentWidth: 114, identifier: "recording.picker.tabs")
            filterField
            content
            footer
        }
        .padding(14)
        .frame(width: 380)
        .modifier(NativeGlassShapeSurface(shape: RoundedRectangle(cornerRadius: 16, style: .continuous)))
        .environment(\.colorScheme, .dark)
        .onAppear {
            highlight(initial: true)
            filterFocused = true
        }
        .onChange(of: load) { _, _ in highlight(initial: true) }
        .onChange(of: tab) { _, _ in highlight(initial: false) }
        .onChange(of: query) { _, _ in highlight(initial: false) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "record.circle").font(.system(size: 14, weight: .semibold)).foregroundStyle(.red)
            Text(title).font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
            IconButton(systemName: "xmark", tooltip: "Cancel (Esc)", size: 10, action: onCancel)
                .accessibilityIdentifier("recording.picker.cancel")
        }
    }

    private var filterField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(.secondary)
            TextField("Filter \(tab.title.lowercased())", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($filterFocused)
                .onSubmit(chooseHighlighted)
                .onExitCommand(perform: onCancel)
                .onKeyPress(.escape) {
                    onCancel()
                    return .handled
                }
                .onKeyPress(.downArrow) {
                    move(1)
                    return .handled
                }
                .onKeyPress(.upArrow) {
                    move(-1)
                    return .handled
                }
                .accessibilityIdentifier("recording.picker.filter")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @ViewBuilder private var content: some View {
        switch load {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Looking for windows and displays…").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 120)
        case let .failed(message):
            VStack(spacing: 8) {
                Text(message).font(.system(size: 12)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                Button("Try again", action: onRetry).buttonStyle(.genHover())
            }
            .frame(maxWidth: .infinity, minHeight: 120)
        case .loaded:
            if rows.isEmpty {
                Text(query.isEmpty ? "Nothing to record here." : "Nothing matches “\(query)”.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollViewReader { proxy in
                    FittedScroll(maxHeight: 330) {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(rows) { row in
                                rowView(row).id(row.id)
                            }
                        }
                    }
                    .onChange(of: highlighted) { _, id in
                        guard let id else { return }
                        proxy.scrollTo(id)
                    }
                }
            }
        }
    }

    @ViewBuilder private func rowView(_ row: RecordingPickerRow) -> some View {
        if let target = row.target {
            let isHighlighted = highlighted == row.id
            Button {
                onChoose(target)
            } label: {
                HStack(spacing: 8) {
                    icon(row).frame(width: 18, height: 18)
                    Text(row.title).font(.system(size: 12, weight: isHighlighted ? .semibold : .regular))
                        .lineLimit(1).truncationMode(.middle)
                    if let badge = row.badge {
                        Text(badge).font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.white.opacity(0.12), in: Capsule())
                    }
                    Spacer(minLength: 8)
                    Text(verbatim: row.detail).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(.secondary)
                }
                .padding(.leading, row.symbol == "macwindow" ? 22 : 6)
                .padding(.trailing, 8)
                .frame(height: 28)
                .background(isHighlighted ? Color.accentColor.opacity(0.32) : .clear,
                            in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .onHover { inside in
                if inside { highlighted = row.id }
            }
            .accessibilityLabel("Record \(row.title)")
            .accessibilityIdentifier("recording.picker.\(row.id)")
            .frameProbe("recording.picker.\(row.id)")
        } else {
            HStack(spacing: 6) {
                icon(row).frame(width: 14, height: 14)
                Text(row.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                Text(verbatim: row.detail).font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 6)
            .padding(.top, 6)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
        }
    }

    @ViewBuilder private func icon(_ row: RecordingPickerRow) -> some View {
        if let image = RecordingAppIcon.image(pid: row.pid) {
            Image(nsImage: image).resizable().interpolation(.high)
        } else {
            Image(systemName: row.symbol).font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Text("↑ ↓ to choose · Return records · Esc cancels")
            Spacer(minLength: 0)
        }
        .font(.system(size: 10))
        .foregroundStyle(.tertiary)
    }

    private func highlight(initial useInitial: Bool) {
        let candidates = targetRows
        if useInitial, let initial, let row = candidates.first(where: { $0.target == initial }) {
            highlighted = row.id
        } else if let current = highlighted, candidates.contains(where: { $0.id == current }) {
            return
        } else {
            highlighted = candidates.first?.id
        }
    }

    private func move(_ step: Int) {
        let candidates = targetRows
        guard !candidates.isEmpty else { return }
        let index = candidates.firstIndex { $0.id == highlighted } ?? -1
        highlighted = candidates[min(max(index + step, 0), candidates.count - 1)].id
    }

    private func chooseHighlighted() {
        guard let row = targetRows.first(where: { $0.id == highlighted }) ?? targetRows.first,
              let target = row.target else { return }
        onChoose(target)
    }
}
