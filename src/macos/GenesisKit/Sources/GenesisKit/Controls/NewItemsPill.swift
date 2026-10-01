import SwiftUI

/// "3 new ↓": the floating pill a live list shows while the reader is scrolled up and items arrived
/// below. The list decides when it shows (it never moves a reader who scrolled up); a click is the
/// reader asking to go down.
public struct NewItemsPill: View {
    public let count: Int
    public var noun: String
    public let action: () -> Void

    public init(count: Int, noun: String = "new", action: @escaping () -> Void) {
        self.count = count
        self.noun = noun
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(verbatim: "\(count) \(noun)")
                    .font(.system(size: 11.5, weight: .semibold))
                    .monospacedDigit()
                Image(systemName: "arrow.down")
                    .font(.system(size: 10, weight: .bold))
            }
            .foregroundStyle(SessionPalette.text)
            .padding(.horizontal, 11)
            .frame(height: 26)
            .background(Capsule().fill(SessionPalette.card))
            .overlay(Capsule().strokeBorder(SessionPalette.cardBorder))
            .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Scroll down to the \(count) new \(count == 1 ? "item" : "items")")
        .accessibilityIdentifier("new-items-pill")
        .transition(.opacity)
    }
}

/// A row that just arrived in a live list: it fades in while it moves up a few points, 0.2 s ease-out.
/// Under Reduce Motion it only fades. `active` is true only for the rows of the latest append, so a
/// row scrolled back into view later does not play it again.
public struct RowArrival: ViewModifier {
    public let active: Bool
    @State private var shown: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(active: Bool) {
        self.active = active
        _shown = State(initialValue: !active)
    }

    public func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .onAppear {
                guard !shown else { return }
                withAnimation(.easeOut(duration: 0.2)) { shown = true }
            }
    }
}
