import SwiftUI

/// What a button is among its neighbours. One bar holds at most one `primary`.
public enum KitButtonKind: Sendable {
    /// The one main action: filled in its hue.
    case primary
    /// A secondary action that belongs to a meaning: a tint of its hue.
    case tinted
    /// A quiet filled action: a skip button, a choice chip.
    case soft
    /// An outlined action beside others of equal weight.
    case ghost
    /// Words only, with a wash under the pointer: "Confirm", "Reject" at the end of a row.
    case plain

    var role: KitSurfaceRole {
        switch self {
        case .primary: .primary
        case .tinted: .tinted
        case .soft: .soft
        case .ghost: .ghost
        case .plain: .plain
        }
    }
}

/// **The** look of a text button in this app: five kinds, three sizes, a hue, drawn by the window's `KitLook`.
/// `.buttonStyle(.kit(.tinted, hue: .ask))` on any `Button`, or `KitButton` for the usual glyph and title.
///
/// Rest, hover and pressed come from the look's table. Pressed also scales to 0.97 (not under Reduce Motion).
/// Disabled fades to 40 % and keeps the arrow pointer.
public struct KitButtonStyle: ButtonStyle {
    var kind: KitButtonKind = .soft
    var hue: KitHue = .neutral
    var size: KitControlSize = .regular
    var fullWidth = false
    /// A square button for one glyph.
    var square = false
    /// The least width: a button whose title changes ("Pause", "Play") keeps its place.
    var minWidth: CGFloat?

    public func makeBody(configuration: Configuration) -> some View {
        KitButtonBody(configuration: configuration, style: self)
    }
}

public extension ButtonStyle where Self == KitButtonStyle {
    /// `.buttonStyle(.kit(.primary, hue: .play))`
    static func kit(_ kind: KitButtonKind = .soft, hue: KitHue = .neutral, size: KitControlSize = .regular,
                    fullWidth: Bool = false) -> KitButtonStyle {
        KitButtonStyle(kind: kind, hue: hue, size: size, fullWidth: fullWidth)
    }
}

private struct KitButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let style: KitButtonStyle
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.kitLook) private var look
    @Environment(\.kitForcedInteraction) private var forced
    @Environment(\.colorScheme) private var scheme
    @GenReduceMotion private var reduceMotion

    private var state: KitInteraction {
        guard isEnabled else { return .rest }
        if configuration.isPressed || forced == .pressed { return .pressed }
        return hovering || forced == .hover ? .hover : .rest
    }

    var body: some View {
        let state = state
        let surface = look.surface(style.kind.role, state, hue: style.hue, scheme: scheme)
        let radius = look.radius(style.kind.role, height: style.size.height, legacy: 7)
        configuration.label
            .font(.system(size: style.size.font, weight: style.kind == .primary ? .semibold : .medium))
            .lineLimit(1)
            .foregroundStyle(surface.label)
            .environment(\.kitGlyphColor, surface.glyph)
            .environment(\.kitGlyphSize, style.size.glyph)
            .padding(.horizontal, style.square ? 0 : style.size.padding)
            .frame(width: style.square ? style.size.height : nil, height: style.size.height)
            .frame(minWidth: style.minWidth, maxWidth: style.fullWidth ? .infinity : nil)
            .background(KitSurfaceBackground(surface, radius: radius, corners: look.corners))
            .brightness(surface.brightness)
            .scaleEffect(reduceMotion ? 1 : (state == .pressed ? 0.97 : 1))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: radius, style: look.corners))
            .pointerCursor(isEnabled)
            .onHover { inside in
                let next = isEnabled && inside
                guard next != hovering else { return }
                withAnimation(reduceMotion ? nil : KitTheme.quick) { hovering = next }
            }
            .onChange(of: isEnabled) { _, enabled in
                if !enabled { hovering = false }
            }
            // A button that scrolls out from under a still pointer gets no exit event.
            .onDisappear { hovering = false }
            .animation(reduceMotion ? nil : KitTheme.quick, value: configuration.isPressed)
    }
}

private struct KitGlyphColorKey: EnvironmentKey {
    static let defaultValue: Color? = nil
}

private struct KitGlyphSizeKey: EnvironmentKey {
    static let defaultValue: CGFloat = 11
}

extension EnvironmentValues {
    /// The colour a kit button gives the glyphs in its label (its hue on a quiet surface, white on a filled one).
    var kitGlyphColor: Color? {
        get { self[KitGlyphColorKey.self] }
        set { self[KitGlyphColorKey.self] = newValue }
    }

    var kitGlyphSize: CGFloat {
        get { self[KitGlyphSizeKey.self] }
        set { self[KitGlyphSizeKey.self] = newValue }
    }
}

/// A glyph in a kit button's label: it takes the colour and the size the button's style sets.
public struct KitButtonGlyph: View {
    let systemName: String
    var scale: CGFloat
    @Environment(\.kitGlyphColor) private var color
    @Environment(\.kitGlyphSize) private var size

    public init(_ systemName: String, scale: CGFloat = 1) {
        self.systemName = systemName
        self.scale = scale
    }

    public var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * scale, weight: .semibold))
            .foregroundStyle(color ?? .primary)
    }
}

/// A button with a title, an optional glyph before it and an optional glyph after it (a chevron, an arrow).
/// The icon-only form takes a tooltip, which is also its name for VoiceOver and UI automation.
public struct KitButton: View {
    private let title: String?
    private let symbol: String?
    private let trailingSymbol: String?
    private let kind: KitButtonKind
    private let hue: KitHue
    private let size: KitControlSize
    private let fullWidth: Bool
    private let minWidth: CGFloat?
    private let tooltip: String?
    private let identifier: String?
    private let action: () -> Void

    public init(_ title: String, symbol: String? = nil, trailingSymbol: String? = nil, kind: KitButtonKind = .soft,
                hue: KitHue = .neutral, size: KitControlSize = .regular, fullWidth: Bool = false, minWidth: CGFloat? = nil,
                tooltip: String? = nil, identifier: String? = nil, action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.trailingSymbol = trailingSymbol
        self.kind = kind
        self.hue = hue
        self.size = size
        self.fullWidth = fullWidth
        self.minWidth = minWidth
        self.tooltip = tooltip
        self.identifier = identifier
        self.action = action
    }

    /// One glyph in a square: a gear, a close mark. `tooltip` says what it does.
    public init(symbol: String, tooltip: String, kind: KitButtonKind = .ghost, hue: KitHue = .neutral,
                size: KitControlSize = .regular, identifier: String? = nil, action: @escaping () -> Void) {
        self.title = nil
        self.symbol = symbol
        self.trailingSymbol = nil
        self.kind = kind
        self.hue = hue
        self.size = size
        self.fullWidth = false
        self.minWidth = nil
        self.tooltip = tooltip
        self.identifier = identifier
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol {
                    KitButtonGlyph(symbol, scale: title == nil ? 1.15 : 1)
                }
                if let title {
                    Text(verbatim: title)
                    if fullWidth { Spacer(minLength: 4) }
                }
                if let trailingSymbol {
                    KitButtonGlyph(trailingSymbol, scale: 0.85)
                }
            }
        }
        .buttonStyle(KitButtonStyle(kind: kind, hue: hue, size: size, fullWidth: fullWidth, square: title == nil, minWidth: minWidth))
        .kitTooltip(tooltip)
        .accessibilityLabel(Text(verbatim: title ?? tooltip ?? ""))
        .accessibilityIdentifier(identifier ?? "")
    }
}

/// A button that stays on or off: "Follows playback", "Tone". On, it is a tint of its hue with its glyph in the hue;
/// off, an outline with the glyph dimmed. The glyph keeps its place in both states, so the chip never changes width.
public struct KitToggleChip: View {
    private let title: String
    private let symbol: String?
    @Binding private var isOn: Bool
    private let hue: KitHue
    private let size: KitControlSize
    private let tooltip: String?
    private let identifier: String?

    /// Without a `symbol` the chip shows a check when on and an empty ring when off.
    public init(_ title: String, symbol: String? = nil, isOn: Binding<Bool>, hue: KitHue = .play,
                size: KitControlSize = .regular, tooltip: String? = nil, identifier: String? = nil) {
        self.title = title
        self.symbol = symbol
        _isOn = isOn
        self.hue = hue
        self.size = size
        self.tooltip = tooltip
        self.identifier = identifier
    }

    public var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: 5) {
                KitButtonGlyph(symbol ?? (isOn ? "checkmark" : "circle"))
                    .opacity(isOn ? 1 : 0.55)
                Text(verbatim: title)
            }
        }
        .buttonStyle(KitButtonStyle(kind: isOn ? .tinted : .ghost, hue: isOn ? hue : .neutral, size: size))
        .kitTooltip(tooltip)
        .accessibilityLabel(Text(verbatim: title))
        .accessibilityValue(Text(verbatim: isOn ? "on" : "off"))
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityIdentifier(identifier ?? "")
    }
}

extension View {
    /// The instant tooltip when there is a text for one.
    @ViewBuilder
    func kitTooltip(_ text: String?) -> some View {
        if let text {
            instantTooltip(text)
        } else {
            self
        }
    }
}
