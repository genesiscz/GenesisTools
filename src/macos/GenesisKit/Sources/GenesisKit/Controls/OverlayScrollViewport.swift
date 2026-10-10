import AppKit
import SwiftUI

/// A narrow vertical viewport whose scrollbar never increases its proposed width.
public struct OverlayScrollViewport<Content: View>: NSViewRepresentable {
    let width: CGFloat
    let content: Content

    public init(width: CGFloat, @ViewBuilder content: () -> Content) {
        self.width = width
        self.content = content()
    }

    public func makeNSView(context: Context) -> Viewport {
        Viewport(content: AnyView(content.frame(width: width)), width: width)
    }

    public func updateNSView(_ view: Viewport, context: Context) {
        view.host.rootView = AnyView(content.frame(width: width))
        view.contentWidth = width
        view.updateDocumentSize()
        view.needsLayout = true
    }

    public func sizeThatFits(_ proposal: ProposedViewSize, nsView: Viewport, context: Context) -> CGSize? {
        CGSize(width: width, height: proposal.height ?? 0)
    }

    /// The overlay scroller hides itself when idle, so a rail that overflows would look like it simply ends.
    /// Each edge with more content past it fades out (a layer mask, no SwiftUI state), and the scroller
    /// flashes once when the content starts to overflow.
    public final class Viewport: NSScrollView {
        let host: NSHostingView<AnyView>
        var contentWidth: CGFloat
        private let fade = CAGradientLayer()
        private(set) var overflow = ScrollOverflow()
        static var fadeHeight: CGFloat { 16 }

        init(content: AnyView, width: CGFloat) {
            host = NSHostingView(rootView: content)
            contentWidth = width
            super.init(frame: .zero)
            drawsBackground = false
            borderType = .noBorder
            hasVerticalScroller = true
            hasHorizontalScroller = false
            scrollerStyle = .overlay
            autohidesScrollers = true
            documentView = host
            wantsLayer = true
            layer?.mask = fade
            updateDocumentSize()
            updateFade()
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        func updateDocumentSize() {
            let size = CGSize(width: contentWidth, height: host.fittingSize.height)
            if host.frame.size != size { host.setFrameSize(size) }
        }

        override public func layout() {
            super.layout()
            updateDocumentSize()
            updateFade()
        }

        override public func reflectScrolledClipView(_ clipView: NSClipView) {
            super.reflectScrolledClipView(clipView)
            updateFade()
        }

        func updateFade() {
            let height = contentView.bounds.height
            let top = host.isFlipped ? contentView.bounds.minY : host.frame.height - contentView.bounds.maxY
            let next = ScrollOverflow(content: CGRect(x: 0, y: -top, width: contentWidth, height: host.frame.height),
                                      viewportHeight: height)
            let began = !overflow.above && !overflow.below && (next.above || next.below)
            overflow = next
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            fade.frame = bounds
            let stop = bounds.height > 0 ? min(0.25, Self.fadeHeight / bounds.height) : 0
            let clear = NSColor.clear.cgColor
            let solid = NSColor.black.cgColor
            // A layer-backed NSScrollView is not flipped: the gradient runs from the bottom edge (0) to the top (1).
            fade.startPoint = CGPoint(x: 0.5, y: isFlipped ? 1 : 0)
            fade.endPoint = CGPoint(x: 0.5, y: isFlipped ? 0 : 1)
            fade.colors = [next.below ? clear : solid, solid, solid, next.above ? clear : solid]
            fade.locations = [0, NSNumber(value: Double(stop)), NSNumber(value: Double(1 - stop)), 1]
            CATransaction.commit()
            if began { flashScrollers() }
        }
    }
}
