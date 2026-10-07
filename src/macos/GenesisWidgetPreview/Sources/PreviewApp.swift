import AppKit
import GenesisKit
import SwiftUI

private enum PreviewLayout: String, CaseIterable, Identifiable {
    case top = "Top"
    case side = "Side"
    case both = "Both"
    var id: String { rawValue }
    func includes(_ edge: EdgePanelPlacement) -> Bool {
        self == .both || (self == .top && edge == .top) || (self == .side && edge == .right)
    }
}

@MainActor
private final class PreviewStore: ObservableObject {
    @Published var items = PreviewStore.examples
    @Published var selectedID = "pricing"
    @Published var expanded: EdgePanelPlacement?
    @Published var layout =
        PreviewLayout(rawValue: UserDefaults.standard.string(forKey: "preview.layout") ?? "") ?? .both
    @Published var reduceMotion = false
    @Published var reduceTransparency = false
    @Published var drafts: [String: String] =
        UserDefaults.standard.dictionary(forKey: "preview.drafts") as? [String: String] ?? [:]
    @Published var receipts: [String: String] = [:]
    @Published var choices: [String: String] = [:]
    @Published var saving: Set<String> = []
    var presentationChanged: (() -> Void)?
    var showSettings: (() -> Void)?
    private var revision = 0
    private(set) var openedAt: TimeInterval = 0

    var effectiveReduceMotion: Bool { reduceMotion || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    var effectiveReduceTransparency: Bool {
        reduceTransparency || NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }
    var current: AgentWidgetItem? { items.first { $0.id == selectedID } }

    func setLayout(_ value: PreviewLayout) {
        layout = value
        UserDefaults.standard.set(value.rawValue, forKey: "preview.layout")
        if let expanded, !value.includes(expanded) {
            self.expanded = nil
        }
        presentationChanged?()
    }

    func open(_ edge: EdgePanelPlacement) {
        openedAt = ProcessInfo.processInfo.systemUptime
        expanded = edge
        presentationChanged?()
    }

    func collapse() {
        expanded = nil
        presentationChanged?()
    }

    func select(_ id: String, edge: EdgePanelPlacement) {
        selectedID = id
        open(edge)
    }

    func next(_ direction: Int = 1) {
        guard let index = items.firstIndex(where: { $0.id == selectedID }) else { return }
        selectedID = items[(index + direction + items.count) % items.count].id
    }

    func answer(choice: String? = nil) {
        let id = selectedID
        guard !saving.contains(id) else { return }
        let text: String
        if let choice, let option = current?.choices.first(where: { $0.id == choice }) {
            text = option.title
            choices[id] = choice
        } else {
            text = (drafts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            drafts[id] = ""
        }
        saving.insert(id)
        receipts[id] = "Saving preview answer…"
        let token = revision
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(550))
            guard let self, self.revision == token else { return }
            self.saving.remove(id)
            self.receipts[id] = "Preview answer saved · " + text
            if let index = self.items.firstIndex(where: { $0.id == id }) {
                self.items[index].status = .working
            }
        }
    }

    func reset() {
        revision += 1
        items = Self.examples
        receipts = [:]
        choices = [:]
        saving = []
        drafts = [:]
        selectedID = "pricing"
        presentationChanged?()
    }

    static var examples: [AgentWidgetItem] {
        [
            AgentWidgetItem(
                id: "pricing", provider: "Claude", project: "Website", title: "Pricing page",
                request: "Add a pricing page to the site.",
                context: "The layout is ready. One decision before I finish the page.",
                question: "Which layout should the pricing section use?", status: .waiting,
                choices: [
                    .init(id: "tiers", title: "Three tiers with an annual toggle", recommended: true),
                    .init(id: "single", title: "One plan, one clear price"),
                    .init(id: "compare", title: "A detailed comparison table"),
                ]),
            AgentWidgetItem(
                id: "layout", provider: "Codex", project: "Native app", title: "Widget hot zone",
                request: "Make the widget easier to reach.",
                context: "The interaction area is too close to the Dock. I can move it or make it narrower.",
                question: "How should the edge handle change?", status: .waiting,
                choices: [
                    .init(id: "move", title: "Move it above the Dock", recommended: true),
                    .init(id: "narrow", title: "Use a narrower handle"),
                ]),
            AgentWidgetItem(
                id: "tests", provider: "Grok", project: "Native app", title: "Screenshot comparison",
                request: "Check the updated screenshot viewer.",
                context: "The sample comparison is ready. Image dimensions and labels are preserved.",
                question: "What would you like to inspect next?", status: .finished,
                choices: [
                    .init(id: "screens", title: "Show the before and after images"),
                    .init(id: "details", title: "Explain the changes"),
                ]),
        ]
    }
}

private struct PreviewWidgetRoot: View {
    @ObservedObject var store: PreviewStore
    let edge: EdgePanelPlacement
    let cutout: CGFloat
    let compactHeight: CGFloat
    var body: some View {
        AgentWidgetView(
            placement: edge, items: store.items, selectedID: store.selectedID,
            expanded: store.expanded == edge, isPreview: true, animationsActive: store.layout.includes(edge),
            cutoutWidth: cutout, compactHeight: compactHeight,
            receipt: store.receipts[store.selectedID], sending: store.saving.contains(store.selectedID),
            selectedChoice: store.choices[store.selectedID],
            draft: Binding(
                get: { store.drafts[store.selectedID] ?? "" },
                set: { store.drafts[store.selectedID] = $0 }),
            actions: AgentWidgetActions(
                expand: { store.open(edge) }, collapse: { store.collapse() },
                select: { store.select($0, edge: edge) },
                choose: { store.answer(choice: $0) }, submit: { store.answer() },
                settings: { store.showSettings?() }, next: { store.next() })
        )
        .widgetAccessibility(reduceMotion: store.reduceMotion, reduceTransparency: store.reduceTransparency)
    }
}

private struct PreviewStudio: View {
    @ObservedObject var store: PreviewStore
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 10) {
                GenesisWidgetMark()
                VStack(alignment: .leading, spacing: 3) {
                    Text("GenesisTools Preview").font(.system(size: 20, weight: .semibold))
                    Text("Agent widgets · native interaction study").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
            }
            Picker("Placement", selection: Binding(get: { store.layout }, set: { store.setLayout($0) })) {
                ForEach(PreviewLayout.allCases) { value in Text(value.rawValue).tag(value) }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Widget placement")
            HStack(spacing: 10) {
                Button("Open top card") { store.open(.top) }.disabled(!store.layout.includes(.top))
                Button("Open side card") { store.open(.right) }.disabled(!store.layout.includes(.right))
                Spacer()
                Button("Collapse") { store.collapse() }
            }
            .buttonStyle(.bordered)
            VStack(alignment: .leading, spacing: 10) {
                Toggle("Reduce motion", isOn: $store.reduceMotion)
                Toggle("Opaque surfaces", isOn: $store.reduceTransparency)
            }
            .toggleStyle(.switch)
            .onChange(of: store.reduceMotion) { _, _ in store.presentationChanged?() }
            HStack(alignment: .top) {
                Text(
                    "Sample conversations only.\nAnswers stay in this preview; your agents and main app are untouched."
                )
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Reset samples") { store.reset() }.buttonStyle(.bordered)
            }
        }
        .padding(26).frame(width: 510)
        .preferredColorScheme(.dark)
    }
}

@MainActor
private final class PreviewDelegate: NSObject, NSApplicationDelegate {
    private let store = PreviewStore()
    private var panels: [EdgePanelPlacement: EdgePanelController<PreviewWidgetRoot>] = [:]
    private var studio: NSWindow?
    private var localMouse: Any?
    private var globalMouse: Any?
    private var keyboard: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let cutout: CGFloat
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea,
            let right = screen.auxiliaryTopRightArea
        {
            cutout = screen.frame.width - left.width - right.width
        } else {
            cutout = 0
        }
        let topHeight = max(36, screen.safeAreaInsets.top + 6)
        panels[.top] = EdgePanelController(
            placement: .top, screen: screen,
            compactSize: CGSize(width: max(260, cutout + 160), height: topHeight),
            expandedSize: CGSize(width: 438, height: 456 + topHeight),
            title: "Agents · top"
        ) {
            PreviewWidgetRoot(store: store, edge: .top, cutout: cutout, compactHeight: topHeight)
        }
        panels[.right] = EdgePanelController(
            placement: .right, screen: screen,
            compactSize: CGSize(width: 38, height: 200),
            expandedSize: CGSize(width: 440, height: 456),
            title: "Agents · side"
        ) {
            PreviewWidgetRoot(store: store, edge: .right, cutout: 0, compactHeight: 36)
        }
        store.presentationChanged = { [weak self] in self?.syncPanels() }
        store.showSettings = { [weak self] in self?.showStudio() }
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
        syncPanels()
        showStudio()
    }

    private func syncPanels() {
        for (edge, controller) in panels {
            if store.layout.includes(edge) {
                controller.show()
                controller.setExpanded(store.expanded == edge, reduceMotion: store.effectiveReduceMotion)
            } else {
                controller.hide()
            }
        }
    }

    private func collapseIfOutside(_ event: NSEvent) {
        guard event.timestamp > store.openedAt, store.expanded != nil else { return }
        if let window = event.window, panels.values.contains(where: { $0.panel === window }) {
            return
        }
        let point = event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
        guard !panels.values.contains(where: { $0.panel.isVisible && $0.panel.frame.contains(point) }) else { return }
        store.collapse()
    }

    private func handleKey(_ event: NSEvent) -> NSEvent? {
        guard let expanded = store.expanded, let panel = panels[expanded]?.panel,
            event.window === panel, panel.isKeyWindow
        else { return event }
        guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty else { return event }
        if event.keyCode == 53 {
            store.collapse()
            return nil
        }
        if panel.firstResponder is NSTextView {
            return event
        }
        if let control = panel.firstResponder as? NSControl, control.currentEditor() != nil {
            return event
        }
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if key == "j" {
            store.next(-1)
            return nil
        }
        if key == "k" {
            store.next()
            return nil
        }
        if let number = AgentWidgetKeyboard.choiceNumber(keyCode: event.keyCode, characters: key),
            let choices = store.current?.choices, number <= choices.count
        {
            store.answer(choice: choices[number - 1].id)
            return nil
        }
        return event
    }

    private func showStudio() {
        store.collapse()
        if studio == nil {
            let view = NSHostingView(rootView: PreviewStudio(store: store))
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 510, height: 350),
                styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "GenesisTools Preview"
            window.isReleasedWhenClosed = false
            window.contentView = view
            window.appearance = NSAppearance(named: .darkAqua)
            window.center()
            studio = window
        }
        studio?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Quit GenesisTools Preview", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = menu
    }

    func applicationWillTerminate(_ notification: Notification) {
        UserDefaults.standard.set(store.drafts, forKey: "preview.drafts")
        for monitor in [localMouse, globalMouse, keyboard].compactMap({ $0 }) { NSEvent.removeMonitor(monitor) }
        for panel in panels.values { panel.hide() }
    }
}

@main
private struct GenesisWidgetPreviewMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = PreviewDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
