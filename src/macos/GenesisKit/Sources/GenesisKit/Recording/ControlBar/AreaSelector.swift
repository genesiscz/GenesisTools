import AppKit
import Combine

/// The input panels are reused for both selectors, including when the target changes during a recording.
/// A host keeps this object for the take and includes its windowIDs in the engine's exclusion list before Record.
@MainActor
public final class RecordingPickerOverlays: ObservableObject {
    public let pulse: TargetPulse
    private let panels: [RecordingPickerWindow]
    private var completion: ((RecordingTarget?) -> Void)?
    private weak var parent: NSWindow?
    private var wasKey = false
    private var closesOnFocusLoss: Bool?

    public init(screens: [CGRect] = NSScreen.screens.map(\.frame)) {
        pulse = TargetPulse(screens: screens)
        panels = screens.map { frame in
            let panel = RecordingPickerWindow(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                                              backing: .buffered, defer: false)
            RecordingPanelChrome.apply(to: panel)
            panel.level = .screenSaver
            panel.hasShadow = false
            panel.acceptsMouseMovedEvents = true
            panel.setFrame(frame, display: false)
            return panel
        }
    }

    public var windowIDs: [Int] { panels.map(\.windowNumber) + pulse.windowIDs }

    deinit {
        let windows = panels
        Task { @MainActor in windows.forEach { $0.close() } }
    }

    func present(title: String, parent: NSWindow?, makeView: (Int, CGRect) -> NSView,
                 completion: @escaping (RecordingTarget?) -> Void) {
        guard self.completion == nil else { return }
        guard !panels.isEmpty else { completion(nil); return }
        self.completion = completion
        self.parent = parent
        wasKey = parent?.isKeyWindow == true
        if let picker = parent?.delegate as? RecordingPickerPanel {
            closesOnFocusLoss = picker.closesOnFocusLoss
            picker.closesOnFocusLoss = false
        }
        // Keep the actual hosting view and its draft, filter, focus and checked displays alive.
        parent?.orderOut(nil)
        for (display, panel) in panels.enumerated() {
            let view = makeView(display, CGRect(origin: .zero, size: panel.frame.size))
            panel.title = title
            panel.contentView = view
            panel.makeFirstResponder(view)
            panel.orderFrontRegardless()
        }
        (panels.first { $0.frame.contains(NSEvent.mouseLocation) } ?? panels.first)?.makeKey()
    }

    func finish(_ target: RecordingTarget?) {
        guard let completion else { return }
        self.completion = nil
        closeSelector(restoreParent: true)
        completion(target)
    }

    /// The host closed the entire picker (for example, the take ended during a switch).
    public func dismiss(keepingChoice: Bool = false) {
        completion = nil
        closeSelector(restoreParent: false)
        if keepingChoice { pulse.pickerClosed() } else { pulse.clear() }
    }

    private func closeSelector(restoreParent: Bool) {
        for panel in panels {
            panel.orderOut(nil)
            panel.contentView = nil
        }
        if restoreParent {
            if wasKey { parent?.makeKeyAndOrderFront(nil) } else { parent?.orderFrontRegardless() }
        }
        if let picker = parent?.delegate as? RecordingPickerPanel, let closesOnFocusLoss {
            picker.closesOnFocusLoss = closesOnFocusLoss
        }
        self.closesOnFocusLoss = nil
        parent = nil
    }
}

/// Selects one rectangle in the display's own lower-left-origin coordinate system.
@MainActor
public enum AreaSelector {
    public static func begin(overlays: RecordingPickerOverlays, parent: NSWindow?,
                             completion: @escaping (RecordingTarget?) -> Void) {
        overlays.present(title: "Select an area", parent: parent, makeView: { display, frame in
            let view = RecordingAreaSelectionView(frame: frame)
            view.setAccessibilityLabel("Select an area")
            view.onCancel = { [weak overlays] in overlays?.finish(nil) }
            view.onSelect = { [weak overlays] rect in overlays?.finish(.area(rect: rect, display: display)) }
            return view
        }, completion: completion)
    }
}

class RecordingSelectorView: NSView {
    var onCancel: (() -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func cancelOperation(_ sender: Any?) { onCancel?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onCancel?() } else { super.keyDown(with: event) }
    }

    func drawHint(_ label: String, at center: CGPoint) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.white,
        ]
        let size = (label as NSString).size(withAttributes: attributes)
        let width = size.width + 20, height = size.height + 10
        let box = CGRect(x: max(0, min(center.x - width / 2, bounds.width - width)),
                         y: max(0, min(center.y - height / 2, bounds.height - height)), width: width, height: height)
        NSColor.black.withAlphaComponent(0.8).setFill()
        NSBezierPath(roundedRect: box, xRadius: 7, yRadius: 7).fill()
        (label as NSString).draw(at: CGPoint(x: box.minX + 10, y: box.minY + 5), withAttributes: attributes)
    }
}

final class RecordingAreaSelectionView: RecordingSelectorView {
    static let minimumSide: CGFloat = 16
    var onSelect: ((CGRect) -> Void)?
    private var start: CGPoint?
    private var selection: CGRect?
    private(set) var tooSmall = false

    func begin(at point: CGPoint) {
        tooSmall = false
        start = point
        drag(to: point)
    }

    func drag(to point: CGPoint) {
        guard let start else { return }
        let end = CGPoint(x: min(max(point.x, bounds.minX), bounds.maxX),
                          y: min(max(point.y, bounds.minY), bounds.maxY))
        selection = CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                           width: abs(start.x - end.x), height: abs(start.y - end.y)).integral
        needsDisplay = true
    }

    func confirm() {
        guard start != nil, let selection else { return }
        start = nil
        guard selection.width >= Self.minimumSide, selection.height >= Self.minimumSide else {
            tooSmall = true
            needsDisplay = true
            return
        }
        onSelect?(selection)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        begin(at: convert(event.locationInWindow, from: nil))
    }
    override func mouseDragged(with event: NSEvent) { drag(to: convert(event.locationInWindow, from: nil)) }
    override func mouseUp(with event: NSEvent) {
        drag(to: convert(event.locationInWindow, from: nil))
        confirm()
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 { confirm() } else { super.keyDown(with: event) }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.25).setFill()
        bounds.fill()
        var center = CGPoint(x: bounds.midX, y: bounds.midY)
        var label = "Drag to select an area · Esc to return"
        if let rect = selection {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current?.compositingOperation = .clear
            rect.fill()
            NSGraphicsContext.restoreGraphicsState()
            NSColor.controlAccentColor.setStroke()
            let outline = NSBezierPath(rect: rect)
            outline.lineWidth = 2
            outline.stroke()
            center = CGPoint(x: rect.midX, y: rect.minY - 18)
            label = tooSmall ? "Drag at least 16 × 16 pt" : "\(Int(rect.width)) × \(Int(rect.height)) pt"
        }
        drawHint(label, at: center)
    }
}
