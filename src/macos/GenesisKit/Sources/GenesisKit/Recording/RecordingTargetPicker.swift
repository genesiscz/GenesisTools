import AppKit
import SwiftUI

/// The picker tabs in keyboard order.
public enum RecordingPickerTab: String, CaseIterable, Hashable, Sendable {
    case windows, apps, displays, area, click

    public var title: String {
        switch self {
        case .windows: return "Windows"
        case .apps: return "Apps"
        case .displays: return "Displays"
        case .area: return "Area"
        case .click: return "Pick a window"
        }
    }

    var accessibilityTitle: String {
        switch self {
        case .area: return "Select an area"
        case .click: return "Pick a window by clicking it"
        default: return title
        }
    }

    /// The number-row key that switches to this tab, by position on any keyboard layout.
    public var keyCode: UInt16 {
        switch self {
        case .windows: return 18
        case .apps: return 19
        case .displays: return 20
        case .area: return RecordingPickerKey.area
        case .click: return 23
        }
    }

    /// The tab that lists `target`: an app's tab, a display's tab, else the windows.
    public static func of(_ target: RecordingTarget?) -> RecordingPickerTab {
        switch target {
        case .app: return .apps
        case .display, .displays, .followDisplay: return .displays
        case .area: return .area
        default: return .windows
        }
    }
}

extension RecordingPickerTab {
    /// The chord that switches to this tab, shown in the tab's tooltip, as the user's layout prints the key.
    @MainActor var chord: String { RecordingPickerKey.label(keyCode) }

    /// The tab of a ⌘ press: by the key's position when the event is known, else by the US digit.
    static func forKey(code: UInt16?, character: Character?) -> RecordingPickerTab? {
        if let code { return allCases.first { $0.keyCode == code } }
        return allCases.first { TableKeyLayout.us.character(for: $0.keyCode) == character.map(String.init) }
    }
}

/// The picker's ⌘ keys, matched by their place on the keyboard. On a Czech layout ⌘ with the 4 key types "č", so a
/// match by character never fired there (review 2026-11-06). SwiftUI's `KeyPress` carries no key code; the key event
/// being handled has one.
public enum RecordingPickerKey {
    /// ⌘ and the 4 key: select an area.
    public static let area: UInt16 = 21

    /// The key code of the key-down event being handled now, nil outside one.
    @MainActor public static func eventCode() -> UInt16? {
        guard let event = NSApp.currentEvent, event.type == .keyDown else { return nil }
        return event.keyCode
    }

    /// ⌘ alone and the key at `code`. Without an event (a test, a synthetic press) the US character decides.
    public static func matches(modifiers: EventModifiers, eventCode: UInt16?, character: Character?, code: UInt16) -> Bool {
        guard modifiers == .command else { return false }
        if let eventCode { return eventCode == code }
        return TableKeyLayout.us.character(for: code) == character.map(String.init)
    }

    /// "⌘4" on a US layout, "⌘Č" on a Czech one: what the user's keyboard prints on that key.
    @MainActor public static func label(_ code: UInt16) -> String { label(code, layout: SystemKeyLayout.shared) }

    public static func label(_ code: UInt16, layout: KeyLayout) -> String { KeyChord.code(code, .command).label(layout: layout) }

    /// The five layout-aware tab chords for the footer.
    @MainActor public static var tabLabels: String { RecordingPickerTab.allCases.map(\.chord).joined(separator: " ") }
}

/// An app header or a selectable target.
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

    /// The first row of the Displays tab when the engine can follow the display in use.
    static let follow = RecordingPickerRow(id: "display-follow", kind: .target(.followDisplay), title: "Follow display",
                                           detail: "Display in use", pid: nil, symbol: RecordingTarget.followDisplay.symbol)

    /// The rows of one tab: windows grouped under their app in the order the apps' front windows stand, apps, or
    /// displays (after "Follow display" when `offersFollow`). `query` keeps the windows whose title or app contains it
    /// (apps by name).
    static func rows(_ targets: RecordingTargets, tab: RecordingPickerTab, query: String,
                     offersFollow: Bool = false) -> [RecordingPickerRow] {
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
            let follows = offersFollow && matches(Self.follow.title, Self.follow.detail) ? [Self.follow] : []
            return follows + targets.displays.filter { matches($0.name) }.map { display in
                RecordingPickerRow(id: "display-\(display.index)", kind: .target(display.target), title: display.name,
                                   detail: "\(Int(display.width)) × \(Int(display.height))", pid: nil, symbol: "display",
                                   badge: display.isPrimary ? "Main" : nil)
            }
        case .area, .click: return []
        }
    }
}

/// The shared picker. A bar-backed choice updates the setup; the choiceStarts preference opts into Record.
@MainActor
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
    private let onStart: () -> Void
    private let capabilities: RecordingCapabilities?
    private let onCancel: () -> Void
    private let onRetry: () -> Void
    private let onFilterChange: (RecordingPickerTab, String) -> Void
    /// A host's own section under the list (the recorder's options and its area button); nil for none.
    private let accessory: AnyView?
    /// The footer's key hints; nil keeps the picker's own line.
    private let footerHint: String?
    @State private var tab: RecordingPickerTab
    @State private var query = ""
    @State private var highlighted: String?
    @State private var appeared = false
    @StateObject private var listing: RecordingPickerListing
    @State private var checked: Set<Int>
    @State private var feedback = RecordingPickerFeedback()
    @State private var host = HostWindow()
    @StateObject private var overlays: RecordingPickerOverlays
    @AppStorage("recorder.picker.choiceStarts") private var choiceStarts = false
    @AppStorage("recorder.picker.pulse") private var pulseMode = RecordingPickerPulseMode.hoverAndChoice
    @AppStorage("recorder.picker.frontChosenWindow") private var frontChosenWindow = true
    /// The list took over 4 s: the hint names the known slow cause.
    @State private var slowLoad = false
    @FocusState private var filterFocused: Bool
    /// Where the pointer rested when the arrows last moved the highlight; a hover there is the list scrolling under
    /// the pointer, not the person moving it, so the keyboard highlight stays.
    @State private var keyboardMouse: CGPoint?

    public init(load: Load, title: String = "Choose what to record", initial: RecordingTarget?,
                onChoose: @escaping (RecordingTarget) -> Void, onCancel: @escaping () -> Void,
                onRetry: @escaping () -> Void = {}, restoring: (tab: RecordingPickerTab, query: String)? = nil,
                onFilterChange: @escaping (RecordingPickerTab, String) -> Void = { _, _ in },
                accessory: AnyView? = nil, footerHint: String? = nil, capabilities: RecordingCapabilities? = nil,
                overlays: RecordingPickerOverlays? = nil, onStart: @escaping () -> Void = {}) {
        self.accessory = accessory
        self.footerHint = footerHint
        self.load = load
        self.title = title
        self.initial = initial
        self.onChoose = onChoose
        self.onStart = onStart
        self.capabilities = capabilities
        self.onCancel = onCancel
        self.onRetry = onRetry
        self.onFilterChange = onFilterChange
        let firstTab = restoring?.tab ?? RecordingPickerTab.of(initial)
        _tab = State(initialValue: firstTab)
        _listing = StateObject(wrappedValue: RecordingPickerListing(load: load, tab: firstTab, query: restoring?.query ?? "",
                                                                    offersFollow: capabilities?.targets.contains(.follow) == true))
        _query = State(initialValue: restoring?.query ?? "")
        _checked = State(initialValue: RecordingDisplaySelection.indices(of: initial))
        _overlays = StateObject(wrappedValue: overlays ?? RecordingPickerOverlays())
    }

    /// The host supplies the same overlays whose windowIDs it passes to the engine and closes its picker on a choice.
    public init(load: Load, bar: RecordingBarModel, overlays: RecordingPickerOverlays, onChoose: @escaping () -> Void,
                onCancel: @escaping () -> Void, onRetry: @escaping () -> Void = {},
                restoring: (tab: RecordingPickerTab, query: String)? = nil,
                onFilterChange: @escaping (RecordingPickerTab, String) -> Void = { _, _ in }) {
        self.init(load: load, initial: bar.setup.target, onChoose: { target in
            bar.apply(.target(target))
            onChoose()
        }, onCancel: onCancel, onRetry: onRetry, restoring: restoring, onFilterChange: onFilterChange,
        capabilities: bar.capabilities, overlays: overlays, onStart: {
            if bar.phase == .setup { bar.record() }
        })
    }

    private var rows: [RecordingPickerRow] { listing.rows }
    private var targetRows: [RecordingPickerRow] { listing.targets }
    private var checksDisplays: Bool { tab == .displays && capabilities?.targets.contains(.displays) == true }
    private var offersFollow: Bool { capabilities?.targets.contains(.follow) == true }

    private func supports(_ tab: RecordingPickerTab) -> Bool {
        guard let capabilities else { return true }
        switch tab {
        case .windows, .click: return capabilities.targets.contains(.window)
        case .apps: return capabilities.targets.contains(.app)
        case .displays:
            return capabilities.targets.contains(.display) || capabilities.targets.contains(.displays)
                || capabilities.targets.contains(.follow)
        case .area: return capabilities.targets.contains(.area)
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            GenSegmentedTabs("What to record", items: RecordingPickerTab.allCases.map { .init($0, $0.title, isEnabled: supports($0)) },
                             selection: Binding(get: { tab }, set: selectTab), identifier: "recording.picker.tabs", fillsWidth: true)
                .instantTooltip(RecordingPickerTab.allCases.map { "\($0.title) \($0.chord)" }.joined(separator: ", "))
                .accessibilityRepresentation {
                    HStack {
                        ForEach(RecordingPickerTab.allCases, id: \.self) { item in
                            Button(item.accessibilityTitle) { selectTab(item) }
                                .disabled(!supports(item))
                                .accessibilityAddTraits(item == tab ? .isSelected : [])
                                .accessibilityIdentifier("recording.picker.tabs.\(item.rawValue)")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("What to record")
                    .accessibilityIdentifier("recording.picker.tabs")
                }
            if tab == .area || tab == .click {
                Button(tab == .area ? "Select an area" : "Pick a window by clicking it") { selectTab(tab) }
                    .accessibilityIdentifier("recording.picker.selector")
            } else {
                filterField
                content.onHover { if !$0 { stopHover() } }
                if checksDisplays {
                    Button(checked.isEmpty ? "Choose displays" : "Choose \(Plural.count(checked.count, "display"))") { chooseDisplays() }
                        .disabled(checked.isEmpty)
                        .accessibilityIdentifier("recording.picker.chooseDisplays")
                }
            }
            if let accessory {
                Divider().opacity(0.5)
                accessory
            }
            footer
        }
        .padding(14)
        .frame(width: 380)
        .modifier(NativeGlassShapeSurface(shape: RoundedRectangle(cornerRadius: 16, style: .continuous)))
        .environment(\.colorScheme, .dark)
        .background(HostWindowReader(host: host))
        .onAppear {
            guard !appeared else { return }
            appeared = true
            if !supports(tab), let first = RecordingPickerTab.allCases.first(where: supports) { tab = first }
            reloadRows(useInitial: true)
            filterFocused = true
        }
        .onDisappear { feedback.cancelChoice(); stopHover() }
        .onChange(of: load) { _, _ in reloadRows(useInitial: true) }
        .onChange(of: tab) { _, _ in onFilterChange(tab, query); reloadRows(useInitial: false) }
        .onChange(of: query) { _, _ in onFilterChange(tab, query); reloadRows(useInitial: false) }
        .onChange(of: pulseMode) { _, mode in
            if mode != .hoverAndChoice { stopHover() }
            if mode == .off { overlays.pulse.clear() }
        }
        // The keys live on the root, so they work wherever focus is (the filter, a row, nothing).
        .focusable()
        .focusEffectDisabled()
        .onExitCommand(perform: cancel)
        .onKeyPress(.escape) {
            cancel()
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
        .onKeyPress(.space) {
            guard checksDisplays, !filterFocused,
                  let row = targetRows.first(where: { $0.id == highlighted }),
                  case let .display(index, _) = row.target else { return .ignored }
            if checked.contains(index) { checked.remove(index) } else { checked.insert(index) }
            return .handled
        }
        .onKeyPress(.return) {
            chooseHighlighted()
            return .handled
        }
        .onKeyPress(phases: .down) { press in
            guard press.modifiers == .command,
                  let next = RecordingPickerTab.forKey(code: RecordingPickerKey.eventCode(), character: press.characters.first)
            else { return .ignored }
            selectTab(next)
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "record.circle").font(.system(size: 14, weight: .semibold)).foregroundStyle(.red)
            Text(title).font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
            Menu {
                Picker("Outline", selection: $pulseMode) {
                    Text("On hover and choice").tag(RecordingPickerPulseMode.hoverAndChoice)
                    Text("On choice").tag(RecordingPickerPulseMode.choiceOnly)
                    Text("Off").tag(RecordingPickerPulseMode.off)
                }
                Toggle("Bring chosen window to front", isOn: $frontChosenWindow)
                Toggle("Start recording on choice", isOn: $choiceStarts)
            } label: { Image(systemName: "gearshape") }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("Picker settings")
            .accessibilityIdentifier("recording.picker.settings")
            .instantTooltip("Picker settings")
            IconButton(systemName: "xmark", tooltip: "Cancel (Esc)", size: 10, action: cancel)
                .accessibilityIdentifier("recording.picker.cancel")
        }
    }

    private var filterField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
            TextField("Filter \(tab.title.lowercased())", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($filterFocused)
                .onSubmit(chooseHighlighted)
                .accessibilityIdentifier("recording.picker.filter")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @ViewBuilder private var content: some View {
        switch load {
        case .loading:
            VStack(spacing: 6) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Looking for windows and displays…").font(.system(size: 12)).foregroundStyle(SessionPalette.secondary)
                }
                if slowLoad {
                    Text("The first time after an update, the recorder is built first. This can take up to a minute.")
                        .font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 300)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 120)
            .task {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                slowLoad = true
            }
        case let .failed(message):
            FailureInline(message: message, outcome: "The list of what to record did not load",
                          action: "List the screens and windows", area: "recorder", form: .pane,
                          identifier: "recording.picker.failure") { onRetry() }
            .frame(maxWidth: .infinity, minHeight: 120)
        case .loaded:
            if rows.isEmpty {
                if query.isEmpty {
                    EmptyState(
                        symbol: "rectangle.dashed.badge.record",
                        text: "Nothing to record here.",
                        detail: "If you expected windows, Screen Recording may be off for this app.",
                        actionTitle: "Open Screen Recording settings",
                        action: { NSWorkspace.shared.open(PermissionKind.screenRecording.settingsURL) })
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    Text("Nothing matches “\(query)”.")
                        .font(.system(size: 12)).foregroundStyle(SessionPalette.secondary)
                        .frame(maxWidth: .infinity, minHeight: 80)
                }
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
            Group {
                if checksDisplays, case let .display(index, _) = target {
                    Toggle(isOn: Binding(get: { checked.contains(index) }, set: { enabled in
                        if enabled { checked.insert(index) } else { checked.remove(index) }
                    })) { rowLabel(row, highlighted: isHighlighted) }
                        .toggleStyle(.checkbox)
                        .padding(.leading, 6)
                } else {
                    Button { choose(target) } label: { rowLabel(row, highlighted: isHighlighted) }
                        .buttonStyle(.genHoverPlain())
                }
            }
            .onContinuousHover { phase in
                guard case .active = phase else { return }
                if let rested = keyboardMouse {
                    let now = NSEvent.mouseLocation
                    if hypot(now.x - rested.x, now.y - rested.y) < 3 { return }
                    keyboardMouse = nil
                }
                if highlighted != row.id { highlighted = row.id }
                hover(target)
            }
            .accessibilityLabel(accessibilityLabel(row))
            .accessibilityIdentifier("recording.picker.\(row.id)")
            .frameProbe("recording.picker.\(row.id)")
        } else {
            HStack(spacing: 6) {
                icon(row).frame(width: 14, height: 14)
                Text(row.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(SessionPalette.secondary)
                Text(verbatim: row.detail).font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
            }
            .padding(.horizontal, 6)
            .padding(.top, 6)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
            .onHover { if $0 { stopHover() } }
        }
    }

    private func rowLabel(_ row: RecordingPickerRow, highlighted isHighlighted: Bool) -> some View {
        HStack(spacing: 8) {
            icon(row).frame(width: 18, height: 18)
            Text(row.title).font(.system(size: 12, weight: isHighlighted ? .semibold : .regular))
                .lineLimit(1).truncationMode(.middle)
            if let badge = row.badge {
                Text(badge).font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(.white.opacity(0.12), in: Capsule())
            }
            Spacer(minLength: 8)
            Text(verbatim: row.detail).font(.system(size: 11).monospacedDigit()).foregroundStyle(SessionPalette.secondary)
        }
        .padding(.leading, row.symbol == "macwindow" ? 22 : 6)
        .padding(.trailing, 8)
        .frame(height: 28)
        .background(isHighlighted ? Color.accentColor.opacity(0.32) : .clear,
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
    }

    @ViewBuilder private func icon(_ row: RecordingPickerRow) -> some View {
        if let image = RecordingAppIcon.image(pid: row.pid) {
            Image(nsImage: image).resizable().interpolation(.high)
        } else {
            Image(systemName: row.symbol).font(.system(size: 12)).foregroundStyle(SessionPalette.secondary)
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Text(footerHint ?? "↑ ↓ to browse · \(choiceStarts ? "Return records" : "Return chooses") · Esc cancels · \(RecordingPickerKey.tabLabels) tabs")
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .font(.system(size: 11))
        .foregroundStyle(SessionPalette.secondary)
    }

    /// What VoiceOver reads for a row: the action, then the badge and the details the row shows.
    private func accessibilityLabel(_ row: RecordingPickerRow) -> String {
        var parts = [row.title]
        if let badge = row.badge { parts.append(badge) }
        parts.append(row.detail.replacingOccurrences(of: " × ", with: " by "))
        return parts.joined(separator: ", ")
    }

    private func reloadRows(useInitial: Bool) {
        stopHover()
        listing.update(load: load, tab: tab, query: query, offersFollow: offersFollow)
        guard case let .loaded(targets) = load else { highlighted = nil; return }
        checked.formIntersection(targets.displays.map(\.index))
        let candidates = targetRows
        let initialRow = useInitial ? candidates.first { $0.target == initial } : nil
        let chosen = initialRow ?? candidates.first { $0.id == highlighted } ?? candidates.first
        highlighted = chosen?.id
        if !useInitial, let target = chosen?.target { hover(target) }
    }

    private func move(_ step: Int) {
        let candidates = targetRows
        guard !candidates.isEmpty else { return }
        keyboardMouse = NSEvent.mouseLocation
        let index = candidates.firstIndex { $0.id == highlighted } ?? -1
        let row = candidates[min(max(index + step, 0), candidates.count - 1)]
        highlighted = row.id
        if checksDisplays { filterFocused = false }
        if let target = row.target { hover(target) }
    }

    private func chooseHighlighted() {
        if tab == .area || tab == .click { selectTab(tab); return }
        if checksDisplays { chooseDisplays(); return }
        guard let row = targetRows.first(where: { $0.id == highlighted }) ?? targetRows.first,
              let target = row.target else { return }
        choose(target)
    }

    private func selectTab(_ next: RecordingPickerTab) {
        guard supports(next), !feedback.isChoosing else { return }
        stopHover()
        switch next {
        case .area:
            AreaSelector.begin(overlays: overlays, parent: host.window, completion: finishSelector)
        case .click:
            WindowClickPicker.begin(overlays: overlays, parent: host.window, hover: { window in
                guard let window else { stopHover(); return }
                hover(window.target, window: window)
            }, completion: finishSelector)
        default:
            tab = next
        }
    }

    private func finishSelector(_ target: RecordingTarget?) {
        stopHover()
        if let target { choose(target) }
    }

    private func chooseDisplays() {
        guard case let .loaded(targets) = load,
              let target = RecordingDisplaySelection.target(checked, displays: targets.displays) else { return }
        choose(target)
    }

    private func cancel() {
        feedback.cancelChoice()
        stopHover()
        onCancel()
    }

    private func stopHover() {
        feedback.leave { overlays.pulse.clear() }
    }

    private func hover(_ target: RecordingTarget, window: RecordingWindow? = nil) {
        guard pulseMode == .hoverAndChoice else { stopHover(); return }
        feedback.highlight(target) {
            let windows = window.map { [$0] } ?? windowsForPulse(target)
            overlays.pulse.hover(RecordingPickerGeometry.rects(target, windows: windows, screens: NSScreen.screens.map(\.frame),
                                                               pointer: NSEvent.mouseLocation))
        }
    }

    private func windowsForPulse(_ target: RecordingTarget) -> [RecordingWindow] {
        switch target {
        case .window, .app: return WindowClickPicker.windows()
        default: return []
        }
    }

    private func choose(_ target: RecordingTarget) {
        guard !feedback.isChoosing else { return }
        stopHover()
        let windows = windowsForPulse(target)
        let excluded = Set(NSApp.windows.filter { $0.sharingType == .none }.compactMap { UInt32(exactly: $0.windowNumber) })
        let background = WindowClickPicker.windowToRaise(for: target, in: windows, excluding: excluded, enabled: frontChosenWindow)
        let panel = host.window?.delegate as? RecordingPickerPanel
        let focusLoss = panel?.closesOnFocusLoss
        panel?.closesOnFocusLoss = false
        feedback.choose(background: background, front: { window, done in
            RecordingWindowFront.bringForward(window, excluding: excluded, done: done)
        }, pulse: { wasRaised in
            guard pulseMode != .off else { return }
            let latest = wasRaised ? windowsForPulse(target) : windows
            let rects = RecordingPickerGeometry.rects(target, windows: latest, screens: NSScreen.screens.map(\.frame),
                                                      pointer: NSEvent.mouseLocation)
            overlays.pulse.pulse(rects, after: wasRaised ? .zero : .milliseconds(350))
        }, restore: {
            if let focusLoss { panel?.closesOnFocusLoss = focusLoss }
        }, commit: { commitChoice(target, choiceStarts: choiceStarts) })
    }

    func commitChoice(_ target: RecordingTarget, choiceStarts: Bool) {
        onChoose(target)
        if choiceStarts { onStart() }
    }
}

private enum RecordingPickerPulseMode: String { case hoverAndChoice, choiceOnly, off }

/// Build the filtered rows at first presentation and on a load, tab or query change, never on a hover redraw.
@MainActor
private final class RecordingPickerListing: ObservableObject {
    @Published private(set) var rows: [RecordingPickerRow] = []
    private(set) var targets: [RecordingPickerRow] = []

    init(load: RecordingTargetPicker.Load, tab: RecordingPickerTab, query: String, offersFollow: Bool) {
        update(load: load, tab: tab, query: query, offersFollow: offersFollow)
    }

    func update(load: RecordingTargetPicker.Load, tab: RecordingPickerTab, query: String, offersFollow: Bool) {
        if case let .loaded(list) = load {
            rows = RecordingPickerRow.rows(list, tab: tab, query: query, offersFollow: offersFollow)
        } else {
            rows = []
        }
        targets = rows.filter { $0.target != nil }
    }
}

enum RecordingDisplaySelection {
    static func indices(of target: RecordingTarget?) -> Set<Int> {
        switch target {
        case let .display(index, _): return [index]
        case let .displays(indices): return Set(indices)
        default: return []
        }
    }

    static func target(_ checked: Set<Int>, displays: [RecordingDisplay]) -> RecordingTarget? {
        let selected = displays.filter { checked.contains($0.index) }
        guard let first = selected.first else { return nil }
        return selected.count == 1 ? first.target : .displays(indices: selected.map(\.index))
    }
}

enum RecordingPickerGeometry {
    /// Cocoa screen rects to outline for `target`; "Follow display" outlines the display under `pointer`, where its
    /// take starts (the first display without one).
    static func rects(_ target: RecordingTarget, windows: [RecordingWindow], screens: [CGRect],
                      pointer: CGPoint? = nil) -> [CGRect] {
        guard let primary = screens.first else { return [] }
        func cocoa(_ window: RecordingWindow) -> CGRect { RecordingPanelLayout.cocoa(window.quartzFrame, primaryHeight: primary.maxY) }
        switch target {
        case let .window(ids, _, _, _): return windows.filter { ids.contains($0.id) }.map(cocoa)
        case let .app(app, _):
            return windows.filter { String($0.pid) == app || $0.app == app }.map(cocoa)
        case let .area(rect, display):
            guard screens.indices.contains(display) else { return [] }
            return [rect.offsetBy(dx: screens[display].minX, dy: screens[display].minY)]
        case let .display(index, _):
            return screens.indices.contains(index) ? [screens[index].insetBy(dx: 6, dy: 6)] : []
        case let .displays(indices):
            return indices.compactMap { screens.indices.contains($0) ? screens[$0].insetBy(dx: 6, dy: 6) : nil }
        case .followDisplay:
            let start = pointer.flatMap { point in screens.first { $0.contains(point) } } ?? primary
            return [start.insetBy(dx: 6, dy: 6)]
        }
    }
}

/// One pending hover or choice per picker. A cancelled choice cannot start a take when a late AX notification arrives.
@MainActor
final class RecordingPickerFeedback {
    typealias Schedule = (Duration, @escaping @MainActor () -> Void) -> () -> Void
    private let schedule: Schedule
    private var cancelHover: (() -> Void)?
    private var hovered: RecordingTarget?
    private var choiceID: UUID?
    private var restore: (() -> Void)?
    var isChoosing: Bool { choiceID != nil }

    init(schedule: @escaping Schedule = { delay, action in
        let task = Task { @MainActor in
            do { try await Task.sleep(for: delay) } catch { return }
            action()
        }
        return { task.cancel() }
    }) {
        self.schedule = schedule
    }

    func highlight(_ target: RecordingTarget, show: @escaping @MainActor () -> Void) {
        guard !isChoosing, hovered != target else { return }
        cancelHover?()
        hovered = target
        cancelHover = schedule(.milliseconds(120), show)
    }

    func leave(clear: () -> Void) {
        guard hovered != nil else { return }
        cancelHover?()
        cancelHover = nil
        hovered = nil
        clear()
    }

    func cancelChoice() {
        choiceID = nil
        restore?()
        restore = nil
    }

    func choose(background: RecordingWindow?,
                front: (RecordingWindow, @escaping () -> Void) -> Void, pulse: @escaping (Bool) -> Void,
                restore: @escaping () -> Void, commit: @escaping () -> Void) {
        guard !isChoosing else { return }
        let id = UUID()
        choiceID = id
        self.restore = restore
        let finish = { [self] in
            guard choiceID == id else { return }
            cancelChoice()
            pulse(background != nil)
            commit()
        }
        if let background { front(background, finish) } else { finish() }
    }
}
