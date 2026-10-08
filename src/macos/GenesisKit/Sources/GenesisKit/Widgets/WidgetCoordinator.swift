import AppKit
import SwiftUI

@MainActor
public final class WidgetCoordinator: NSObject, NSWindowDelegate {
    public let model: WidgetModel
    public let modules = WidgetModuleRegistry()
    private var panels: [WidgetSurfaceID: EdgePanelController<WidgetHostView>] = [:]
    private var display: NSScreen?
    private var lastLayout: WidgetLayoutConfiguration?
    private var settings: NSWindow?
    private var mediaWindow: NSWindow?
    private var localMouse: Any?
    private var globalMouse: Any?
    private var keyboard: Any?
    private var screenObserver: NSObjectProtocol?
    private var lastSide: EdgePanelPlacement?
    private var lastDisplayID: String?
    public var settingsPresenter: ((String) -> Void)?
    private var topHeaderHeight: CGFloat = 36
    private var topCompactWidth: CGFloat = 360
    private var availableCardHeight: CGFloat = 660
    private var screenID: String {
        model.snapshot?.state.preferences.display
            ?? UserDefaults.standard.string(forKey: "widget.display") ?? ""
    }

    public init(
        binaryPath: String, stateRoot: String? = nil, openHub: @escaping (WidgetSession?) -> Void,
        openDestination: ((WidgetSession, String, String?) -> Void)? = nil
    ) {
        model = WidgetModel(binaryPath: binaryPath, stateRoot: stateRoot)
        super.init()
        do {
            try modules.register(
                WidgetModuleDescriptor(
                    id: "agents", title: "Agent Inbox", symbol: "bubble.left.and.bubble.right.fill", tint: .blue,
                    summary: { [weak model] in model?.selected?.title ?? "Your local agents" }
                ) { [model] presentation in AgentWidgetModuleView(model: model, presentation: presentation) })
        } catch { model.error = error.localizedDescription }
        model.openHub = openHub
        model.openDestination =
            openDestination ?? { session, mode, file in
                var components = URLComponents(string: "genesis-tools://hub")!
                components.queryItems = [
                    .init(name: "mode", value: "sessions"), .init(name: "session", value: session.target.sessionId),
                    .init(name: "widget-destination", value: mode),
                    .init(name: "widget-cwd", value: session.target.cwd),
                    .init(name: "widget-provider", value: session.target.provider),
                ]
                if let file { components.queryItems?.append(.init(name: "widget-context", value: file)) }
                if let url = components.url { NSWorkspace.shared.open(url) }
            }
        model.presentationChanged = { [weak self] in self?.sync() }
        model.showSettings = { [weak self] in self?.showSettings() }
        model.showMedia = { [weak self] selection in self?.showMedia(selection) }
    }

    public func start(showSettings: Bool = false) {
        rebuildPanels()
        localMouse = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
            [weak self] event in
            self?.collapseIfOutside(event)
            return event
        }
        globalMouse = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
            [weak self] event in
            self?.collapseIfOutside(event)
        }
        keyboard = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            return self.handleKey(event)
        }
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.rebuildPanels() } }
        model.start()
        if showSettings { self.showSettings() }
    }

    public func stop() {
        model.stop()
        modules.removeAllSurfaces()
        for monitor in [localMouse, globalMouse, keyboard].compactMap({ $0 }) {
            NSEvent.removeMonitor(monitor)
        }
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        panels.values.forEach { $0.hide() }
        settings?.close()
        mediaWindow?.close()
    }

    public func registerModule(_ module: WidgetModuleDescriptor) throws {
        try modules.register(module)
        if display != nil { rebuildPanels() }
    }

    private func compactHeight(_ ids: [String]) -> CGFloat {
        50 + CGFloat(max(1, ids.count)) * 39 + (ids.contains("agents") ? 76 : 0)
    }

    private func moduleIDs(for surface: WidgetSurfaceID) -> [String] {
        let available = Set(modules.modules.map(\.id))
        if surface.edge == .top { return model.layout.top(available: available) }
        let groups = model.layout.groups(available: available)
        return groups.indices.contains(surface.group) ? groups[surface.group] : []
    }

    private func selectedModule(for surface: WidgetSurfaceID) -> WidgetModuleDescriptor? {
        let ids = moduleIDs(for: surface)
        let selected = model.moduleSelections[surface.key]
        return ids.first(where: { $0 == selected }).flatMap(modules.module)
            ?? ids.first.flatMap(modules.module)
    }

    private func rebuildPanels() {
        let previous = Set(panels.keys)
        panels.values.forEach { $0.hide() }
        panels = [:]
        let requested = NSScreen.screens.first { Self.id($0) == screenID }
        guard let screen = requested ?? NSScreen.main ?? NSScreen.screens.first else { return }
        display = screen
        lastDisplayID = screenID
        let cutout: CGFloat
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea,
            let right = screen.auxiliaryTopRightArea
        {
            cutout = screen.frame.width - left.width - right.width
        } else {
            cutout = 0
        }
        topHeaderHeight = max(36, screen.safeAreaInsets.top + 6)
        topCompactWidth = max(360, cutout + 260)
        availableCardHeight = min(660, screen.visibleFrame.height - 20)
        lastSide = model.side
        var layout = model.layout
        layout.sidePosition = 0.5
        lastLayout = layout
        let sideGroups = layout.groups(available: Set(modules.modules.map(\.id)))
        let surfaces =
            [WidgetSurfaceID(edge: .top)]
            + sideGroups.indices.map { WidgetSurfaceID(edge: model.side, group: $0) }
        for surface in surfaces {
            let ids = moduleIDs(for: surface)
            model.resolveModules(ids, on: surface)
            let top = surface.edge == .top
            let compact = CGSize(
                width: top ? topCompactWidth : 44,
                height: top ? topHeaderHeight : compactHeight(ids))
            panels[surface] = EdgePanelController(
                placement: surface.edge, screen: screen, compactSize: compact,
                expandedSize: CGSize(width: top ? 432 : 476, height: 600),
                title: top ? "Widgets · top" : "Widgets · side \(surface.group + 1)"
            ) {
                WidgetHostView(
                    model: model, registry: modules, surface: surface, moduleIDs: ids,
                    cutout: cutout, headerHeight: topHeaderHeight,
                    visibleHeight: screen.visibleFrame.height)
            }
        }
        for surface in previous.subtracting(panels.keys) { modules.update(surface: surface, moduleID: nil) }
        sync()
    }

    private func sync() {
        if model.expanded != nil, settings?.isVisible == true {
            settings?.orderOut(nil)
            model.dialogOpen = mediaWindow?.isVisible == true
        }
        var layout = model.layout
        layout.sidePosition = 0.5
        if lastSide != model.side || lastLayout != layout || lastDisplayID != screenID {
            rebuildPanels()
            return
        }
        guard let screen = display else { return }
        let sideSurfaces = panels.keys.filter { $0.edge != .top }.sorted { $0.group < $1.group }
        var sideHeights = sideSurfaces.map { surface -> CGFloat in
            let compact = compactHeight(moduleIDs(for: surface))
            let module = selectedModule(for: surface)
            switch model.presentation(for: surface) {
            case .compact: return compact
            case .preview: return max(compact, 245)
            case .expanded:
                let height = module?.id == "agents" ? model.preferredHeight : (module?.expandedSize.height ?? 440)
                return max(compact, min(availableCardHeight, height + 40))
            }
        }
        let gaps = CGFloat(max(0, sideSurfaces.count - 1)) * 12
        let total = sideHeights.reduce(0, +) + gaps
        if total > screen.visibleFrame.height {
            let scale = (screen.visibleFrame.height - gaps) / max(1, sideHeights.reduce(0, +))
            sideHeights = sideHeights.map { max(1, $0 * scale) }
        }
        model.sideClusterHeight = sideHeights.reduce(0, +) + gaps
        let centers = WidgetClusterGeometry.centers(
            heights: sideHeights, position: model.sidePosition, visible: screen.visibleFrame)
        for (surface, controller) in panels {
            let top = surface.edge == .top
            let visible = model.placement == "both" || (model.placement == "top" ? top : !top)
            guard visible else {
                controller.hide()
                modules.update(surface: surface, moduleID: nil)
                continue
            }
            let module = selectedModule(for: surface)
            let presentation = model.presentation(for: surface)
            let contentHeight = module?.id == "agents" ? model.preferredHeight : (module?.expandedSize.height ?? 440)
            let width = module?.expandedSize.width ?? 432
            if top {
                controller.setExpandedSize(
                    CGSize(
                        width: max(topCompactWidth, width),
                        height: min(availableCardHeight, contentHeight + 40) + topHeaderHeight))
                controller.setPreviewSize(CGSize(width: max(topCompactWidth, width), height: 245 + topHeaderHeight))
            } else if let index = sideSurfaces.firstIndex(of: surface) {
                controller.setSideCenterY(centers[index])
                controller.setCompactSize(CGSize(width: 44, height: sideHeights[index]))
                controller.setPreviewSize(CGSize(width: 324, height: sideHeights[index]))
                controller.setExpandedSize(CGSize(width: width + 44, height: sideHeights[index]))
            }
            controller.show()
            controller.setPresentation(presentation, reduceMotion: model.effectiveReduceMotion || model.draggingSide)
            modules.update(surface: surface, moduleID: module?.id, presentation: presentation)
        }
    }

    public func showSettings() {
        model.collapse()
        if let settingsPresenter {
            settingsPresenter("widgets.general")
            return
        }
        if settings == nil {
            let view = WidgetSettingsView(
                model: model, display: screenID,
                onDisplay: { [weak self] id in
                    UserDefaults.standard.set(id, forKey: "widget.display")
                    self?.rebuildPanels()
                })
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 660, height: 670),
                styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered,
                defer: false)
            window.title = "Widget sessions"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: view)
            window.appearance = NSAppearance(named: .darkAqua)
            window.minSize = NSSize(width: 590, height: 500)
            window.center()
            window.delegate = self
            settings = window
        }
        model.dialogOpen = true
        settings?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showMedia(_ selection: WidgetMediaSelection) {
        mediaWindow?.close()
        let surface = WidgetSurfaceID(
            edge: model.expanded ?? model.side, group: model.expanded == .top ? 0 : model.activeSideGroup)
        let anchor = panels[surface]?.panel
        guard let screen = anchor?.screen ?? NSScreen.main else { return }
        let frame = EdgePanelGeometry.mediaFrame(
            anchor: anchor?.frame ?? screen.visibleFrame, visible: screen.visibleFrame)
        let window = NSWindow(
            contentRect: frame, styleMask: [.titled, .closable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Media"
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = NSHostingView(
            rootView: WidgetMediaView(model: model, selection: selection) { [weak self] in
                self?.mediaWindow?.close()
            }.widgetAccessibility(
                reduceMotion: model.reduceMotion, reduceTransparency: model.reduceTransparency))
        window.minSize = NSSize(width: min(600, frame.width), height: min(520, frame.height))
        window.setFrame(frame, display: true)
        window.delegate = self
        mediaWindow = window
        model.dialogOpen = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === mediaWindow {
            mediaWindow = nil
            model.dialogOpen = settings?.isVisible == true
        }
        if notification.object as? NSWindow === settings {
            model.dialogOpen = false
            settings = nil
        }
    }

    private func collapseIfOutside(_ event: NSEvent) {
        guard event.timestamp > model.openedAt, model.expanded != nil, !model.dialogOpen else { return }
        var window = event.window
        while let candidate = window {
            if panels.values.contains(where: { $0.panel === candidate }) { return }
            window = candidate.sheetParent ?? candidate.parent
        }
        let point =
            event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
        guard !panels.values.contains(where: { $0.panel.isVisible && $0.panel.frame.contains(point) })
        else { return }
        model.collapse()
    }

    private func handleKey(_ event: NSEvent) -> NSEvent? {
        guard let expanded = model.expanded,
            let panel = panels[WidgetSurfaceID(edge: expanded, group: expanded == .top ? 0 : model.activeSideGroup)]?
                .panel,
            event.window === panel, panel.isKeyWindow
        else { return event }
        let active = WidgetSurfaceID(edge: expanded, group: expanded == .top ? 0 : model.activeSideGroup)
        let isAgent = selectedModule(for: active)?.id == "agents"
        if isAgent, event.modifierFlags.contains(.command),
            event.charactersIgnoringModifiers?.lowercased() == "v"
        {
            return model.pasteMedia() ? nil : event
        }
        guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty else {
            return event
        }
        if event.keyCode == 53 {
            model.collapse()
            return nil
        }
        guard isAgent else { return event }
        if panel.firstResponder is NSTextView { return event }
        if let control = panel.firstResponder as? NSControl, control.currentEditor() != nil {
            return event
        }
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if key == "j" {
            model.next(-1)
            return nil
        }
        if key == "k" {
            model.next()
            return nil
        }
        if let number = AgentWidgetKeyboard.choiceNumber(keyCode: event.keyCode, characters: key),
            let card = model.card, card.needsAnswer, card.kind == "decision", number <= card.choices.count
        {
            model.submit(choice: card.choices[number - 1].id)
            return nil
        }
        return event
    }

    public static func id(_ screen: NSScreen) -> String {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.stringValue
            ?? screen.localizedName
    }
}

private struct WidgetSettingsView: View {
    @ObservedObject var model: WidgetModel
    @State var display: String
    let onDisplay: (String) -> Void
    @State private var query = ""
    @State private var account = ""

    private var all: [WidgetSession] { model.snapshot?.sessions ?? [] }
    private var filtered: [WidgetSession] {
        all.filter {
            query.isEmpty
                || ($0.title + " " + $0.project + " " + $0.target.provider)
                    .localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                GenesisWidgetMark()
                VStack(alignment: .leading, spacing: 3) {
                    Text("Your agents, within reach").font(.title2.weight(.semibold))
                    Text("Pin sessions, filter projects, and choose where the inbox lives.").font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Open Hub") { model.openHub?(model.selected) }
            }
            HStack {
                Picker(
                    "Placement",
                    selection: Binding(
                        get: { model.placement }, set: { preferences(["placement": .string($0)]) })
                ) {
                    Text("Top").tag("top")
                    Text("Side").tag("side")
                    Text("Both").tag("both")
                }.pickerStyle(.segmented)
                Picker(
                    "Edge",
                    selection: Binding(
                        get: { model.side.rawValue }, set: { preferences(["side": .string($0)]) })
                ) {
                    Text("Right").tag("right")
                    Text("Left").tag("left")
                }.frame(width: 130)
                Button("Open") { model.open(model.placement == "top" ? .top : model.side) }
            }
            HStack {
                Picker("Display", selection: $display) {
                    Text("Main display").tag("")
                    ForEach(NSScreen.screens, id: \.self) {
                        Text($0.localizedName).tag(WidgetCoordinator.id($0))
                    }
                }.onChange(of: display) { _, value in onDisplay(value) }
                Toggle("Reduce motion", isOn: $model.reduceMotion)
                    .onChange(of: model.reduceMotion) { _, _ in model.presentationChanged?() }
                Toggle("Opaque", isOn: $model.reduceTransparency)
            }.font(.caption).toggleStyle(.checkbox)
            HStack {
                Menu("Projects (\(model.snapshot?.state.preferences.projects.count ?? 0))") {
                    Button("All projects") { preferences(["projects": []]) }
                    Divider()
                    ForEach(Array(Set(all.map { $0.target.cwd })).sorted(), id: \.self) { cwd in
                        let selected = model.snapshot?.state.preferences.projects.contains(cwd) == true
                        Button {
                            var values = model.snapshot?.state.preferences.projects ?? []
                            if selected { values.removeAll { $0 == cwd } } else { values.append(cwd) }
                            preferences(["projects": .array(values.map(WidgetJSON.string))])
                        } label: {
                            Label(
                                cwd.isEmpty ? "Unassigned" : URL(fileURLWithPath: cwd).lastPathComponent,
                                systemImage: selected ? "checkmark" : "folder")
                        }
                    }
                }
                Menu("Sessions (\(model.snapshot?.state.preferences.sessions.count ?? 0))") {
                    Button("All sessions") { preferences(["sessions": []]) }
                    Divider()
                    ForEach(all) { session in
                        let selected = model.snapshot?.state.preferences.sessions.contains(session.key) == true
                        Button {
                            var values = model.snapshot?.state.preferences.sessions ?? []
                            if selected {
                                values.removeAll { $0 == session.key }
                            } else {
                                values.append(session.key)
                            }
                            preferences(["sessions": .array(values.map(WidgetJSON.string))])
                        } label: {
                            Label(session.title, systemImage: selected ? "checkmark" : "circle")
                        }
                    }
                }
                Button("Reset filters") { preferences(["projects": [], "sessions": []]) }
                Spacer()
                Text(
                    "\(all.filter(\.hiddenByFilter).count) filtered · \(all.filter { !$0.pinned }.count) unpinned"
                ).font(.caption).foregroundStyle(.secondary)
            }
            TextField("Find a session or project", text: $query).textFieldStyle(.roundedBorder)
            List(filtered) { session in
                HStack(spacing: 10) {
                    Circle().fill(session.visualStatus.color).frame(width: 7, height: 7)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.title).lineLimit(1)
                        Text(session.target.provider.capitalized + " · " + session.project).font(.caption2)
                            .foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    if session.hiddenByFilter { Text("Filtered").font(.caption2).foregroundStyle(.secondary) }
                    Button {
                        model.action([
                            "action": "visibility", "key": .string(session.key), "pinned": .bool(!session.pinned),
                        ])
                    } label: {
                        Image(systemName: session.pinned ? "pin.fill" : "pin")
                    }.buttonStyle(.plain).help(session.pinned ? "Unpin from widget" : "Show in widget")
                        .accessibilityLabel((session.pinned ? "Unpin " : "Pin ") + session.title)
                    Button("Open") {
                        model.select(session.key, edge: model.placement == "top" ? .top : model.side)
                    }
                    .font(.caption).disabled(!session.pinned || session.hiddenByFilter)
                    .accessibilityLabel("Open " + session.title)
                }.accessibilityElement(children: .contain)
            }.listStyle(.inset)
            Toggle(
                "Show changed files",
                isOn: Binding(
                    get: { model.snapshot?.state.preferences.showChanges ?? false },
                    set: { preferences(["showChanges": .bool($0)]) })
            ).toggleStyle(.switch).font(.caption)
            HStack {
                Picker(
                    "Dictation",
                    selection: Binding(
                        get: { model.snapshot?.state.preferences.voiceProvider ?? "openai" },
                        set: { preferences(["voiceProvider": .string($0)]) })
                ) {
                    ForEach(["openai", "xai", "deepgram", "elevenlabs"], id: \.self) {
                        Text($0.capitalized).tag($0)
                    }
                }
                TextField("Account (default if empty)", text: $account)
                    .onSubmit { preferences(["voiceAccount": account.isEmpty ? .null : .string(account)]) }
                TextField(
                    "Language",
                    text: Binding(
                        get: { model.snapshot?.state.preferences.voiceLanguage ?? "en" },
                        set: { preferences(["voiceLanguage": .string($0)]) })
                ).frame(width: 55)
            }.font(.caption)
            Text(
                "Voice uses your configured provider account. Recordings become editable text before you send."
            )
            .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(22).preferredColorScheme(.dark)
        .onAppear { account = model.snapshot?.state.preferences.voiceAccount ?? "" }
    }
    private func preferences(_ patch: [String: WidgetJSON]) {
        model.action(["action": "preferences", "patch": .object(patch)])
    }
}
