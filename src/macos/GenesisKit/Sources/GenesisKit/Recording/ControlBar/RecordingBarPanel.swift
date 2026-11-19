import AppKit
import Combine
import SwiftUI

/// The shortcuts belong to this panel. The recording target keeps its own keyboard while the bar is in the background.
private final class RecordingBarWindow: NSPanel {
    var shortcut: ((NSEvent) -> Bool)?
    var escape: (() -> Void)?
    var endDrag: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        shortcut?(event) == true || super.performKeyEquivalent(with: event)
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, shortcut?(event) == true { return }
        super.sendEvent(event)
        if event.type == .leftMouseUp { endDrag?() }
    }

    override func cancelOperation(_ sender: Any?) { escape?() }
}

/// One window for setup, countdown, the live take and its result. Create it before starting capture and include
/// its windowID along with the picker's and overlay panels' IDs in the engine's exclusions.
@MainActor
public final class RecordingBarPanel {
    public let window: NSPanel
    public var windowID: Int { window.windowNumber }

    private let model: RecordingBarModel
    private let defaults: UserDefaults
    private let targetBounds: (RecordingTarget) -> CGRect?
    private var placement: RecordingPanelPlacement
    private var cancellables = Set<AnyCancellable>()
    private var dragged = false
    private var dragging = false
    private let hideAction: () -> Void
    private let cancelDraft: () -> Void
    let motion = RecordingBarMotion()
    /// The content's last measured size, applied when a closing drawer ends.
    private var measured: CGSize = .zero

    /// targetBounds supplies the picker's known target bounds, in global Cocoa screen points.
    public init(model: RecordingBarModel, actions: RecordingBarActions, defaults: UserDefaults = .standard,
                targetBounds: @escaping (RecordingTarget) -> CGRect? = { _ in nil }) {
        self.model = model
        self.defaults = defaults
        self.targetBounds = targetBounds
        self.hideAction = actions.hide
        self.cancelDraft = { actions.closeSetupIfNeeded(model) }
        placement = defaults.string(forKey: "recorder.bar.placement").flatMap(RecordingPanelPlacement.init(rawValue:))
            ?? defaults.string(forKey: RecordingSettings.Key.placement).flatMap(RecordingPanelPlacement.init(rawValue:))
            ?? .nearTarget
        let panel = RecordingBarWindow(contentRect: CGRect(x: 0, y: 0, width: RecordingBarView.width, height: 44),
                                       styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window = panel
        RecordingPanelChrome.apply(to: panel)
        panel.title = "Recording controls"
        panel.identifier = NSUserInterfaceItemIdentifier("recording.bar")
        panel.isMovableByWindowBackground = false
        if !model.excludeWindowIDs.contains(panel.windowNumber) {
            model.excludeWindowIDs.append(panel.windowNumber)
        }
        var hostedActions = actions
        hostedActions.hide = { [weak self] in self?.hide() }
        let view = RecordingBarView(model: model, actions: hostedActions, defaults: defaults, placement: placement,
                                    motion: motion, onPlace: { [weak self] in self?.setPlacement($0) },
                                    onDrag: { [weak self] in self?.dragging = true })
        let content = view.fixedSize().onGeometryChange(for: CGSize.self, of: { $0.size }) {
            [weak self] size in DispatchQueue.main.async { self?.resize(to: size) }
        }
        let hosting = FirstMouseHostingView(rootView: AnyView(RecordingBarRoot(motion: motion, content: content)))
        panel.contentView = hosting
        let size = RecordingPickerPanel.measure(hosting)
        resize(to: size)
        motion.decideGrowth = { [weak self] in self?.growthFromHere() ?? .down }
        motion.reserve = { [weak self] height in self?.reserve(height: height) }
        motion.settle = { [weak self] in
            guard let self else { return }
            self.resize(to: self.measured)
            self.window.invalidateShadow()
        }
        panel.shortcut = { [weak self] event in self?.handle(event) == true }
        panel.escape = { [weak self] in self?.escape() }
        panel.endDrag = { [weak self] in self?.saveDrag() }

        model.$setup.map(\.target).removeDuplicates().dropFirst().sink { [weak self] target in
            guard let self, self.window.isVisible, !self.dragged else { return }
            self.place(target: target)
        }.store(in: &cancellables)
        model.$phase.map { phase in
            if case .countdown = phase { return true }
            return false
        }.removeDuplicates().filter { $0 }.sink { [weak self] _ in
            guard let self, self.window.isVisible else { return }
            self.place(target: self.model.setup.target)
        }.store(in: &cancellables)
        model.$notice.compactMap { $0 }.filter { $0.actions.contains(.showControls) }.sink { [weak self] _ in
            self?.show()
        }.store(in: &cancellables)
    }

    public func show(focus: Bool = false) {
        if !window.isVisible { place(target: model.setup.target) }
        if focus { window.makeKeyAndOrderFront(nil) } else { window.orderFrontRegardless() }
    }

    public func hide() {
        window.orderOut(nil)
        hideAction()
    }

    private func escape() {
        if model.expanded {
            model.expanded = false
        } else {
            cancelDraft()
            hide()
        }
    }

    private func handle(_ event: NSEvent) -> Bool {
        guard event.type == .keyDown else { return false }
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        switch (event.charactersIgnoringModifiers, modifiers) {
        case ("\u{1b}", []):
            if !event.isARepeat { escape() }
        case (" ", []):
            switch model.phase {
            case .recording: if !event.isARepeat { model.pause() }
            case .paused(_, true): if !event.isARepeat { model.resume() }
            default: return false
            }
        case (".", .command):
            switch model.phase {
            case .recording, .paused: if !event.isARepeat { model.stop() }
            default: return false
            }
        default: return false
        }
        return true
    }

    /// Follows the content's size. The drawer's motion happens inside the window: it grows the window once when it
    /// starts opening (`reserve`) and shrinks it once when it has closed (`settle`), so no frame of the window is
    /// animated and nothing in the first row moves. A content change outside that motion (a notice, a phase) is
    /// applied at once.
    private func resize(to measured: CGSize) {
        self.measured = measured
        let size = CGSize(width: ceil(measured.width), height: ceil(measured.height))
        guard size.width > 0, size.height > 0, size != window.frame.size else { return }
        if motion.moving && size.height < window.frame.height { return }
        window.setFrame(anchored(size), display: true)
    }

    private func reserve(height: CGFloat) {
        let size = CGSize(width: window.frame.width, height: ceil(height))
        guard size.height > window.frame.height else { return }
        window.setFrame(anchored(size), display: true)
    }

    /// The new frame keeps the edge the drawer opens away from: the top while it opens downward, the bottom while it
    /// opens upward. It stays inside the visible screen.
    private func anchored(_ size: CGSize) -> CGRect {
        let frame = window.frame
        let visible = window.screen?.visibleFrame ?? CGRect(origin: frame.origin, size: size)
        var next = CGRect(x: frame.minX, y: motion.growth == .up ? frame.minY : frame.maxY - size.height,
                          width: size.width, height: size.height)
        next.origin.x = min(max(next.minX, visible.minX + 8), visible.maxX - 8 - next.width)
        next.origin.y = min(max(next.minY, visible.minY + 8), visible.maxY - 8 - next.height)
        return next.integral
    }

    /// Opens toward the larger part of the screen: upward from a bar in the lower half (the default place, under the
    /// recorded window or at the bottom of the display), downward from one in the upper half.
    private func growthFromHere() -> RecordingBarGrowth {
        guard let visible = window.screen?.visibleFrame else { return .down }
        return window.frame.midY < visible.midY ? .up : .down
    }

    private func setPlacement(_ newValue: RecordingPanelPlacement) {
        placement = newValue
        defaults.set(newValue.rawValue, forKey: "recorder.bar.placement")
        if let screen = destination(for: model.setup.target).screen {
            defaults.removeObject(forKey: positionKey(screen))
        }
        dragged = false
        place(target: model.setup.target)
    }

    private func saveDrag() {
        guard dragging, let screen = window.screen else { return }
        dragging = false
        dragged = true
        // The top left stays put across different content heights. Store it relative to this display's visible frame.
        let point = CGPoint(x: window.frame.minX - screen.visibleFrame.minX, y: screen.visibleFrame.maxY - window.frame.maxY)
        defaults.set(NSStringFromPoint(point), forKey: positionKey(screen))
    }

    private func positionKey(_ screen: NSScreen) -> String {
        let display = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        return "recorder.bar.position.\(display?.stringValue ?? screen.localizedName)"
    }

    /// Prefer the screen holding the greatest area, even when the window's centre falls in a display gap.
    static func screenIndex(bounds: CGRect?, screens: [CGRect], pointer: CGPoint) -> Int? {
        var greatest: CGFloat = 0
        var chosen: Int?
        if let bounds {
            for (index, screen) in screens.enumerated() {
                let part = screen.intersection(bounds)
                guard !part.isNull else { continue }
                let area = part.width * part.height
                if area > greatest { greatest = area; chosen = index }
            }
        }
        return chosen ?? screens.firstIndex { $0.contains(pointer) } ?? screens.indices.first
    }

    private func destination(for target: RecordingTarget?) -> (screen: NSScreen?, bounds: CGRect?) {
        let screens = NSScreen.screens
        var bounds = target.flatMap(targetBounds)
        switch target {
        case let .display(index, _) where screens.indices.contains(index): return (screens[index], nil)
        case let .area(rect, display) where screens.indices.contains(display): return (screens[display], bounds ?? rect)
        case let .displays(indices) where bounds == nil:
            if let index = indices.first, screens.indices.contains(index) { return (screens[index], nil) }
        case let .window(ids, _, _, _) where bounds == nil:
            if let id = ids.first, let primary = screens.first,
               let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
               let fields = windows.first?[kCGWindowBounds as String] as? NSDictionary,
               let cg = CGRect(dictionaryRepresentation: fields as CFDictionary) {
                bounds = RecordingPanelLayout.cocoa(cg, primaryHeight: primary.frame.height)
            }
        default: break
        }
        let index = Self.screenIndex(bounds: bounds, screens: screens.map(\.frame), pointer: NSEvent.mouseLocation)
        return (index.map { screens[$0] }, bounds)
    }

    private func place(target: RecordingTarget?) {
        let (destination, bounds) = self.destination(for: target)
        guard let screen = destination else { return }
        let size = window.frame.size
        let visible = screen.visibleFrame
        let frame: CGRect
        if let stored = defaults.string(forKey: positionKey(screen)) {
            let offset = NSPointFromString(stored)
            let saved = CGRect(x: visible.minX + offset.x, y: visible.maxY - offset.y - size.height,
                               width: size.width, height: size.height)
            frame = RecordingPanelLayout.resized(saved, to: size, visible: visible)
        } else {
            let local = RecordingPanelLayout.Screen(frame: screen.frame, visible: visible)
            // The layout's single-screen transform is its own inverse.
            let targetCG = bounds.flatMap { rect -> CGRect? in
                let part = rect.intersection(screen.frame)
                return part.isNull ? nil : RecordingPanelLayout.cocoa(part, primaryHeight: screen.frame.height)
            }
            frame = RecordingPanelLayout.frame(size: size, placement: placement, targetCG: targetCG,
                                               displayIndex: nil, screens: [local])
        }
        window.setFrame(frame, display: true)
    }
}

/// Keeps the bar against the edge its drawer opens away from, so a taller window never moves the first row.
private struct RecordingBarRoot<Content: View>: View {
    @ObservedObject var motion: RecordingBarMotion
    let content: Content

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: motion.growth == .up ? .bottom : .top)
    }
}
