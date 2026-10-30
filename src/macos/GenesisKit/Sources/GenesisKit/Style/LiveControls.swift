import SwiftUI

/// A text-like button of a dense row or card (`genHoverPlain`, a tooltip) while its row is live; the bare label
/// otherwise, drawn the same (the style adds no padding or background at rest, and dims a disabled label to 0.4).
/// Every control is a responder, and with an accessibility client SwiftUI walks all of them once per accessibility
/// node an update touches. Liveness comes from the row (`liveRow`, the `rowLive` environment); `live:` overrides it
/// for a control whose state differs from its row's. `pressable` keeps the bare label a button to VoiceOver
/// (`restingButton`).
public struct LiveButton<Label: View>: View {
    var live: Bool?
    let tooltip: String?
    var enabled: Bool
    var pressable: Bool
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    @Environment(\.rowLive) private var rowLive

    public init(live: Bool? = nil, tooltip: String?, enabled: Bool = true, pressable: Bool = false,
                action: @escaping () -> Void, @ViewBuilder label: @escaping () -> Label) {
        self.live = live
        self.tooltip = tooltip
        self.enabled = enabled
        self.pressable = pressable
        self.action = action
        self.label = label
    }

    public var body: some View {
        if live ?? rowLive {
            Button(action: action, label: label)
                .buttonStyle(.genHoverPlain())
                .disabled(!enabled)
                .instantTooltip(tooltip)
        } else if pressable {
            label()
                .opacity(enabled ? 1 : 0.4)
                .restingButton(enabled: enabled, action: action)
        } else {
            label()
        }
    }
}

private extension View {
    @ViewBuilder
    func instantTooltip(_ text: String?) -> some View {
        if let text {
            instantTooltip(text)
        } else {
            self
        }
    }
}
