import AppKit
import SwiftUI

private struct NativeReduceMotionKey: EnvironmentKey { static let defaultValue = false }
private struct NativeReduceTransparencyKey: EnvironmentKey { static let defaultValue = false }
private struct NativeThemeKey: EnvironmentKey { static let defaultValue = NativeSettingsTheme.glass }

extension EnvironmentValues {
    public var nativeSettingsTheme: NativeSettingsTheme {
        get { self[NativeThemeKey.self] }
        set { self[NativeThemeKey.self] = newValue }
    }
    public var nativeSettingsReduceMotion: Bool {
        get { self[NativeReduceMotionKey.self] }
        set { self[NativeReduceMotionKey.self] = newValue }
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
    private let tint: Color
    private let opaqueColor: Color
    private let opaque: Bool

    public init(
        shape: SurfaceShape, tint: Color = .white.opacity(0.035),
        opaqueColor: Color = Color(white: 0.17), opaque: Bool = false
    ) {
        self.shape = shape
        self.tint = tint
        self.opaqueColor = opaqueColor
        self.opaque = opaque
    }

    public func body(content: Content) -> some View {
        if systemOpaque || requestedOpaque || opaque || theme == .solid {
            content.background(opaqueColor, in: shape)
                .overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
        } else if theme == .gradient {
            content.foregroundStyle(Color.white).background {
                ZStack {
                    opaqueColor
                    NativeSettingsGradient.tint
                }.clipShape(shape)
            }.overlay(shape.stroke(.white.opacity(0.08), lineWidth: 1))
        } else if #available(macOS 26, *) {
            content.foregroundStyle(Color.white).glassEffect(.regular.tint(tint), in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(.white.opacity(0.10), lineWidth: 1))
        }
    }
}

public struct NativeGlassSurface: ViewModifier {
    private let radius: CGFloat
    private let tint: Color
    private let opaqueColor: Color
    private let opaque: Bool

    public init(
        radius: CGFloat = 22, tint: Color = .white.opacity(0.035),
        opaqueColor: Color = Color(white: 0.17), opaque: Bool = false
    ) {
        self.radius = radius
        self.tint = tint
        self.opaqueColor = opaqueColor
        self.opaque = opaque
    }

    public func body(content: Content) -> some View {
        content.modifier(
            NativeGlassShapeSurface(
                shape: RoundedRectangle(cornerRadius: radius),
                tint: tint, opaqueColor: opaqueColor, opaque: opaque))
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

    public func body(content: Content) -> some View {
        if systemOpaque || requestedOpaque || theme == .solid {
            content.modifier(NativeGlassSurface(radius: radius, opaque: true))
        } else if #available(macOS 26, *) {
            if systemStill || requestedStill {
                content.foregroundStyle(.white).glassEffect(
                    .regular.tint(tint), in: RoundedRectangle(cornerRadius: radius))
            } else {
                content.foregroundStyle(.white).glassEffect(
                    .regular.tint(tint).interactive(), in: RoundedRectangle(cornerRadius: radius))
            }
        } else {
            content.modifier(NativeGlassSurface(radius: radius, tint: tint))
        }
    }
}

public struct NativeSettingsBackdrop: View {
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    @Environment(\.nativeSettingsReduceTransparency) private var requestedOpaque
    @Environment(\.nativeSettingsTheme) private var theme
    public init() {}
    public var body: some View {
        switch theme.effective(reduceTransparency: requestedOpaque, systemReduceTransparency: systemOpaque) {
        case .solid: Color(nsColor: .windowBackgroundColor)
        case .gradient: NativeSettingsGradient()
        case .glass: NativeWindowMaterial().overlay(Color.black.opacity(0.06))
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
        in shape: SurfaceShape, tint: Color = .white.opacity(0.035),
        opaqueColor: Color = Color(white: 0.17)
    ) -> some View {
        modifier(NativeGlassShapeSurface(shape: shape, tint: tint, opaqueColor: opaqueColor))
    }

    public func nativeGlassSurface(
        radius: CGFloat = 22, tint: Color = .white.opacity(0.035),
        opaqueColor: Color = Color(white: 0.17)
    ) -> some View {
        modifier(NativeGlassSurface(radius: radius, tint: tint, opaqueColor: opaqueColor))
    }

    public func nativeGlassControl(radius: CGFloat = 12, tint: Color = .white.opacity(0.045)) -> some View {
        modifier(NativeGlassControl(radius: radius, tint: tint))
    }
}
