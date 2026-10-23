import QuartzCore
import SwiftUI

/// A scroll area that is as tall as its content, up to `maxHeight`, and fades at a cut edge when it is taller.
/// The hub's overlays (palette, prompts, find) gave their lists a fixed or greedy height: three prompts sat over
/// 250 pt of empty panel, and the palette's height preference never left its scroll view, so it showed one row (H17).
///
/// When a `GenDisclosure` inside opens or closes, the area grows or shrinks with it on the same `GenMotion` curve.
/// Any other change of its content (a typed query, new results) resizes it at once: those come many times a minute
/// and an animation there only delays what the user is waiting for.
public struct FittedScroll<Content: View>: View {
    public var maxHeight: CGFloat
    public var minHeight: CGFloat
    /// The height until the content is first measured, and every measurement goes to `measured`. A view that is
    /// built again each time it shows (the widget's hover list) passes its last height here: from 0, the first layout
    /// pass reported a list-less height, its window shrank and grew back within 40 ms, and the panel blinked
    /// (edge.request log, 2026-10-23: 336, then 295, then 489 pt for one hover).
    public var initialHeight: CGFloat
    private let measured: ((CGFloat) -> Void)?
    private let content: () -> Content
    @State private var height: CGFloat = 0
    @State private var expansion = FittedExpansionNote()
    @GenReduceMotion private var reduceMotion

    public init(maxHeight: CGFloat, minHeight: CGFloat = 0, initialHeight: CGFloat = 0,
                measured: ((CGFloat) -> Void)? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.maxHeight = maxHeight
        self.minHeight = minHeight
        self.initialHeight = initialHeight
        self.measured = measured
        self.content = content
    }

    public var body: some View {
        ScrollView {
            content()
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height.rounded() }) { apply($0) }
                .scrollOverflowContent()
        }
        .scrollOverflowHints()
        .frame(height: min(maxHeight, max(minHeight, height > 0 ? height : initialHeight)))
        .onGenExpansion { expansion.note($0) }
    }

    private func apply(_ value: CGFloat) {
        measured?(value)
        guard height > 0, let expanding = expansion.recent() else {
            height = value
            return
        }
        GenMotion.perform(expanding: expanding, reduceMotion: reduceMotion) { height = value }
    }
}

/// The last expansion a disclosure announced, valid for the layout passes that follow it.
final class FittedExpansionNote {
    /// Long enough for the layout after the click and for content that arrives in a second step, short enough that a
    /// later keystroke is never mistaken for the disclosure.
    static let window: CFTimeInterval = 0.5
    private var expanding: Bool?
    private var at: CFTimeInterval = 0

    func note(_ expanding: Bool, now: CFTimeInterval = CACurrentMediaTime()) {
        self.expanding = expanding
        at = now
    }

    func recent(now: CFTimeInterval = CACurrentMediaTime()) -> Bool? {
        guard let expanding, now - at < Self.window else { return nil }
        return expanding
    }
}
