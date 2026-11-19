import AppKit
import SwiftUI

enum WorkNotifyWords {
    static let actions = ["spotted", "accepted", "claimed", "finished", "reopened", "reopen-undelivered",
                          "dropped", "commented", "sync-held", "sync-failed"]
    private struct Level {
        let token: String
        let name: String
        let detail: String
        let symbol: String
        let color: Color
    }
    private static let choices = [
        Level(token: "off", name: "Nobody", detail: "Nobody hears about it.", symbol: "bell.slash", color: KitPalette.dim),
        Level(token: "list", name: "In the list", detail: "It shows in the Work list only.", symbol: "list.bullet", color: KitPalette.dim),
        Level(token: "inbox", name: "Inbox line", detail: "A quiet line in your inbox.", symbol: "tray", color: KitHue.play.ink),
        Level(token: "banner", name: "Inbox and banner", detail: "An inbox line with a notification banner.", symbol: "bell.badge", color: KitHue.care.ink),
    ]
    static let levels = choices.map(\.token)
    private static func choice(_ token: String) -> Level { choices.first { $0.token == token } ?? choices[1] }

    static func action(_ token: String) -> String {
        switch token {
        case "spotted": return "Spotted"
        case "accepted": return "Accepted"
        case "claimed": return "Claimed"
        case "finished": return "Finished"
        case "reopened": return "Reopened"
        case "reopen-undelivered": return "Reopen not delivered"
        case "dropped": return "Dropped"
        case "commented": return "Commented"
        case "sync-held": return "Sync held"
        case "sync-failed": return "Sync failed"
        default: return "Change"
        }
    }

    static func type(_ token: String) -> String {
        switch token {
        case "epic": return "Epic"
        case "handoff": return "Handoff"
        case "feature": return "Feature"
        case "bug": return "Bug"
        case "incident": return "Incident"
        case "task": return "Task"
        case "test": return "Test"
        case "cleanup": return "Clean-up"
        case "check": return "Check"
        case "idea": return "Idea"
        case "risk": return "Risk"
        case "limit": return "Limit"
        case "todo": return "To-do"
        default: return "Work item"
        }
    }

    static func level(_ token: String) -> String { choice(token).name }
    static func detail(_ token: String) -> String { choice(token).detail }
    static func symbol(_ token: String) -> String { choice(token).symbol }
    static func color(_ token: String) -> Color { choice(token).color }

    static func layer(_ token: String) -> String {
        switch token {
        case "config.global": return "All projects"
        case "config.repo": return "This repository's file"
        case "config.project": return "This project"
        default: return "Built in"
        }
    }

    static func filtered(_ rows: [WorkNotifyRow], query: String) -> [WorkNotifyRow] {
        let words = query.split(whereSeparator: \.isWhitespace)
        return rows.filter { row in
            words.allSatisfy { type(row.type).localizedStandardContains(String($0)) }
        }
    }

    static func tooltip(type: String, cell: WorkNotifyCell, level: String, pending: Bool) -> String {
        var lines = ["\(Self.type(type)), \(action(cell.action)). \(Self.level(level)): \(detail(level))",
                     "Set by \(layer(cell.from).lowercased())."]
        if let threshold = cell.minSeverity { lines.append("Only \(threshold.replacingOccurrences(of: "-", with: " ")) and above.") }
        if pending { lines.append("Saving this change.") }
        if !cell.writable { lines.append("Set in the repository file. Open the file to change it.") }
        for entry in cell.layers {
            let value = entry.level.map(Self.level) ?? "Not set"
            lines.append("\(layer(entry.layer)): \(value)\(entry.wildcard ? " (rule for several changes)" : "").")
        }
        return lines.joined(separator: "\n")
    }
}

/// The production menu builder is also the semantic test door. A test can invoke an entry's action without a window.
enum WorkNotifyMenu {
    struct Target {
        var type: String
        var action: String
        var cells: [WorkNotifyCell]
        var cell: WorkNotifyCell? { type != "*" && action != "*" ? cells.first : nil }
    }

    static func items(target: Target, scope: WorkNotifyScope, enabled: Bool, busy: Bool = false,
                      chooseScope: @escaping (WorkNotifyScope) -> Void,
                      apply: @escaping (WorkNotifyScope, String, String, String?) -> Void) -> [MenuButtonItem] {
        let id = "work-notify-menu-\(target.type)-\(target.action)"
        if let cell = target.cell, !cell.writable {
            var items: [MenuButtonItem] = [.note("Set in \(cell.repoPath.map(PathDisplay.tilde) ?? "this repository's file")")]
            if let file = cell.repoPath {
                items.append(.action("Open the file", systemImage: "doc.text", identifier: id + "-file") { PathOpener.primary(file) })
            }
            return items
        }
        let writable = target.cells.contains(where: \.writable)
        let current = Set(target.cells.map(\.level))
        var items: [MenuButtonItem] = WorkNotifyWords.levels.map { level in
            .action(WorkNotifyWords.level(level), checked: current == [level], enabled: enabled && !busy && writable,
                    systemImage: WorkNotifyWords.symbol(level), tint: NSColor(WorkNotifyWords.color(level)), identifier: id + "-" + level) {
                apply(scope, target.type, target.action, level)
            }
        }
        items.append(.divider)
        if let cell = target.cell {
            let decidingScope: WorkNotifyScope = cell.from == "config.global" ? .global : .project
            let wildcard = cell.layers.contains { $0.layer == cell.from && $0.wildcard }
            let inherited = cell.inheriting(decidingScope)
            let resetTitle = inherited.layer == "default"
                ? "Use the built-in level (\(WorkNotifyWords.level(inherited.level)))"
                : "Use inherited level (\(WorkNotifyWords.level(inherited.level)), from \(WorkNotifyWords.layer(inherited.layer).lowercased()))"
            items.append(.action(resetTitle,
                                 enabled: enabled && !busy && cell.from != "default" && !wildcard,
                                 systemImage: "arrow.uturn.backward", identifier: id + "-reset") {
                apply(decidingScope, target.type, target.action, nil)
            })
            if wildcard { items.append(.note("This level comes from a rule for several changes.")) }
        } else {
            items.append(.action("Use inherited levels", enabled: enabled && !busy && writable,
                                 systemImage: "arrow.uturn.backward", identifier: id + "-reset") {
                apply(scope, target.type, target.action, nil)
            })
        }
        if target.cells.contains(where: { !$0.writable }) {
            items.append(.note("Rules set in the repository file stay unchanged."))
        }
        items += [.divider,
                  .action("For this project", checked: scope == .project, systemImage: "folder", identifier: id + "-project") { chooseScope(.project) },
                  .action("For all projects", checked: scope == .global, systemImage: "square.stack", identifier: id + "-global") { chooseScope(.global) }]
        if !enabled { items.append(.note("Changes need the GenesisTools service; it is not running.")) }
        if busy { items.append(.note("Saving the previous change.")) }
        return items
    }

}

/// The outer Work screen presents this directly, outside its Items scroll view.
public struct WorkNotifyPane: View {
    @ObservedObject private var screen: WorkScreenModel
    public init(screen: WorkScreenModel) { self.screen = screen }

    public var body: some View {
        Group {
            if let failure = screen.failure {
                FailureInline(.unexpected(failure, outcome: "The notification rules did not load", action: "Read the rules"),
                              identifier: "work-notify-failure") { screen.reload() }
            } else if !screen.notifyLoaded {
                ProgressView("Reading notification rules")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("work-notify-loading")
            } else {
                WorkNotifyGridView(project: screen.project ?? "", rows: screen.notifyRows,
                                   pending: screen.notifyPending, command: screen.notifyCommand,
                                   serviceAvailable: serviceAvailable) { scope, type, action, level in
                    Task { await screen.setNotify(scope: scope, type: type, action: action, level: level) }
                }
            }
        }
    }

    private var serviceAvailable: Bool {
        if case .stopped = screen.live { return false }
        return true
    }
}

public struct WorkNotifyGridView: View {
    let project: String
    let rows: [WorkNotifyRow]
    let pending: [String: String]
    let command: String?
    let serviceAvailable: Bool
    let apply: ((WorkNotifyScope, String, String, String?) -> Void)?
    @State private var crosshair = WorkNotifyCrosshair()
    @State private var filter = ""
    @State private var commandOpen = false
    @FocusState private var filterFocused: Bool

    public init(project: String, rows: [WorkNotifyRow]) {
        self.project = project; self.rows = rows; pending = [:]; command = nil
        serviceAvailable = false; apply = nil
    }

    public init(project: String, rows: [WorkNotifyRow], pending: [String: String], command: String?,
                serviceAvailable: Bool, apply: @escaping (WorkNotifyScope, String, String, String?) -> Void) {
        self.project = project; self.rows = rows; self.pending = pending; self.command = command
        self.serviceAvailable = serviceAvailable; self.apply = apply
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                let explanation = apply == nil ? "Who hears about each change to this project's work."
                    : "Who hears about each change to this project's work. Click a cell to change it."
                let inherited = " Every cell uses the built-in level."
                let allBuiltIn = !rows.isEmpty && rows.allSatisfy { $0.cells.allSatisfy { $0.from == "default" } }
                // Keep the grid's top edge when the last override is added or removed.
                Text(explanation + inherited).hidden().accessibilityHidden(true)
                    .overlay(alignment: .topLeading) { Text(explanation + (allBuiltIn ? inherited : "")) }
                    .font(.system(size: 12)).foregroundStyle(KitPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Image(systemName: "line.3.horizontal.decrease").foregroundStyle(KitPalette.dim).accessibilityHidden(true)
                    TextField("Filter types", text: $filter)
                        .textFieldStyle(.plain).font(.system(size: 12))
                        .focused($filterFocused)
                        .accessibilityLabel("Filter notification types")
                        .accessibilityIdentifier("work-notify-filter")
                        .onExitCommand { filter = "" }
                    if !filter.isEmpty {
                        IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the type filter") { filter = "" }
                            .accessibilityIdentifier("work-notify-filter-clear")
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))
                .frame(maxWidth: 300)
                .contentShape(Rectangle())
                .onTapGesture { filterFocused = true }
            }
            .padding(.horizontal, 16).padding(.top, 14)
            WorkNotifyFrozenGrid(rows: WorkNotifyWords.filtered(rows, query: filter), allRows: rows, pending: pending,
                                 enabled: serviceAvailable, apply: apply, crosshair: crosshair)
            footer.padding(.horizontal, 16).padding(.bottom, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityIdentifier("work-notify-grid")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 18) { legend }
                VStack(alignment: .leading, spacing: 7) { legend }
            }
            GenDisclosure("Command line", isExpanded: $commandOpen, identifier: "work-notify-command") {
                if let command {
                    HStack(alignment: .top, spacing: 10) {
                        Text(verbatim: command).font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        CopyChip(label: "Copy", value: command, tooltip: "Copy the last notification command", what: "command")
                            .accessibilityIdentifier("work-notify-command-copy")
                    }
                } else {
                    Text("Change a notification level to see its command here.")
                        .font(.system(size: 11)).foregroundStyle(KitPalette.dim)
                }
            }
        }
    }

    private var legend: some View {
        ForEach(WorkNotifyWords.levels, id: \.self) { level in
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: WorkNotifyWords.symbol(level)).foregroundStyle(WorkNotifyWords.color(level))
                    .frame(width: 16).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(WorkNotifyWords.level(level)).font(.system(size: 11, weight: .medium))
                    Text(WorkNotifyWords.detail(level)).font(.system(size: 11)).foregroundStyle(KitPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

private enum WorkNotifyMetrics {
    static let typeWidth: CGFloat = 128
    static let cellWidth: CGFloat = 94
    static let rowHeight: CGFloat = 32
    static let headerHeight: CGFloat = 54

    static func visibleHeight(rows: Int, origin: CGFloat, viewport: CGFloat) -> CGFloat {
        min(viewport, max(headerHeight, headerHeight + CGFloat(rows) * rowHeight + origin))
    }
}

struct WorkNotifyCoordinate: Equatable {
    var type: String?
    var action: String?

    func moved(_ key: KeyEquivalent, rows: [WorkNotifyRow], actions: [String]) -> Self? {
        guard !rows.isEmpty, !actions.isEmpty else { return nil }
        var row = type.flatMap { type in rows.firstIndex { $0.type == type } } ?? -1
        var column = action.flatMap { actions.firstIndex(of: $0) } ?? -1
        switch key {
        case .leftArrow: column = max(-1, column - 1)
        case .rightArrow: column = min(actions.count - 1, column + 1)
        case .upArrow: row = max(-1, row - 1)
        case .downArrow: row = min(rows.count - 1, row + 1)
        default: return nil
        }
        guard row >= 0 || column >= 0 else { return self }
        return .init(type: row >= 0 ? rows[row].type : nil, action: column >= 0 ? actions[column] : nil)
    }
}

final class WorkNotifyCrosshair: ObservableObject {
    @Published var hover: WorkNotifyCoordinate?
    @Published var focus: WorkNotifyCoordinate?
    func hover(_ target: WorkNotifyCoordinate, inside: Bool) {
        let next = inside ? target : (hover == target ? nil : hover)
        if hover != next { hover = next }
    }
}

private struct WorkNotifyOriginKey: PreferenceKey {
    static var defaultValue: CGPoint = .zero
    static func reduce(value: inout CGPoint, nextValue: () -> CGPoint) { value = nextValue() }
}

private final class WorkNotifyHost {
    weak var view: NSView?
}

private struct WorkNotifyHostReader: NSViewRepresentable {
    let host: WorkNotifyHost
    func makeNSView(context: Context) -> NSView {
        let view = NSView(); host.view = view; return view
    }
    func updateNSView(_ view: NSView, context: Context) { host.view = view }
}

struct WorkNotifyFrozenGrid: View {
    let rows: [WorkNotifyRow]
    let allRows: [WorkNotifyRow]
    let pending: [String: String]
    let enabled: Bool
    let apply: ((WorkNotifyScope, String, String, String?) -> Void)?
    @State private var scope: WorkNotifyScope = .project
    @State private var origin: CGPoint = .zero
    @State private var selectedRow: String?
    @State private var host = WorkNotifyHost()
    let crosshair: WorkNotifyCrosshair
    @FocusState private var gridFocused: Bool

    init(rows: [WorkNotifyRow], allRows: [WorkNotifyRow], pending: [String: String], enabled: Bool,
         apply: ((WorkNotifyScope, String, String, String?) -> Void)?, crosshair: WorkNotifyCrosshair) {
        self.rows = rows
        self.allRows = allRows
        self.pending = pending
        self.enabled = enabled
        self.apply = apply
        self.crosshair = crosshair
    }

    private var actions: [String] {
        let available = Set(rows.flatMap { $0.cells.map(\.action) })
        return WorkNotifyWords.actions.filter { available.contains($0) }
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { reader in
                ZStack(alignment: .topLeading) {
                    ScrollView([.horizontal, .vertical]) {
                        VStack(spacing: 0) {
                            Color.clear.frame(height: WorkNotifyMetrics.headerHeight)
                            ForEach(Array(rows.enumerated()), id: \.element.type) { index, row in
                                WorkNotifyValueRow(row: row, actions: actions, index: index,
                                                   pending: rowPending(row), selected: selectedRow == row.type,
                                                   editable: apply != nil, enabled: enabled, scope: scope,
                                                   chooseScope: { scope = $0 }, apply: apply,
                                                   hover: { crosshair.hover($0, inside: $1) },
                                                   chooseFocus: focus)
                                    .equatable()
                            }
                        }
                        .frame(width: WorkNotifyMetrics.typeWidth + CGFloat(actions.count) * WorkNotifyMetrics.cellWidth)
                        .background(GeometryReader { content in
                            Color.clear.preference(key: WorkNotifyOriginKey.self,
                                                   value: content.frame(in: .named("work-notify-viewport")).origin)
                        })
                    }
                    .coordinateSpace(name: "work-notify-viewport")
                    .onPreferenceChange(WorkNotifyOriginKey.self) { if origin != $0 { origin = $0 } }
                    .scrollOverflowContent()
                    pinnedTypes.frame(width: WorkNotifyMetrics.typeWidth,
                                      height: WorkNotifyMetrics.visibleHeight(rows: rows.count, origin: origin.y,
                                                                              viewport: geometry.size.height),
                                      alignment: .top)
                    pinnedActions.frame(width: max(0, geometry.size.width - WorkNotifyMetrics.typeWidth),
                                        height: WorkNotifyMetrics.headerHeight, alignment: .topLeading)
                        .clipped().padding(.leading, WorkNotifyMetrics.typeWidth)
                    Text("Type").font(.system(size: 11, weight: .semibold)).foregroundStyle(KitPalette.dim)
                        .padding(.leading, 16)
                        .frame(width: WorkNotifyMetrics.typeWidth, height: WorkNotifyMetrics.headerHeight, alignment: .leading)
                        .background(Color(nsColor: .windowBackgroundColor))
                        .allowsHitTesting(false).accessibilityHidden(true)
                    WorkNotifyCrosshairLayer(crosshair: crosshair, rows: rows, actions: actions, origin: origin,
                                             keyboard: gridFocused)
                        .allowsHitTesting(false).accessibilityHidden(true)
                    if rows.isEmpty {
                        Text("No types match this filter.").font(.system(size: 12)).foregroundStyle(KitPalette.dim)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .allowsHitTesting(false)
                    }
                }
                .clipped()
                .background(WorkNotifyHostReader(host: host).allowsHitTesting(false))
                .contentShape(Rectangle())
                .focusable().focused($gridFocused)
                .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow, .space, .return, .escape]) { press in
                    guard press.modifiers.intersection([.command, .control, .option]).isEmpty else { return .ignored }
                    return key(press.key, reader: reader, viewport: geometry.size)
                }
                .onChange(of: gridFocused) { _, focused in
                    if focused, crosshair.focus == nil, let first = rows.first, let action = actions.first {
                        focus(.init(type: first.type, action: action))
                    }
                    if !focused { crosshair.focus = nil; selectedRow = nil }
                }
                .onChange(of: rows.map(\.type)) { _, types in
                    if let type = crosshair.focus?.type, !types.contains(type) {
                        crosshair.focus = nil; selectedRow = nil
                    }
                }
                .scrollOverflowHints()
                .accessibilityLabel("Notification rules")
                .accessibilityHint("Use the arrow keys to move between rules. Space opens the selected rule's menu.")
                .accessibilityIdentifier("work-notify-cells")
            }
        }
        .frame(minHeight: 160)
    }

    private var pinnedTypes: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.type) { index, row in
                Group {
                    if apply != nil {
                        MenuButton(items: { menu(.init(type: row.type, action: "*", cells: row.cells)) }) {
                            typeLabel(row.type)
                        }
                        .simultaneousGesture(TapGesture().onEnded { focus(.init(type: row.type, action: nil)) })
                        .accessibilityLabel("Change all notifications for \(WorkNotifyWords.type(row.type))")
                        .accessibilityIdentifier("work-notify-type-\(row.type)")
                        .frameProbe("work-notify-type-\(row.type)")
                        .instantTooltip("Change the notification level for every action on \(WorkNotifyWords.type(row.type)).")
                    } else { typeLabel(row.type) }
                }
                .frame(width: WorkNotifyMetrics.typeWidth, height: WorkNotifyMetrics.rowHeight)
                .background(index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.025))
                .onHover { crosshair.hover(.init(type: row.type, action: nil), inside: $0) }
                .liveRow(selected: selectedRow == row.type)
            }
        }
        .offset(y: origin.y)
        .padding(.top, WorkNotifyMetrics.headerHeight)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipped()
        .overlay(alignment: .trailing) {
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1).allowsHitTesting(false)
        }
    }

    private func typeLabel(_ type: String) -> some View {
        Text(WorkNotifyWords.type(type)).font(.system(size: 12, weight: .medium))
            .lineLimit(1).padding(.leading, 12)
            .frame(width: WorkNotifyMetrics.typeWidth, alignment: .leading)
            .frame(height: WorkNotifyMetrics.rowHeight)
    }

    private var pinnedActions: some View {
        HStack(spacing: 0) {
            ForEach(actions, id: \.self) { action in
                Group {
                    if apply != nil {
                        MenuButton(items: {
                            menu(.init(type: "*", action: action,
                                       cells: allRows.flatMap { $0.cells.filter { $0.action == action } }))
                        }) { actionLabel(action) }
                        .simultaneousGesture(TapGesture().onEnded { focus(.init(type: nil, action: action)) })
                        .accessibilityLabel("Change \(WorkNotifyWords.action(action)) notifications for every type")
                        .accessibilityIdentifier("work-notify-action-\(action)")
                        .instantTooltip("Change \(WorkNotifyWords.action(action).lowercased()) notifications for every type, including filtered types.")
                    } else { actionLabel(action) }
                }
                .frame(width: WorkNotifyMetrics.cellWidth, height: WorkNotifyMetrics.headerHeight)
                .onHover { crosshair.hover(.init(type: nil, action: action), inside: $0) }
            }
        }
        .offset(x: origin.x)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipped()
        .overlay(alignment: .bottom) { Divider().allowsHitTesting(false) }
    }

    private func actionLabel(_ action: String) -> some View {
        Text(WorkNotifyWords.action(action)).font(.system(size: 11, weight: .semibold))
            .multilineTextAlignment(.center).lineLimit(2)
            .frame(width: WorkNotifyMetrics.cellWidth, height: WorkNotifyMetrics.headerHeight)
    }

    private func rowPending(_ row: WorkNotifyRow) -> [String: String] {
        Dictionary(uniqueKeysWithValues: row.cells.compactMap { cell in
            pending["notify:\(row.type):\(cell.action)"].map { (cell.action, $0) }
        })
    }

    private func menu(_ target: WorkNotifyMenu.Target) -> [MenuButtonItem] {
        guard let apply else { return [] }
        let hasPending = allRows.filter { target.type == "*" || $0.type == target.type }.contains { row in
            row.cells.contains { cell in
                (target.action == "*" || cell.action == target.action) && pending["notify:\(row.type):\(cell.action)"] != nil
            }
        }
        return WorkNotifyMenu.items(target: target, scope: scope, enabled: enabled, busy: hasPending,
                                    chooseScope: { scope = $0 }, apply: apply)
    }

    private func focus(_ target: WorkNotifyCoordinate) {
        crosshair.focus = target; selectedRow = target.type; gridFocused = true
    }

    private func key(_ key: KeyEquivalent, reader: ScrollViewProxy, viewport: CGSize) -> KeyPress.Result {
        guard gridFocused, !rows.isEmpty, !actions.isEmpty else { return .ignored }
        if key == .escape { gridFocused = false; return .handled }
        let current = crosshair.focus ?? .init(type: rows.first?.type, action: actions.first)
        if key == .space || key == .return {
            guard apply != nil else { return .handled }
            let target = WorkNotifyMenu.Target(type: current.type ?? "*", action: current.action ?? "*",
                                              cells: allRows.filter { current.type == nil || $0.type == current.type }
                                                .flatMap { $0.cells.filter { current.action == nil || $0.action == current.action } })
            if let view = host.view {
                let rect = WorkNotifyCrosshairLayer.rect(current, rows: rows, actions: actions, origin: origin)
                let point = view.convert(NSPoint(x: rect.minX, y: view.bounds.height - rect.maxY), to: nil)
                MenuButtonPresenter.pop(menu(target), in: view.window, at: point)
            }
            return .handled
        }
        guard let next = current.moved(key, rows: rows, actions: actions) else { return .ignored }
        focus(next)
        let rect = WorkNotifyCrosshairLayer.rect(next, rows: rows, actions: actions, origin: origin)
        let hiddenHorizontally = next.action != nil && (rect.minX < WorkNotifyMetrics.typeWidth || rect.maxX > viewport.width)
        let hiddenVertically = next.type != nil && (rect.minY < WorkNotifyMetrics.headerHeight || rect.maxY > viewport.height)
        if (hiddenHorizontally || hiddenVertically),
           let type = next.type ?? rows.first?.type, let action = next.action ?? actions.first {
            reader.scrollTo("notify:\(type):\(action)", anchor: .center)
        }
        return .handled
    }
}

private struct WorkNotifyValueRow: View, Equatable {
    let row: WorkNotifyRow
    let actions: [String]
    let index: Int
    let pending: [String: String]
    let selected: Bool
    let editable: Bool
    let enabled: Bool
    let scope: WorkNotifyScope
    let chooseScope: (WorkNotifyScope) -> Void
    let apply: ((WorkNotifyScope, String, String, String?) -> Void)?
    let hover: (WorkNotifyCoordinate, Bool) -> Void
    let chooseFocus: (WorkNotifyCoordinate) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.actions == rhs.actions && lhs.index == rhs.index && lhs.pending == rhs.pending
            && lhs.selected == rhs.selected && lhs.editable == rhs.editable && lhs.enabled == rhs.enabled && lhs.scope == rhs.scope
    }

    var body: some View {
        let _ = RenderProbe.hit("work.notify.row.\(row.type)")
        HStack(spacing: 0) {
            Color.clear.frame(width: WorkNotifyMetrics.typeWidth)
            ForEach(actions, id: \.self) { action in
                if let cell = row.cells.first(where: { $0.action == action }) {
                    let optimistic = pending[action]
                    let level = optimistic ?? cell.level
                    let coordinate = WorkNotifyCoordinate(type: row.type, action: action)
                    Group {
                        if editable, let apply {
                            MenuButton(items: {
                                WorkNotifyMenu.items(target: .init(type: row.type, action: action, cells: [cell]),
                                                     scope: scope, enabled: enabled, busy: optimistic != nil,
                                                     chooseScope: chooseScope, apply: apply)
                            }) {
                                glyph(cell: cell, level: level, pending: optimistic != nil)
                                    .frame(width: WorkNotifyMetrics.cellWidth, height: WorkNotifyMetrics.rowHeight)
                            }
                            .simultaneousGesture(TapGesture().onEnded { chooseFocus(coordinate) })
                        } else { glyph(cell: cell, level: level, pending: false) }
                    }
                    .frame(width: WorkNotifyMetrics.cellWidth, height: WorkNotifyMetrics.rowHeight)
                    .contentShape(Rectangle())
                    .instantTooltip(editable && !enabled ? "Changes need the GenesisTools service. It is not running." : WorkNotifyWords.tooltip(type: row.type, cell: cell, level: level, pending: optimistic != nil))
                    .accessibilityLabel("\(WorkNotifyWords.type(row.type)), \(WorkNotifyWords.action(action)), \(WorkNotifyWords.level(level))")
                    .accessibilityValue(optimistic == nil ? WorkNotifyWords.layer(cell.from) : "Saving")
                    .accessibilityIdentifier("work-notify-cell-\(row.type)-\(action)")
                    .frameProbe("work-notify-cell-\(row.type)-\(action)")
                    .onHover { hover(coordinate, $0) }
                    .id("notify:\(row.type):\(action)")
                }
            }
        }
        .frame(height: WorkNotifyMetrics.rowHeight)
        .background(index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.025))
        .contentShape(Rectangle())
        .liveRow(selected: selected)
    }

    private func glyph(cell: WorkNotifyCell, level: String, pending: Bool) -> some View {
        Image(systemName: WorkNotifyWords.symbol(level))
            .font(.system(size: 13)).foregroundStyle(WorkNotifyWords.color(level))
            .frame(width: 24, height: 24)
            .overlay(alignment: .topTrailing) {
                if cell.from != "default" || level != cell.builtInLevel {
                    Circle().fill(WorkNotifyWords.color(level)).frame(width: 4, height: 4)
                }
            }
            .opacity(pending ? 0.5 : 1)
            .accessibilityHidden(true)
    }
}

/// Only this leaf observes pointer changes. The value rows retain their data and Equatable identity.
private struct WorkNotifyCrosshairLayer: View {
    @ObservedObject var crosshair: WorkNotifyCrosshair
    let rows: [WorkNotifyRow]
    let actions: [String]
    let origin: CGPoint
    let keyboard: Bool

    var body: some View {
        GeometryReader { geometry in
            let _ = RenderProbe.hit("work.notify.crosshair")
            let tableHeight = WorkNotifyMetrics.visibleHeight(rows: rows.count, origin: origin.y, viewport: geometry.size.height)
            let active = crosshair.hover ?? (keyboard ? crosshair.focus : nil)
            if let active {
                let rect = Self.rect(active, rows: rows, actions: actions, origin: origin)
                if active.type != nil {
                    let visible = rect.intersection(CGRect(x: rect.minX, y: WorkNotifyMetrics.headerHeight,
                                                          width: rect.width, height: max(0, geometry.size.height - WorkNotifyMetrics.headerHeight)))
                    if !visible.isNull {
                        Rectangle().fill(Color.primary.opacity(0.045))
                            .frame(width: geometry.size.width, height: visible.height)
                            .position(x: geometry.size.width / 2, y: visible.midY)
                    }
                }
                if active.action != nil {
                    let visible = rect.intersection(CGRect(x: WorkNotifyMetrics.typeWidth, y: rect.minY,
                                                          width: max(0, geometry.size.width - WorkNotifyMetrics.typeWidth), height: rect.height))
                    if !visible.isNull {
                        Rectangle().fill(Color.primary.opacity(0.045))
                            .frame(width: visible.width, height: tableHeight)
                            .position(x: visible.midX, y: tableHeight / 2)
                    }
                }
            }
            if keyboard, let focused = crosshair.focus {
                let rect = Self.rect(focused, rows: rows, actions: actions, origin: origin)
                if (focused.type == nil || rect.minY >= WorkNotifyMetrics.headerHeight)
                    && (focused.action == nil || rect.minX >= WorkNotifyMetrics.typeWidth) {
                    WorkNotifyNativeFocusRing().frame(width: rect.width - 6, height: rect.height - 6)
                        .position(x: rect.midX, y: rect.midY)
                }
            }
        }
        .clipped()
    }

    static func rect(_ coordinate: WorkNotifyCoordinate, rows: [WorkNotifyRow], actions: [String], origin: CGPoint) -> CGRect {
        let row = coordinate.type.flatMap { type in rows.firstIndex { $0.type == type } }
        let column = coordinate.action.flatMap { actions.firstIndex(of: $0) }
        return CGRect(x: column.map { WorkNotifyMetrics.typeWidth + CGFloat($0) * WorkNotifyMetrics.cellWidth + origin.x } ?? 0,
                      y: row.map { WorkNotifyMetrics.headerHeight + CGFloat($0) * WorkNotifyMetrics.rowHeight + origin.y } ?? 0,
                      width: column == nil ? WorkNotifyMetrics.typeWidth : WorkNotifyMetrics.cellWidth,
                      height: row == nil ? WorkNotifyMetrics.headerHeight : WorkNotifyMetrics.rowHeight)
    }
}

private struct WorkNotifyNativeFocusRing: NSViewRepresentable {
    final class Ring: NSView {
        override func draw(_ dirtyRect: NSRect) {
            NSGraphicsContext.saveGraphicsState()
            NSFocusRingPlacement.only.set()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 4, yRadius: 4).fill()
            NSGraphicsContext.restoreGraphicsState()
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
    func makeNSView(context: Context) -> Ring { Ring() }
    func updateNSView(_ view: Ring, context: Context) { view.needsDisplay = true }
}
