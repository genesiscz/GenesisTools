import AppKit
import SwiftUI

@MainActor
public final class WidgetCoordinator: NSObject, NSWindowDelegate {
    public let model: WidgetModel
    private var panels: [EdgePanelPlacement: EdgePanelController<LiveWidgetView>] = [:]
    private var settings: NSWindow?
    private var localMouse: Any?
    private var globalMouse: Any?
    private var keyboard: Any?
    private var screenObserver: NSObjectProtocol?
    private var lastSide: EdgePanelPlacement?
    private var topHeaderHeight: CGFloat = 36
    private var availableCardHeight: CGFloat = 660
    private var screenID: String {
        UserDefaults.standard.string(forKey: "widget.display") ?? ""
    }

    public init(
        binaryPath: String, stateRoot: String? = nil, openHub: @escaping (WidgetSession?) -> Void,
        openDestination: ((WidgetSession, String, String?) -> Void)? = nil
    ) {
        model = WidgetModel(binaryPath: binaryPath, stateRoot: stateRoot)
        super.init()
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
        for monitor in [localMouse, globalMouse, keyboard].compactMap({ $0 }) {
            NSEvent.removeMonitor(monitor)
        }
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        panels.values.forEach { $0.hide() }
        settings?.close()
    }

    private func rebuildPanels() {
        panels.values.forEach { $0.hide() }
        panels = [:]
        let requested = NSScreen.screens.first { Self.id($0) == screenID }
        guard let screen = requested ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let cutout: CGFloat
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea,
            let right = screen.auxiliaryTopRightArea
        {
            cutout = screen.frame.width - left.width - right.width
        } else {
            cutout = 0
        }
        let topHeight = max(36, screen.safeAreaInsets.top + 6)
        topHeaderHeight = topHeight
        availableCardHeight = min(660, screen.visibleFrame.height - 20)
        let side = model.side
        lastSide = side
        panels[.top] = EdgePanelController(
            placement: .top, screen: screen,
            compactSize: CGSize(width: max(290, cutout + 180), height: topHeight),
            expandedSize: CGSize(
                width: 432, height: min(660, screen.visibleFrame.height - 20) + topHeight),
            title: "Agents · top"
        ) {
            LiveWidgetView(model: model, edge: .top, cutout: cutout, compactHeight: topHeight)
        }
        panels[side] = EdgePanelController(
            placement: side, screen: screen, compactSize: CGSize(width: 38, height: 300),
            expandedSize: CGSize(width: 470, height: min(660, screen.visibleFrame.height - 20)),
            title: "Agents · side"
        ) {
            LiveWidgetView(model: model, edge: side)
        }
        sync()
    }

    private func sync() {
        if lastSide != model.side {
            rebuildPanels()
            return
        }
        for (edge, controller) in panels {
            let visible =
                model.placement == "both" || (model.placement == "top" ? edge == .top : edge != .top)
            if visible {
                if edge != .top { controller.setCompactSize(CGSize(width: 38, height: model.hasActivity ? 300 : 78)) }
                if !model.dialogOpen {
                    controller.setExpandedSize(
                        CGSize(
                            width: edge == .top ? 432 : 470,
                            height: min(model.preferredHeight, availableCardHeight)
                                + (edge == .top ? topHeaderHeight : 0)))
                }
                controller.show()
                controller.setExpanded(model.expanded == edge, reduceMotion: model.effectiveReduceMotion)
            } else {
                controller.hide()
                if model.expanded == edge { model.collapse() }
            }
        }
    }

    public func showSettings() {
        model.collapse()
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

    public func windowWillClose(_ notification: Notification) {
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
        guard let expanded = model.expanded, let panel = panels[expanded]?.panel,
            event.window === panel, panel.isKeyWindow
        else { return event }
        if event.modifierFlags.contains(.command),
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
