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

    public final class Viewport: NSScrollView {
        let host: NSHostingView<AnyView>
        var contentWidth: CGFloat

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
            updateDocumentSize()
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
        }
    }
}
