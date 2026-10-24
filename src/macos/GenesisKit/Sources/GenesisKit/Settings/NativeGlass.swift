import AppKit
import SwiftUI

// `nativeSettingsReduceMotion` is in GenesisKitBase (Style/MotionEnvironment.swift), beside GenMotion, which reads it.
private struct NativeReduceTransparencyKey: EnvironmentKey { static let defaultValue = false }
private struct NativeThemeKey: EnvironmentKey { static let defaultValue = NativeSettingsTheme.glass }

extension EnvironmentValues {
    public var nativeSettingsTheme: NativeSettingsTheme {
        get { self[NativeThemeKey.self] }
        set { self[NativeThemeKey.self] = newValue }
    }
    public var nativeSettingsReduceTransparency: Bool {
        get { self[NativeReduceTransparencyKey.self] }
        set { self[NativeReduceTransparencyKey.self] = newValue }
    }
}

public struct NativeGlassShapeSurface<SurfaceShape: Shape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    @Environment(\.nativeSettingsReduceTransparency) private var requestedOpaque
    @Environment(\.nativeSettingsTheme) private var theme
    private let shape: SurfaceShape
    private let opaqueColor: Color
    private let opaque: Bool

    /// `opaqueColor` is the card under Solid and Gradient; the darker themes, Glass included, use their own.
    public init(shape: SurfaceShape, opaqueColor: Color = Color(white: 0.17), opaque: Bool = false) {
        self.shape = shape
        self.opaqueColor = opaqueColor
        self.opaque = opaque
    }

    public func body(content: Content) -> some View {
        let drawn = theme.effective(reduceTransparency: systemOpaque || requestedOpaque, systemReduceTransparency: false)
        switch drawn {
        case .solid, .gradient:
            // Solid and Gradient, as they have always been drawn.
            if drawn == .solid || opaque {
                content.background(opaqueColor, in: shape)
                    .overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
            } else {
                content.foregroundStyle(Color.white).background {
                    ZStack {
                        opaqueColor
                        NativeSettingsGradient.tint
                    }.clipShape(shape)
                }.overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
            }
        case .glass:
            // Dark glass: the card's own glass under a dark tint; a card that must be opaque is Graphite's.
            if opaque {
                content.background(NativeThemePalette.graphiteCard, in: shape)
                    .overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
            } else if #available(macOS 26, *) {
                // SwiftUI does not hit-test Liquid Glass itself, so a gap between two rows on a glass panel was not
                // part of it: hover there read as "the pointer left", and the widget's hover list closed under a
                // scrolling pointer each time a gap passed (Martin, 2026-10-24). The solid form's fill always counted.
                content.foregroundStyle(Color.white).glassEffect(.regular.tint(NativeThemePalette.glassCardTint), in: shape)
                    .contentShape(shape)
            } else {
                content.background {
                    ZStack {
                        Rectangle().fill(.ultraThinMaterial)
                        NativeThemePalette.glassCardTint
                    }.clipShape(shape)
                }.overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
            }
        case .graphite:
            content.background(NativeThemePalette.graphiteCard, in: shape)
                .overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
        case .midnight:
            content.background(NativeThemePalette.midnightCard, in: shape)
                .overlay(shape.stroke(NativeThemePalette.midnightHairline, lineWidth: 1))
        case .dusk:
            content.foregroundStyle(Color.white).background {
                ZStack {
                    NativeThemePalette.duskCard
                    NativeSettingsDusk.tint
                }.clipShape(shape)
            }.overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
        }
    }
}

public struct NativeGlassSurface: ViewModifier {
    private let radius: CGFloat
    private let opaqueColor: Color
    private let opaque: Bool

    public init(radius: CGFloat = 22, opaqueColor: Color = Color(white: 0.17), opaque: Bool = false) {
        self.radius = radius
        self.opaqueColor = opaqueColor
        self.opaque = opaque
    }

    public func body(content: Content) -> some View {
        content.modifier(
            NativeGlassShapeSurface(
                shape: RoundedRectangle(cornerRadius: radius), opaqueColor: opaqueColor, opaque: opaque))
    }
}

public struct NativeGlassControl: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    @Environment(\.nativeSettingsReduceTransparency) private var requestedOpaque
    @Environment(\.nativeSettingsTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var systemStill
    @Environment(\.nativeSettingsReduceMotion) private var requestedStill
    private let radius: CGFloat
    private let tint: Color

    public init(radius: CGFloat = 12, tint: Color = .white.opacity(0.045)) {
        self.radius = radius
        self.tint = tint
    }

    /// Solid themes get an opaque control, and every theme does under Reduce transparency; the others glass. Dusk
    /// stays Dusk under Reduce transparency (`NativeSettingsTheme.effective`), so the flag is checked here for it, as
    /// its bar does.
    static func isOpaque(theme: NativeSettingsTheme, reduceTransparency: Bool) -> Bool {
        switch theme.effective(reduceTransparency: reduceTransparency, systemReduceTransparency: false) {
        case .solid, .graphite, .midnight: return true
        case .dusk: return reduceTransparency
        case .glass, .gradient: return false
        }
    }

    public func body(content: Content) -> some View {
        let opaqueControl = Self.isOpaque(theme: theme, reduceTransparency: systemOpaque || requestedOpaque)
        let tint = theme == .glass ? NativeThemePalette.glassCardTint : self.tint
        if opaqueControl, theme == .dusk {
            content.modifier(NativeGlassSurface(radius: radius, opaqueColor: NativeThemePalette.duskRaised, opaque: true))
        } else if opaqueControl {
            content.modifier(NativeGlassSurface(radius: radius, opaque: true))
        } else if #available(macOS 26, *) {
            // The whole control answers the pointer, as its opaque form does (glass itself is not hit-tested).
            if systemStill || requestedStill {
                content.foregroundStyle(.white).glassEffect(
                    .regular.tint(tint), in: RoundedRectangle(cornerRadius: radius))
                    .contentShape(RoundedRectangle(cornerRadius: radius))
            } else {
                content.foregroundStyle(.white).glassEffect(
                    .regular.tint(tint).interactive(), in: RoundedRectangle(cornerRadius: radius))
                    .contentShape(RoundedRectangle(cornerRadius: radius))
            }
        } else {
            content.modifier(NativeGlassSurface(radius: radius))
        }
    }
}

public struct NativeSettingsBackdrop: View {
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    @Environment(\.nativeSettingsReduceTransparency) private var requestedOpaque
    @Environment(\.nativeSettingsTheme) private var theme
    private let windowMaterial: Bool

    /// `windowMaterial: false` for a window whose content view already draws the behind-window material (the
    /// hub's glass container): the Glass theme then adds only its dark tint, so the desktop is not blurred twice.
    public init(windowMaterial: Bool = true) { self.windowMaterial = windowMaterial }

    public var body: some View {
        switch theme.effective(reduceTransparency: requestedOpaque, systemReduceTransparency: systemOpaque) {
        case .solid: Color(nsColor: .windowBackgroundColor)
        case .gradient: NativeSettingsGradient()
        case .glass:
            if windowMaterial {
                NativeWindowMaterial().overlay(NativeThemePalette.glassTint)
            } else {
                NativeThemePalette.glassTint
            }
        case .graphite: NativeThemePalette.graphiteBase
        case .midnight: NativeThemePalette.midnightBase
        case .dusk: NativeSettingsDusk()
        }
    }
}

/// The darker themes' colours (sRGB), picked against the hub's own surfaces: background 19,19,20, sidebar 24,24,26,
/// glass about 30,30,31. Secondary text keeps at least 5.2:1 on every backdrop (HIG checker, 2026-10-11).
public enum NativeThemePalette {
    private static func rgb(_ red: Double, _ green: Double, _ blue: Double) -> Color {
        Color(.sRGB, red: red / 255, green: green / 255, blue: blue / 255, opacity: 1)
    }

    /// Graphite: the backdrop, the raised bars and drawers, and a card a step lighter so the structure reads.
    public static let graphiteBase = rgb(22, 22, 24)
    public static let graphiteRaised = rgb(28, 28, 31)
    public static let graphiteCard = rgb(34, 34, 38)
    /// Midnight: blue-black, with blue hairlines instead of white ones.
    public static let midnightBase = rgb(13, 17, 28)
    public static let midnightRaised = rgb(18, 23, 37)
    public static let midnightCard = rgb(24, 31, 49)
    public static let midnightHairline = Color(.sRGB, red: 0.55, green: 0.68, blue: 1.0, opacity: 0.16)
    /// Glass: the dark tint over the window material, and the lighter one over a card's glass.
    public static let glassTint = Color.black.opacity(0.5)
    public static let glassCardTint = Color.black.opacity(0.35)
    /// Dusk: a plum base under Gradient's purple and pink, stronger.
    public static let duskBase = rgb(28, 22, 34)
    public static let duskRaised = rgb(34, 27, 41)
    public static let duskCard = rgb(40, 31, 48)
}

/// The Dusk backdrop: `NativeThemePalette.duskBase` under a stronger purple-to-pink tint than Gradient's.
public struct NativeSettingsDusk: View {
    public init() {}
    public static var tint: LinearGradient {
        LinearGradient(
            colors: [.purple.opacity(0.22), .clear, .pink.opacity(0.10)],
            startPoint: .topTrailing, endPoint: .bottomLeading)
    }
    public var body: some View {
        ZStack {
            NativeThemePalette.duskBase
            Self.tint
        }
    }
}

/// The parts of a window drawn over a `NativeSettingsBackdrop`, by role.
public enum NativePaneLevel: Sendable {
    /// Sidebars, rails and headers: a faint lift over the backdrop, as the settings window's sidebar.
    case chrome
    /// Reading columns: the backdrop itself.
    case content
    /// Sticky headers over scrolling rows and drawers over other panes: frosted, or solid under Solid and
    /// Reduce transparency, so the rows under them never show through sharp.
    case bar
}

extension EnvironmentValues {
    /// On in a host that draws its panes in the native settings look over a `NativeSettingsBackdrop` (the hub's
    /// Native style). GenesisKit panes then draw `NativePaneFill` instead of their own palette.
    @Entry public var nativePanes = false
}

/// The fill of one pane in the native settings look, for the theme in the environment.
public struct NativePaneFill: View {
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    @Environment(\.nativeSettingsReduceTransparency) private var requestedOpaque
    @Environment(\.nativeSettingsTheme) private var theme
    private let level: NativePaneLevel

    public init(_ level: NativePaneLevel) { self.level = level }

    public var body: some View {
        switch level {
        case .chrome: Color.white.opacity(0.025)
        case .content: Color.clear
        case .bar:
            switch theme.effective(reduceTransparency: requestedOpaque, systemReduceTransparency: systemOpaque) {
            case .solid: Color(nsColor: .windowBackgroundColor)
            case .gradient: Rectangle().fill(.regularMaterial)
            case .glass:
                ZStack {
                    Rectangle().fill(.regularMaterial)
                    Color.black.opacity(0.45)
                }
            case .graphite: NativeThemePalette.graphiteRaised
            case .midnight: NativeThemePalette.midnightRaised
            case .dusk:
                // Frosted but dark, so the backdrop's purple still comes through; opaque under Reduce transparency.
                if requestedOpaque || systemOpaque {
                    NativeThemePalette.duskRaised
                } else {
                    ZStack {
                        Rectangle().fill(.ultraThinMaterial)
                        NativeThemePalette.duskBase.opacity(0.6)
                    }
                }
            }
        }
    }
}

/// A pane's background: its own `standard` fill, or `NativePaneFill` while the host draws native panes
/// (`nativePanes`).
public struct NativePaneBackground<Standard: View>: View {
    @Environment(\.nativePanes) private var native
    private let level: NativePaneLevel
    private let standard: Standard

    public init(_ level: NativePaneLevel, @ViewBuilder standard: () -> Standard) {
        self.level = level
        self.standard = standard()
    }

    public var body: some View {
        if native {
            NativePaneFill(level)
        } else {
            standard
        }
    }
}

public struct NativeSettingsGradient: View {
    public init() {}
    public static var tint: LinearGradient {
        LinearGradient(
            colors: [.purple.opacity(0.12), .clear, .pink.opacity(0.06)],
            startPoint: .topTrailing, endPoint: .bottomLeading)
    }
    public var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            Self.tint
        }
    }
}

private struct NativeWindowMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .underWindowBackground
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

@MainActor
private struct NativeAppearanceModifier: ViewModifier {
    @ObservedObject var appearance: NativeSettingsAppearance
    func body(content: Content) -> some View {
        content.nativeSettingsAccessibility(
            reduceMotion: appearance.reduceMotion,
            reduceTransparency: appearance.reduceTransparency
        )
        .environment(\.nativeSettingsTheme, appearance.theme)
    }
}

extension View {
    public func nativeSettingsAccessibility(reduceMotion: Bool, reduceTransparency: Bool) -> some View {
        environment(\.nativeSettingsReduceMotion, reduceMotion)
            .environment(\.nativeSettingsReduceTransparency, reduceTransparency)
    }

    @MainActor
    public func nativeSettingsAppearance(_ appearance: NativeSettingsAppearance) -> some View {
        modifier(NativeAppearanceModifier(appearance: appearance))
    }

    @MainActor
    public func nativeSettingsAppearance() -> some View {
        modifier(NativeAppearanceModifier(appearance: .shared))
    }

    public func nativeGlassSurface<SurfaceShape: Shape>(
        in shape: SurfaceShape, opaqueColor: Color = Color(white: 0.17)
    ) -> some View {
        modifier(NativeGlassShapeSurface(shape: shape, opaqueColor: opaqueColor))
    }

    public func nativeGlassSurface(
        radius: CGFloat = 22, opaqueColor: Color = Color(white: 0.17)
    ) -> some View {
        modifier(NativeGlassSurface(radius: radius, opaqueColor: opaqueColor))
    }

    public func nativeGlassControl(radius: CGFloat = 12, tint: Color = .white.opacity(0.045)) -> some View {
        modifier(NativeGlassControl(radius: radius, tint: tint))
    }
}
