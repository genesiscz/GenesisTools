import SwiftUI

/// A disclosure whose whole header row toggles: chevron, label and the empty space after it.
///
/// SwiftUI's `DisclosureGroup` on macOS reacts to its chevron only, a 10 pt target beside a label that
/// looks clickable and is not. This header is one `Button` (keyboard, VoiceOver, automation) with a
/// full-width content shape, the row hover, the pointing-hand cursor and a minimum height, and its
/// chevron turns in 0.15 s unless Reduce Motion is on (the app's setting, the widget's or the system's).
public struct GenDisclosure<Label: View, Content: View>: View {
    @Binding private var isExpanded: Bool
    private let minHeight: CGFloat
    private let spacing: CGFloat
    private let identifier: String?
    private let accessibilityTitle: String?
    private let label: Label
    private let content: Content
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.nativeSettingsReduceMotion) private var appReduceMotion
    @Environment(\.widgetReduceMotion) private var widgetReduceMotion

    public init(
        isExpanded: Binding<Bool>,
        minHeight: CGFloat = 26,
        spacing: CGFloat = 6,
        identifier: String? = nil,
        accessibilityTitle: String? = nil,
        @ViewBuilder content: () -> Content,
        @ViewBuilder label: () -> Label
    ) {
        _isExpanded = isExpanded
        self.minHeight = minHeight
        self.spacing = spacing
        self.identifier = identifier
        self.accessibilityTitle = accessibilityTitle
        self.label = label()
        self.content = content()
    }

    private var reduceMotion: Bool { systemReduceMotion || appReduceMotion || widgetReduceMotion }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: isExpanded)
                        .frame(width: 10)
                    label
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 6)
                .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 7))
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint(isExpanded ? "Collapses this section" : "Expands this section")
            .modifier(OptionalAccessibility(title: accessibilityTitle, identifier: identifier))
            if isExpanded {
                content.padding(.top, spacing).padding(.leading, 6)
            }
        }
    }
}

public extension GenDisclosure where Label == Text {
    /// A disclosure with a plain text header.
    init(_ title: String, isExpanded: Binding<Bool>, minHeight: CGFloat = 26, spacing: CGFloat = 6,
         identifier: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(isExpanded: isExpanded, minHeight: minHeight, spacing: spacing, identifier: identifier,
                  accessibilityTitle: title, content: content) { Text(title) }
    }
}

private struct OptionalAccessibility: ViewModifier {
    let title: String?
    let identifier: String?

    func body(content: Content) -> some View {
        let labelled = Group {
            if let title { content.accessibilityLabel(title) } else { content }
        }
        if let identifier { labelled.accessibilityIdentifier(identifier) } else { labelled }
    }
}
