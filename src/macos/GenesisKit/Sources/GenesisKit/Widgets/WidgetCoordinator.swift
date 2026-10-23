import AppKit
import SwiftUI

@MainActor
public final class WidgetCoordinator: NSObject, NSWindowDelegate {
    public let model: WidgetModel
    public let modules = WidgetModuleRegistry()
    private var shelf: WidgetShelfStore?
    private var tasks: WidgetTasksStore?
    private var voiceNotes: WidgetVoiceNotesStore?
    public let flowRuntime: FlowFocusRuntime
    public let transforms: FlowTransformTools
    private var runtimeStart: Task<Void, Never>?
    private var shutdownTask: Task<Void, Never>?
    private var started = false
    private var stopped = false
    private var featureSettings: FeatureSettingsWindowController?
    private var panels: [WidgetSurfaceID: EdgePanelController<WidgetHostView>] = [:]
    /// Screen center of each side rail, from the last `sync()`. Every layout pass of a rail reads it.
    private var railCenters: [WidgetSurfaceID: CGFloat] = [:]
    /// The window height of each surface when it is expanded, from the last `sync()`. A pane built ahead of the
    /// expansion takes this height, so opening does not lay it out again.
    private var expandedWindowHeights: [WidgetSurfaceID: CGFloat] = [:]
    /// The Agents pane never fits below this, so a nearly empty inbox still reads as a panel.
    static let minimumAgentHeight: CGFloat = 320
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
    private var lastShown: Bool?
    /// A launch that waits for the first snapshot, because only the snapshot says whether the widget is on.
    private var launchPending = false
    private var pendingSessionKey: String?
    /// The surface a shelf capture started from; it reopens there when the image is staged.
    private var captureReturn: WidgetSurfaceID?
    public var settingsPresenter: ((String) -> Void)?
    /// Expanded panels leave the keyboard where it is and stay open through clicks elsewhere (the `passive` test
    /// command): a scripted motion check on the user's screen opens panels without taking the keyboard from the app
    /// they work in, and their clicks there do not close the panel under test.
    public var passivePanels = false {
        didSet { panels.values.forEach { $0.becomesKeyOnExpand = !passivePanels } }
    }
    /// Orders one edge panel front. Tests replace it to prove a hidden widget never shows a panel.
    var orderFront: (EdgePanelController<WidgetHostView>) -> Void = { $0.show() }
    var panelCount: Int { panels.count }
    var panelMonitorsInstalled: Bool { localMouse != nil || globalMouse != nil || keyboard != nil }
    /// "Show the widget" in the Widget settings. Off until the first snapshot says otherwise.
    public var panelsEnabled: Bool { model.snapshot?.state.preferences.showWidget ?? false }
    private var topHeaderHeight: CGFloat = 36
    private var topCompactWidth: CGFloat = 360
    private var screenID: String {
        model.snapshot?.state.preferences.display
            ?? UserDefaults.standard.string(forKey: "widget.display") ?? ""
    }

    public init(
        binaryPath: String, stateRoot: String? = nil, flowRuntime: FlowFocusRuntime? = nil,
        micLauncher: String? = nil, openHub: @escaping (WidgetSession?) -> Void,
        openDestination: ((WidgetSession, String, String?) -> Void)? = nil, model injected: WidgetModel? = nil
    ) {
        model = injected ?? WidgetModel(binaryPath: binaryPath, stateRoot: stateRoot)
        let runtime = flowRuntime ?? .shared
        self.flowRuntime = runtime
        transforms = FlowTransformTools(bridge: model.bridge, configuration: runtime.configuration)
        super.init()
        FlowFocusHost.shared.openSettings = { [weak self] in self?.showSettings(pageID: "focus.general") }
        FlowFocusHost.shared.runTransform = { [weak transforms] request in
            guard let transforms else { throw CancellationError() }
            return try await transforms.run(request)
        }
        let shelf = WidgetShelfStore(
            binaryPath: binaryPath, stateRoot: stateRoot,
            recipients: { [weak model] in model?.snapshot?.sessions ?? [] },
            didAttach: { [weak self] session in self?.showShelfDraft(for: session) },
            onCaptureWillBegin: { [weak self] in
                guard let self else { return }
                // Expanded, or the hover preview the Capture button was pressed in.
                self.captureReturn = self.model.expanded.map {
                    WidgetSurfaceID(edge: $0, group: $0 == .top ? 0 : self.model.activeSideGroup)
                } ?? self.model.hoveredSurface
                self.model.collapse()
            },
            onCaptureStaged: { [weak self] in
                guard let self, let surface = self.captureReturn else { return }
                self.captureReturn = nil
                // The selection overlay is gone; show the new capture arriving in the shelf it was taken from.
                if self.model.expanded == nil { self.model.openModule("capture", on: surface) }
            },
            onDialogVisibilityChanged: { [weak self] visible in
                guard let self else { return }
                self.model.dialogOpen = visible || self.settings?.isVisible == true || self.mediaWindow?.isVisible == true
            },
            attachToDraft: { [weak model] item, recipient in
                guard let model else { throw CancellationError() }
                try await model.attachShelfItem(item.id, to: recipient.key)
            })
        self.shelf = shelf
        let tasks = WidgetTasksStore(
            binaryPath: binaryPath,
            sessions: { [weak model] in model?.snapshot?.sessions ?? [] },
            openSession: { [weak self] session, cardID in
                self?.showShelfDraft(for: session)
                self?.model.selectedCardID = cardID
            })
        self.tasks = tasks
        let voiceNotes = WidgetVoiceNotesStore(binaryPath: binaryPath, stateRoot: stateRoot,
            micLauncher: micLauncher ?? "", acquireAudio: { try await runtime.acquireExternalAudio() },
            settings: { [weak model] in
                let preferences = model?.snapshot?.state.preferences
                return WidgetVoiceNoteSettings(provider: preferences?.voiceProvider ?? "xai",
                    account: preferences?.voiceAccount, model: preferences?.voiceModel, language: preferences?.voiceLanguage)
            }, sessions: { [weak model] in model?.snapshot?.sessions ?? [] },
            attachDraft: { [weak self, weak model] session, note in
                guard let model else { throw CancellationError() }
                try await model.attachVoiceNote(note, to: session.key)
                self?.showShelfDraft(for: session)
                return "Added to \(session.title)'s draft. Nothing has been sent."
            })
        voiceNotes.recipientPickerVisibilityChanged = { [weak self] visible in
            guard let self else { return }
            self.model.dialogOpen = visible || self.settings?.isVisible == true || self.mediaWindow?.isVisible == true
        }
        self.voiceNotes = voiceNotes
        // The reply box's microphone dictates live in place; a voice note keeps its audio in Voice Notes without
        // opening that panel (Martin, 2026-10-23: "should not open another widget but just let me dictate").
        model.voiceNoteClip = { [weak voiceNotes] in
            guard let voiceNotes else { throw CancellationError() }
            return try await voiceNotes.newIncomingClipPath()
        }
        model.fileVoiceNote = { [weak voiceNotes, weak model] clip, text, context in
            guard let voiceNotes, let prefs = model?.snapshot?.state.preferences else { return }
            voiceNotes.fileLiveNote(clip: clip, text: text, context: context, provider: prefs.voiceProvider,
                                    model: prefs.voiceModel, language: prefs.voiceLanguage)
        }
        do {
            try modules.register(
                WidgetModuleDescriptor(
                    id: WidgetModuleChoice.agents.id, title: WidgetModuleChoice.agents.title,
                    symbol: WidgetModuleChoice.agents.symbol, tint: .blue,
                    summary: { [weak model] in model?.selected?.title ?? "Your local agents" }
                ) { [model] presentation in AgentWidgetModuleView(model: model, presentation: presentation) })
            try modules.register(shelf.captureModule())
            try modules.register(shelf.shelfModule())
            try modules.register(tasks.taskModule())
            try modules.register(FlowWidget.module(runtime: runtime))
            try modules.register(voiceNotes.voiceNotesModule())
        } catch { model.error = error.localizedDescription }
        model.openHub = openHub
        model.openDestination =
            openDestination ?? { [weak model] session, mode, file in
                guard let executable = Bundle.main.executableURL else { return }
                let child = Process()
                child.executableURL = executable
                child.arguments = [
                    "--hub", "--mode", "sessions", "--session", session.target.sessionId,
                    "--widget-destination", mode, "--widget-cwd", session.target.cwd,
                    "--widget-provider", session.target.provider,
                ] + (file.map { ["--widget-context", $0] } ?? [])
                child.standardInput = FileHandle.nullDevice
                child.standardOutput = FileHandle.nullDevice
                child.standardError = FileHandle.nullDevice
                do { try child.run() } catch {
                    model?.error = "Could not open the destination: " + error.localizedDescription
                    PerfLog.mark("widget.destination launch \(error.localizedDescription)")
                }
            }
        model.presentationChanged = { [weak self] in self?.sync() }
        model.pointerChanged = { [weak self] surface, inside in
            guard let motion = self?.panels[surface]?.motion, motion.pointerInside != inside else { return }
            motion.pointerInside = inside
        }
        model.showSettings = { [weak self] in self?.showSettings() }
        model.showSettingsPage = { [weak self] in self?.showSettings(pageID: $0) }
        model.showMedia = { [weak self] selection in self?.showMedia(selection) }
        model.inboxArrived = { [weak self] items in self?.alert(items) }
    }

    /// A main-spin with a panel open: the panel closes, so the app answers again, and says why. The spin's stack and
    /// the bodies it evaluated are already in app-perf.log (HangWatch). Not a setting: it recovers from a bug, and the
    /// other way is an app that does not respond.
    func recoverFromSpin(_ seconds: CFAbsoluteTime) {
        guard model.expanded != nil else { return }
        PerfLog.mark("widget.spin-recovered after \(Int(seconds))s section=\(model.section) overview=\(model.inboxOverview)")
        model.collapse()
        model.notice = "The panel closed: it redrew for \(Int(seconds)) s without a pause. The details are in app-perf.log."
    }

    /// Plays the alert chime. Tests replace it.
    var playChime: (String?) -> Void = { WidgetAlerts.chime($0) }

    /// New decisions, questions and answers: one chime, and the newest item pops up in the agents preview.
    func alert(_ items: [WidgetInboxItem]) {
        guard panelsEnabled else { return }
        let preferences = model.snapshot?.state.preferences
        let wanted = WidgetAlerts.wanted(items, preferences: preferences)
        guard let item = WidgetAlerts.popupItem(wanted) else { return }
        PerfLog.mark("widget.alert items=\(wanted.count) id=\(item.id) kind=\(item.kind)")
        playChime(WidgetAlerts.sound(for: wanted, preferences: preferences))
        // The session that asked flashes on its rail bubble and in the lists, popup or not: it says why the widget
        // chimed or opened (Martin, 2026-10-23).
        model.flashAttention(item.key, seconds: WidgetAlerts.flashSeconds(preferences))
        // Checked before the module switch: a popup the user's interaction refuses must not swap the pane they use.
        guard preferences?.alertPopup ?? true, let surface = peekSurface(), model.canPeek(on: surface) else { return }
        // The peek shows the agents module and gives the user's own module back when it ends.
        model.showPeek(item, on: surface, module: moduleIDs(for: surface).contains("agents") ? "agents" : nil)
    }

    /// The visible edge whose selected module is the agents inbox, else the first visible edge that has it.
    private func peekSurface() -> WidgetSurfaceID? {
        let visible = panels.keys.filter { surface in
            let top = surface.edge == .top
            return (model.placement == "both" || (model.placement == "top" ? top : !top))
                && moduleIDs(for: surface).contains("agents")
        }.sorted { $0.key < $1.key }
        return visible.first { selectedModule(for: $0)?.id == "agents" } ?? visible.first
    }

    /// Without `showSettings`, a widget that is off opens the settings once the first snapshot arrives,
    /// so the user sees why no panel appeared; `settingsWhenOff: false` (a background relaunch) never does.
    public func start(showSettings: Bool = false, settingsWhenOff: Bool = true) {
        guard !started, !stopped else { return }
        started = true
        HangWatch.onSpin = { [weak self] seconds in self?.recoverFromSpin(seconds) }
        runtimeStart = Task { [flowRuntime] in await flowRuntime.start() }
        rebuildPanels()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.rebuildPanels() } }
        launchPending = !showSettings && settingsWhenOff
        model.start()
        if showSettings { self.showSettings() }
    }

    public func shutdown() async {
        if let shutdownTask { await shutdownTask.value; return }
        let task = Task { [self] in
            stop()
            await voiceNotes?.shutdown()
            await runtimeStart?.value
            await flowRuntime.stop()
        }
        shutdownTask = task
        await task.value
    }

    /// Opens a session in the agents panel, or the settings while the widget is off.
    public func openSession(_ key: String) {
        guard model.snapshot != nil else {
            pendingSessionKey = key
            launchPending = true
            return
        }
        model.select(key)
        guard panelsEnabled else {
            showSettings()
            return
        }
        model.openModule("agents", on: WidgetSurfaceID(edge: model.placement == "top" ? .top : model.side))
    }

    private func resolvePendingLaunch() {
        guard launchPending, model.snapshot != nil else { return }
        launchPending = false
        if let key = pendingSessionKey {
            pendingSessionKey = nil
            openSession(key)
        } else if !panelsEnabled {
            showSettings()
        }
    }

    private func installPanelMonitors() {
        if localMouse == nil {
            localMouse = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
                [weak self] event in
                self?.collapseIfOutside(event)
                return event
            }
        }
        if globalMouse == nil {
            globalMouse = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
                [weak self] event in
                self?.collapseIfOutside(event)
            }
        }
        if keyboard == nil {
            keyboard = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self else { return event }
                return self.handleKey(event)
            }
        }
    }

    private func removePanelMonitors() {
        for monitor in [localMouse, globalMouse, keyboard].compactMap({ $0 }) {
            NSEvent.removeMonitor(monitor)
        }
        localMouse = nil
        globalMouse = nil
        keyboard = nil
    }

    public func stop() {
        guard !stopped else { return }
        stopped = true
        runtimeStart?.cancel()
        voiceNotes?.stop()
        shelf?.stop()
        tasks?.stop()
        model.stop()
        modules.removeAllSurfaces()
        removePanelMonitors()
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
        WidgetSideStripMetrics(
            classic: model.snapshot?.state.preferences.sideStyle == "classic",
            moduleIDs: ids, visibleSessionCount: model.railActivitySessions.count, hasInboxBadge: model.inboxCount > 0
        ).minimumHeight
    }

    private func compactSideAllocation() -> (surfaces: [WidgetSurfaceID], heights: [CGFloat], gap: CGFloat) {
        guard let screen = display else { return ([], [], 0) }
        let surfaces = panels.keys.filter { $0.edge != .top }.sorted { $0.group < $1.group }
        let heights = surfaces.map { compactHeight(moduleIDs(for: $0)) }
        let allocation = WidgetClusterGeometry.allocate(
            heights: heights.map { ($0, $0) }, visibleHeight: screen.visibleFrame.height)
        return (surfaces, allocation.heights, allocation.gap)
    }

    private func compactRailCenter(for surface: WidgetSurfaceID) -> CGFloat? {
        surface.edge == .top ? nil : railCenters[surface]
    }

    /// The expanded content height of a surface: the Agents pane fits its measured content up to
    /// `maximumContentHeight` (W3), so opening a card or its Source and context grows the panel; other modules keep
    /// their declared size.
    private func expandedContentHeight(
        _ surface: WidgetSurfaceID, module: WidgetModuleDescriptor?, visible: CGSize
    ) -> CGFloat {
        guard module?.id == "agents" else { return (module?.expandedSize.height ?? 440) + 40 }
        let fitted = WidgetClusterGeometry.fittedHeight(
            measured: model.agentFitHeight, minimum: Self.minimumAgentHeight,
            maximum: WidgetClusterGeometry.maximumContentHeight(visible: visible))
        let row = surface.edge == .top && moduleIDs(for: surface).count > 1 ? WidgetHostView.topModuleRowHeight : 0
        return fitted + row
    }

    private func panelShape(_ surface: WidgetSurfaceID, _ presentation: WidgetModulePresentation) -> EdgePanelShape {
        let preferences = model.snapshot?.state.preferences
        return WidgetHostView.panelShape(
            edge: surface.edge, presentation: presentation,
            classic: surface.edge != .top && preferences?.sideStyle == "classic",
            joined: preferences?.joinedEdges ?? true)
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
        let previous = panels
        // The one gate for the edge panels: while "Show the widget" is off, none exist and no monitor runs.
        lastShown = panelsEnabled
        guard panelsEnabled else {
            previous.values.forEach { $0.hide() }
            panels = [:]
            removePanelMonitors()
            display = nil
            for surface in previous.keys { modules.update(surface: surface, moduleID: nil) }
            if model.expanded != nil { model.collapse() }
            return
        }
        installPanelMonitors()
        // "Main display" (an empty ID) is the display with the menu bar, as in System Settings. NSScreen.main is the
        // display with keyboard focus, so it put the widget on whichever display the user worked on at launch.
        let requested = NSScreen.screens.first { Self.id($0) == screenID }
        guard let screen = requested ?? NSScreen.screens.first else { return }
        let sameDisplay = display.map { Self.id($0) == Self.id(screen) && $0.frame == screen.frame } ?? false
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
        if !sameDisplay {
            topHeaderHeight = max(36, screen.safeAreaInsets.top + 6)
            topCompactWidth = WidgetClusterGeometry.topWidth(
                cutout: cutout, moduleCount: moduleIDs(for: WidgetSurfaceID(edge: .top)).count)
        }
        lastSide = model.side
        var layout = model.layout
        layout.sidePosition = 0.5
        lastLayout = layout
        let sideGroups = layout.groups(available: Set(modules.modules.map(\.id)))
        let surfaces =
            [WidgetSurfaceID(edge: .top)]
            + sideGroups.indices.map { WidgetSurfaceID(edge: model.side, group: $0) }
        var nextPanels: [WidgetSurfaceID: EdgePanelController<WidgetHostView>] = [:]
        for surface in surfaces {
            let ids = moduleIDs(for: surface)
            model.resolveModules(ids, on: surface)
            let top = surface.edge == .top
            let compact = CGSize(
                width: top ? topCompactWidth : 44,
                height: top ? topHeaderHeight : compactHeight(ids))
            let motion = sameDisplay ? previous[surface]?.motion ?? EdgePanelMotion() : EdgePanelMotion()
            let content = { [self] in
                WidgetHostView(
                    model: model, registry: modules, motion: motion, surface: surface, moduleIDs: ids,
                    cutout: cutout, headerHeight: topHeaderHeight,
                    headerMinimumHeight: max(36, screen.safeAreaInsets.top + 6),
                    visibleHeight: screen.visibleFrame.height,
                    railScreenCenterY: { [weak self] in self?.compactRailCenter(for: surface) },
                    expandedContentWidth: { [weak self] id in
                        guard id == "agents", let visible = self?.display?.visibleFrame.size else { return nil }
                        return WidgetClusterGeometry.detailSize(visible: visible).width
                    },
                    expandedWindowHeight: { [weak self] in self?.expandedWindowHeights[surface] },
                    topSizeChanged: { [weak self] size in
                        DispatchQueue.main.async { self?.updateTopSize(size) }
                    })
            }
            if sameDisplay, let controller = previous[surface] {
                controller.updateContent(content)
                nextPanels[surface] = controller
            } else {
                nextPanels[surface] = EdgePanelController(
                    placement: surface.edge, screen: screen, compactSize: compact,
                    expandedSize: CGSize(width: top ? 432 : 476, height: 600),
                    title: top ? "Widgets · top" : "Widgets · side \(surface.group + 1)", motion: motion,
                    shape: { [weak self] presentation in
                        self?.panelShape(surface, presentation)
                            ?? EdgePanelShape(placement: surface.edge, shoulder: 0, corner: 0, joined: false)
                    }, content: content)
                nextPanels[surface]?.becomesKeyOnExpand = !passivePanels
            }
        }
        panels = nextPanels
        for (surface, controller) in previous where panels[surface] !== controller {
            controller.hide()
            if panels[surface] == nil { modules.update(surface: surface, moduleID: nil) }
        }
        sync()
    }

    private func updateTopSize(_ size: CGSize) {
        guard size.width > 0, size.height > 0,
              size.width != topCompactWidth || size.height != topHeaderHeight else { return }
        topCompactWidth = size.width
        topHeaderHeight = size.height
        sync()
    }

    private func sync() {
        resolvePendingLaunch()
        if lastShown != panelsEnabled {
            rebuildPanels()
            return
        }
        guard panelsEnabled else {
            if model.expanded != nil { model.collapse() }
            return
        }
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
        let requestedHeights = sideSurfaces.map { surface -> (minimum: CGFloat, preferred: CGFloat) in
            let compact = compactHeight(moduleIDs(for: surface))
            let module = selectedModule(for: surface)
            let preferred: CGFloat
            switch model.presentation(for: surface) {
            case .compact: preferred = compact
            case .preview: preferred = max(compact, module?.id == "agents" ? model.previewHeight : (module?.previewSize.height ?? 310))
            case .expanded:
                preferred = max(compact, expandedContentHeight(surface, module: module, visible: screen.visibleFrame.size))
            }
            return (compact, preferred)
        }
        let compactRequests = sideSurfaces.map { surface -> (minimum: CGFloat, preferred: CGFloat) in
            let compact = compactHeight(moduleIDs(for: surface))
            return (compact, compact)
        }
        for (index, surface) in sideSurfaces.enumerated() {
            var requests = compactRequests
            requests[index].preferred = max(requests[index].minimum, expandedContentHeight(
                surface, module: selectedModule(for: surface), visible: screen.visibleFrame.size))
            expandedWindowHeights[surface] = WidgetClusterGeometry.allocate(
                heights: requests, visibleHeight: screen.visibleFrame.height).heights[index]
        }
        let allocation = WidgetClusterGeometry.allocate(
            heights: requestedHeights, visibleHeight: screen.visibleFrame.height)
        let sideHeights = allocation.heights
        let compactAllocation = compactSideAllocation()
        model.sideClusterHeight = compactAllocation.heights.reduce(0, +)
            + CGFloat(max(0, sideSurfaces.count - 1)) * compactAllocation.gap
        let centers = WidgetClusterGeometry.centers(
            heights: compactAllocation.heights, position: model.sidePosition,
            visible: screen.visibleFrame, gap: compactAllocation.gap)
        railCenters = Dictionary(zip(sideSurfaces, centers), uniquingKeysWith: { first, _ in first })
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
            let detailSize = WidgetClusterGeometry.detailSize(visible: screen.visibleFrame.size)
            let contentHeight = expandedContentHeight(surface, module: module, visible: screen.visibleFrame.size)
            let width = module?.id == "agents" ? detailSize.width : (module?.expandedSize.width ?? 432)
            let previewSize = CGSize(width: module?.previewSize.width ?? 324,
                height: module?.id == "agents" ? model.previewHeight : (module?.previewSize.height ?? 310))
            if top {
                expandedWindowHeights[surface] = min(screen.visibleFrame.height - 20, contentHeight + topHeaderHeight)
                controller.setCompactSize(CGSize(width: topCompactWidth, height: topHeaderHeight))
                controller.setExpandedSize(
                    CGSize(
                        width: max(topCompactWidth, width),
                        height: min(screen.visibleFrame.height - 20, contentHeight + topHeaderHeight)))
                controller.setPreviewSize(
                    CGSize(
                        width: max(topCompactWidth, previewSize.width),
                        height: min(screen.visibleFrame.height - 20, previewSize.height + topHeaderHeight)))
            } else if let index = sideSurfaces.firstIndex(of: surface) {
                controller.setSideCenterY(centers[index])
                controller.setCompactSize(CGSize(width: 44, height: compactAllocation.heights[index]))
                controller.setPreviewSize(CGSize(width: previewSize.width + 44, height: sideHeights[index]))
                controller.setExpandedSize(CGSize(width: width + 44, height: sideHeights[index]))
            }
            controller.setPresentation(presentation, reduceMotion: model.effectiveReduceMotion || model.draggingSide)
            orderFront(controller)
            modules.update(surface: surface, moduleID: module?.id, presentation: presentation)
        }
        if let active = panels.first(where: { model.presentation(for: $0.key) != .compact && $0.key.edge != .top }) {
            for (surface, controller) in panels where surface.edge != .top && surface != active.key && controller.panel.isVisible {
                controller.panel.order(.above, relativeTo: active.value.panel.windowNumber)
            }
        }
    }

    public func showSettings(pageID: String = "widgets.general") {
        model.collapse()
        if let settingsPresenter {
            settingsPresenter(pageID)
            return
        }
        if settings == nil {
            let controller = FeatureSettingsWindowController(title: "Feature settings",
                sections: WidgetFeatureSettings.sections(model: model, modules: WidgetModuleChoice.builtins,
                    flowRuntime: flowRuntime, transforms: transforms,
                    openSession: { [weak self] in self?.showShelfDraft(for: $0) }),
                initialPageID: pageID, appearance: model.appearance)
            featureSettings = controller
            let window = controller.prepare(pageID: pageID)
            window.delegate = self
            settings = window
        }
        featureSettings?.store.select(pageID: pageID)
        model.dialogOpen = true
        settings?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showMedia(_ selection: WidgetMediaSelection) {
        mediaWindow?.close()
        let surface = WidgetSurfaceID(
            edge: model.expanded ?? model.side, group: model.expanded == .top ? 0 : model.activeSideGroup)
        let anchor = panels[surface]?.panel
        guard let screen = anchor?.screen ?? NSScreen.screens.first else { return }
        let frame = EdgePanelGeometry.mediaFrame(
            anchor: anchor?.frame ?? screen.visibleFrame, visible: screen.visibleFrame)
        let window = NSWindow(
            contentRect: frame, styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Media"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
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
            featureSettings = nil
        }
    }

    /// A click outside every panel collapses the open one, except in passive mode: there the user keeps working in
    /// another app while a script opens and closes panels, and each of their clicks closed the panel under test
    /// within a second (2026-10-11).
    func collapseIfOutside(_ event: NSEvent) {
        guard !passivePanels, event.timestamp > model.openedAt, model.expanded != nil, !model.dialogOpen else { return }
        // A dictation keeps the panel, so its words stay in view; Esc or the close button still closes it.
        guard !model.voiceActive else { return }
        var window = event.window
        while let candidate = window {
            if panels.values.contains(where: { $0.panel === candidate }) { return }
            window = candidate.sheetParent ?? candidate.parent
        }
        let point =
            event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
        guard !panels.values.contains(where: { $0.panel.isVisible && $0.panel.frame.contains(point) })
        else { return }
        // A click on another GenesisTools window keeps the panel: the vault key window that a dictation or a send
        // raises took its Allow click as "outside" and closed the panel under it (Martin, 2026-10-23: "allow with touch
        // id does literally hide the widget").
        if Self.ownWindowOwnsPoint(point) { return }
        model.requestCollapse()
    }

    /// The view chain AppKit's hit test picks at a CoreGraphics screen point (top-left origin) in each visible panel, for
    /// the test driver's `hittest` command: accessibility frames can name a control that AppKit never delivers a click
    /// to (a nested hosting view placed outside its parent's bounds).
    public func hitTestDescription(cgPoint: CGPoint) -> String {
        guard let primary = NSScreen.screens.first?.frame else { return "no screen" }
        let point = NSPoint(x: cgPoint.x, y: primary.maxY - cgPoint.y)
        var lines: [String] = []
        for (surface, controller) in panels where controller.panel.isVisible && controller.panel.frame.contains(point) {
            guard let content = controller.panel.contentView else { continue }
            let local = content.convert(controller.panel.convertPoint(fromScreen: point), from: nil)
            var chain: [String] = []
            var view = content.hitTest(local)
            while let current = view, chain.count < 12 {
                chain.append("\(type(of: current))\(current.frame.integral)")
                view = current.superview
            }
            lines.append("\(surface.key): " + (chain.isEmpty ? "nothing" : chain.joined(separator: " < ")))
        }
        return lines.isEmpty ? "no panel at the point" : lines.joined(separator: " | ")
    }

    /// Whether the topmost on-screen window at `point` (AppKit screen coordinates) belongs to a GenesisTools process.
    static func ownWindowOwnsPoint(_ point: NSPoint) -> Bool {
        guard let primary = NSScreen.screens.first?.frame,
              let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[CFString: Any]] else { return false }
        // CoreGraphics measures from the primary screen's top edge, AppKit from its bottom edge.
        let flipped = CGPoint(x: point.x, y: primary.maxY - point.y)
        let bundle = Bundle.main.bundleIdentifier
        for row in rows {
            guard (row[kCGWindowLayer] as? Int ?? 0) < 1000,
                  let bounds = row[kCGWindowBounds] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds), frame.contains(flipped) else { continue }
            guard let pid = row[kCGWindowOwnerPID] as? pid_t else { return false }
            return pid == ProcessInfo.processInfo.processIdentifier
                || (bundle != nil && NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bundle)
        }
        return false
    }

    private func openVoiceNotes(for key: String) {
        voiceNotes?.recipientKey = key
        let candidates = panels.keys.filter { moduleIDs(for: $0).contains("voice") }.sorted { $0.key < $1.key }
        guard let surface = candidates.first(where: { $0.edge == model.expanded }) ?? candidates.first else {
            model.notice = "Enable Voice Notes on an edge to record and attach to this draft."
            showSettings(pageID: "widgets.modules")
            return
        }
        model.openModule("voice", on: surface)
    }

    private func showShelfDraft(for session: WidgetSession) {
        model.select(session.key)
        model.section = "Inbox"
        let candidates = panels.keys.filter { moduleIDs(for: $0).contains("agents") }
            .sorted { $0.key < $1.key }
        let surface = candidates.first { $0.edge == model.expanded } ?? candidates.first
        if let surface {
            model.openModule("agents", on: surface)
        } else {
            model.notice = "Added to the selected session's draft."
            model.openHub?(session)
        }
    }

    private func handleKey(_ event: NSEvent) -> NSEvent? {
        guard let expanded = model.expanded,
            let panel = panels[WidgetSurfaceID(edge: expanded, group: expanded == .top ? 0 : model.activeSideGroup)]?
                .panel,
            event.window === panel, panel.isKeyWindow
        else { return event }
        let active = WidgetSurfaceID(edge: expanded, group: expanded == .top ? 0 : model.activeSideGroup)
        let moduleID = selectedModule(for: active)?.id
        let isAgent = moduleID == "agents"
        guard let stroke = KeyStroke(event) else { return event }
        if WidgetKeymap.shared.commands(for: stroke, in: [.window]).contains(where: { $0.id == WidgetKeymap.paste }) {
            if isAgent { return model.pasteMedia() ? nil : event }
            if ["capture", "shelf"].contains(moduleID ?? ""), !(panel.firstResponder is NSTextView) {
                shelf?.paste(asImages: moduleID == "capture")
                return nil
            }
        }
        let editingText = panel.firstResponder is NSTextView
            || (panel.firstResponder as? NSControl)?.currentEditor() != nil
        if MediaPreviewKeyboard.handle(stroke, editingText: editingText) {
            return nil
        }
        switch Self.panelKey(
            stroke: stroke,
            context: .init(previewOpen: MediaPreviewKeyboard.isOpen, agents: isAgent, editingText: editingText,
                           answering: model.answerCard))
        {
        case .pass: return event
        case .collapse:
            // The leave question first (Esc keeps the staged decisions), then the staged view, then the list.
            if model.stagedLeavePrompt {
                model.resolveStagedLeave("keep")
            } else if model.stagedView != nil {
                model.stagedView = nil
            } else if !model.escapeToList() {
                model.requestCollapse()
            }
        case .previous: model.next(-1)
        case .next: model.next()
        case .choose(let choice): model.choose(option: choice)
        }
        return nil
    }

    enum PanelKey: Equatable { case pass, collapse, previous, next, choose(String) }

    struct PanelKeyContext {
        let previewOpen: Bool
        let agents: Bool
        let editingText: Bool
        /// `WidgetModel.answerCard`: an open, unanswered decision, never a folded one.
        let answering: WidgetCard?
    }

    /// What a key the media preview did not take does on the panel. While the preview is open, nothing:
    /// it is modal, so the key goes on to its own controls (a video's) and never to the inbox under it, where a
    /// number would answer the decision behind the picture and j/k would change the session.
    static func panelKey(keyCode: UInt16, characters: String, context: PanelKeyContext) -> PanelKey {
        panelKey(keyCode: keyCode, characters: characters, context: context, keymap: WidgetKeymap.shared)
    }

    static func panelKey(keyCode: UInt16, characters: String, context: PanelKeyContext, keymap: Keymap) -> PanelKey {
        let stroke = WidgetKeymap.plainStroke(keyCode: keyCode, characters: characters)
        return panelKey(stroke: stroke, context: context, keymap: keymap)
    }

    static func panelKey(stroke: KeyStroke, context: PanelKeyContext) -> PanelKey {
        panelKey(stroke: stroke, context: context, keymap: WidgetKeymap.shared)
    }

    /// What `stroke` does. The real modifiers are tried first, so a saved ⌘J runs. Shift alone still reaches
    /// the unshifted panel key. An open preview and a text field keep their gates.
    static func panelKey(stroke: KeyStroke, context: PanelKeyContext, keymap: Keymap) -> PanelKey {
        guard !context.previewOpen else { return .pass }
        let ids = WidgetKeymap.commandIDs(for: stroke, in: [.window], keymap: keymap)
        if ids.contains(WidgetKeymap.collapse) { return .collapse }
        guard context.agents, !context.editingText else { return .pass }
        if ids.contains(WidgetKeymap.previous) { return .previous }
        if ids.contains(WidgetKeymap.next) { return .next }
        if let number = WidgetKeymap.choiceNumber(in: ids),
           let card = context.answering, number <= card.choices.count
        {
            return .choose(card.choices[number - 1].id)
        }
        return .pass
    }

    public static func id(_ screen: NSScreen) -> String {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.stringValue
            ?? screen.localizedName
    }
}
