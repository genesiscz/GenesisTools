import SwiftUI

/// Where a scroll view's content continues past its edges: `above` / `below` on a vertical one, the leading and
/// trailing edges on a horizontal one.
public struct ScrollOverflow: Equatable, Sendable {
    public var above = false
    public var below = false

    public init(above: Bool = false, below: Bool = false) {
        self.above = above
        self.below = below
    }

    /// `content` is the content frame in the scroll view's own coordinates; half a point of slack absorbs rounding.
    public init(content: CGRect, viewportHeight: CGFloat) {
        above = content.minY < -0.5
        below = viewportHeight > 0 && content.maxY > viewportHeight + 0.5
    }

    /// A horizontal scroll view: `above` is the leading edge, `below` the trailing one.
    public init(content: CGRect, viewportWidth: CGFloat) {
        above = content.minX < -0.5
        below = viewportWidth > 0 && content.maxX > viewportWidth + 0.5
    }
}

private enum ScrollOverflowSpace {
    static let name = "genesiskit.scroll-overflow"
}

private struct ScrollOverflowFrameKey: PreferenceKey {
    static let defaultValue: CGRect? = nil
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
        value = nextValue() ?? value
    }
}

public extension View {
    /// Inside a `ScrollView`, on its content: reports the content frame to `scrollOverflowHints()` on that scroll view.
    func scrollOverflowContent() -> some View {
        background(GeometryReader { proxy in
            Color.clear.preference(key: ScrollOverflowFrameKey.self, value: proxy.frame(in: .named(ScrollOverflowSpace.name)))
        })
    }

    /// On a `ScrollView` whose content carries `scrollOverflowContent()`: a soft fade at each edge that has more
    /// content past it, so a list that overflows never looks like it simply ends. `axis` is the scroll direction (a
    /// strip of chips that hides its scroller is `.horizontal`). The scrollers stay the system's (overlay scrollers
    /// show while scrolling). `changed` reports each new state, for an extra cue.
    func scrollOverflowHints(_ axis: Axis = .vertical, fade: CGFloat = 22, changed: ((ScrollOverflow) -> Void)? = nil) -> some View {
        modifier(ScrollOverflowHints(axis: axis, fade: fade, changed: changed))
    }
}

private struct ScrollOverflowHints: ViewModifier {
    var axis: Axis = .vertical
    let fade: CGFloat
    let changed: ((ScrollOverflow) -> Void)?
    @State private var overflow = ScrollOverflow()
    /// The latest measurements, outside observed state: they change on every scroll step.
    @State private var measured = Measured()

    private final class Measured {
        /// The viewport's length along the scroll axis.
        var viewportLength: CGFloat = 0
        var contentFrame: CGRect?
    }

    func body(content: Content) -> some View {
        content
            .coordinateSpace(.named(ScrollOverflowSpace.name))
            .onPreferenceChange(ScrollOverflowFrameKey.self) { frame in
                measured.contentFrame = frame
                update()
            }
            // The frame stops here: an outer hinted scroll view must not read this one's content as its own.
            .transformPreference(ScrollOverflowFrameKey.self) { $0 = nil }
            .background(GeometryReader { proxy in
                let length = axis == .vertical ? proxy.size.height : proxy.size.width
                Color.clear
                    .onAppear {
                        measured.viewportLength = length
                        update()
                    }
                    .onChange(of: length) { _, next in
                        measured.viewportLength = next
                        update()
                    }
            })
            .mask {
                if axis == .vertical {
                    VStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                            .frame(height: overflow.above ? fade : 0)
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: overflow.below ? fade : 0)
                    }
                } else {
                    HStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                            .frame(width: overflow.above ? fade : 0)
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: overflow.below ? fade : 0)
                    }
                }
            }
    }

    /// Writes state only when an edge flips: the frame changes on every scroll step, the answer rarely does.
    private func update() {
        guard let contentFrame = measured.contentFrame else { return }
        let next = axis == .vertical
            ? ScrollOverflow(content: contentFrame, viewportHeight: measured.viewportLength)
            : ScrollOverflow(content: contentFrame, viewportWidth: measured.viewportLength)
        guard next != overflow else { return }
        overflow = next
        changed?(next)
    }
}
