import AppKit
import SwiftUI

/// Ordinary SwiftUI windows keep their existing layout. Only a window with sibling native panes needs elevation.
struct NoticeStackSurface: View {
    let model: NoticeStackModel
    let edge: VerticalEdge
    @State private var usesNativeLayer = false

    var body: some View {
        Group {
            if usesNativeLayer {
                NoticeStackLayer(model: model, edge: edge)
            } else {
                NoticeStackView(model, pinnedTo: edge)
            }
        }
        .background(NoticeLayerHostReader { found in
            if usesNativeLayer != found { usesNativeLayer = found }
        })
    }
}

private struct NoticeLayerHostReader: NSViewRepresentable {
    let changed: (Bool) -> Void
    func makeNSView(context: Context) -> NoticeLayerProbe { NoticeLayerProbe() }
    func updateNSView(_ view: NoticeLayerProbe, context: Context) {
        view.changed = changed
        view.checkHost()
    }
}

private final class NoticeLayerProbe: NSView {
    var changed: ((Bool) -> Void)?
    private var pending = false
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); checkHost() }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); checkHost() }

    func checkHost() {
        guard !pending else { return }
        pending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            pending = false
            let found = sequence(first: superview, next: { $0?.superview }).contains { $0 is GenOverlayContentView }
            changed?(found)
        }
    }
}


/// Keeps a floating notice above native tables and web views that live beside the window's SwiftUI root.
/// The same slot embeds normally in a window without a separate native overlay layer.
struct NoticeStackLayer: NSViewRepresentable {
    let model: NoticeStackModel
    let edge: VerticalEdge
    @Environment(\.self) private var environment

    func makeNSView(context: Context) -> GenOverlaySlot {
        let host = NoticeLayerHostingView(rootView: NoticeLayerContent(model: model, edge: edge, width: 520, environment: environment))
        host.sizingOptions = [.intrinsicContentSize]
        host.frame = NSRect(x: 0, y: 0, width: 520, height: 360)
        let slot = GenOverlaySlot(overlay: host, elevation: .floating)
        host.autoresizingMask = [.width, .height]
        slot.addSubview(host)
        host.slot = slot
        host.install(host.rootView)
        slot.intrinsicSize = { [weak host] in
            guard let host else { return .zero }
            return NSSize(width: host.rootView.width, height: host.measuredHeight)
        }
        return slot
    }

    func updateNSView(_ slot: GenOverlaySlot, context: Context) {
        guard let host = slot.overlay as? NoticeLayerHostingView else { return }
        host.install(NoticeLayerContent(model: model, edge: edge, width: host.rootView.width, environment: environment))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView slot: GenOverlaySlot, context: Context) -> CGSize? {
        guard let host = slot.overlay as? NoticeLayerHostingView else { return nil }
        let width = max(0, min(520, proposal.width ?? 520))
        if host.rootView.width != width {
            host.install(NoticeLayerContent(model: model, edge: edge, width: width, environment: environment))
        }
        return CGSize(width: width, height: model.notices.isEmpty ? 0 : host.measuredHeight)
    }

    static func dismantleNSView(_ slot: GenOverlaySlot, coordinator: ()) {
        slot.leave()
    }
}

private struct NoticeLayerContent: View {
    let model: NoticeStackModel
    let edge: VerticalEdge
    let width: CGFloat
    let environment: EnvironmentValues
    var measured: ((CGFloat) -> Void)?

    private var stack: NoticeStackView {
        var stack = NoticeStackView(model, maxWidth: width, pinnedTo: edge)
        stack.heightChanged = measured
        return stack
    }

    var body: some View {
        stack.frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.self, environment)
            .onChange(of: model.notices.isEmpty) { _, empty in if empty { measured?(0) } }
    }
}

private final class NoticeLayerHostingView: NSHostingView<NoticeLayerContent> {
    weak var slot: GenOverlaySlot?

    private(set) var measuredHeight: CGFloat = 1

    func install(_ value: NoticeLayerContent) {
        var value = value
        value.measured = { [weak self] height in
            guard let self, abs(measuredHeight - height) > 0.5 else { return }
            measuredHeight = height
            DispatchQueue.main.async { [weak self] in
                self?.slot?.invalidateIntrinsicContentSize()
                self?.slot?.contentChanged()
            }
        }
        rootView = value
    }
}
