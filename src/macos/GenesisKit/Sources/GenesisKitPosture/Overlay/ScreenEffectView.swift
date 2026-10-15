import AppKit
import SwiftUI
import GenesisKit
import GenesisKitCharts

/// What one screen of a screen effect shows: the tint of `style` at `intensity`, and the message pill. A still view:
/// the ramp in and out is the panel's alpha, so nothing here animates or redraws while the effect is up. A settings
/// page can show it in a small frame as a live preview of the chosen style.
public struct ScreenEffectView: View {
    private let style: ScreenEffectStyle
    private let intensity: Double
    private let glow: ChartColor
    let message: ScreenEffectMessage?
    private let pillCenter: CGPoint?
    private let reduceTransparency: Bool

    /// - Parameters:
    ///   - pillCenter: where the pill's centre goes, from the top-left; nil puts it a third of the way down.
    ///   - reduceTransparency: draw blur as dim and the pill solid (the controller passes the system setting).
    public init(
        style: ScreenEffectStyle, intensity: Double, glow: ChartColor = .init(red: 0.96, green: 0.38, blue: 0.40),
        message: ScreenEffectMessage? = nil, pillCenter: CGPoint? = nil, reduceTransparency: Bool = false
    ) {
        self.style = style
        self.intensity = intensity.isFinite ? min(2, max(0, intensity)) : 1
        self.glow = glow
        self.message = message
        self.pillCenter = pillCenter
        self.reduceTransparency = reduceTransparency
    }

    public var body: some View {
        GeometryReader { proxy in
            ZStack {
                tint(size: proxy.size)
                if let message, !message.text.isEmpty {
                    ScreenEffectPill(message: message, solid: reduceTransparency)
                        .position(pillCenter ?? CGPoint(x: proxy.size.width / 2, y: proxy.size.height * 0.3))
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func tint(size: CGSize) -> some View {
        switch style.effective(reduceTransparency: reduceTransparency) {
        case .vignette:
            let strength = Self.vignetteStrength(intensity)
            EllipticalGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .clear, location: strength.clearUntil),
                    .init(color: .black.opacity(strength.edge * 0.55), location: (strength.clearUntil + 1) / 2),
                    .init(color: .black.opacity(strength.edge), location: 1),
                ],
                center: .center, startRadiusFraction: 0, endRadiusFraction: 0.68)
        case .transparent:
            Color.clear
        case .sepia:
            // Takes the blue out (the "blue filter" of posture apps) and warms what is left.
            ZStack {
                Color(.sRGB, red: 0.98, green: 0.62, blue: 0.24).opacity(min(0.5, 0.24 * intensity))
                Color(.sRGB, red: 0.30, green: 0.16, blue: 0.04).opacity(min(0.18, 0.06 * intensity))
            }
        case .blur:
            ScreenEffectBlur(alpha: Self.blurAlpha(intensity))
        case .dim:
            Color.black.opacity(Self.dimOpacity(intensity))
        case .edgeGlow:
            ScreenEffectGlow(color: Color(.sRGB, red: glow.red, green: glow.green, blue: glow.blue), intensity: intensity, size: size)
        }
    }

    // MARK: Strength curves (tested)

    /// The vignette's clear middle (as a fraction of the radius) and its edge darkness, both from intensity 0...2.
    static func vignetteStrength(_ intensity: Double) -> (clearUntil: Double, edge: Double) {
        let i = min(2, max(0, intensity))
        return (clearUntil: max(0.15, 0.55 - 0.2 * i), edge: min(0.95, 0.62 * i))
    }

    /// The blur view's alpha (Dorso's curve: square root of the level, a little boosted), capped at 0.85 so the
    /// screen behind stays readable at full intensity, like the dim's cap.
    static func blurAlpha(_ intensity: Double) -> Double {
        min(0.85, (min(2, max(0, intensity)) / 2).squareRoot() * 1.2)
    }

    static func dimOpacity(_ intensity: Double) -> Double {
        min(0.78, 0.34 * min(2, max(0, intensity)))
    }
}

/// The "Sit up straight" pill: a glass capsule in a hairline shell, the symbol in the kit accent, the text in white.
struct ScreenEffectPill: View {
    let message: ScreenEffectMessage
    let solid: Bool

    var body: some View {
        HStack(spacing: 10) {
            if let symbol = message.symbol {
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(KitTheme.accent)
            }
            Text(verbatim: message.text)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 12)
        .background {
            if solid {
                Capsule().fill(Color(white: 0.10))
            } else {
                Capsule().fill(.ultraThinMaterial).overlay(Capsule().fill(Color.black.opacity(0.38)))
            }
        }
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5))
        // The shell: a second hairline a few points out, so the pill reads as a set piece rather than a label.
        .padding(4)
        .background(Capsule().fill(Color.white.opacity(0.05)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.24), radius: 14, y: 6)
        .environment(\.colorScheme, .dark)
    }
}

/// A glow along all four edges, strongest at the edge and gone a band's width in.
struct ScreenEffectGlow: View {
    let color: Color
    let intensity: Double
    let size: CGSize

    var body: some View {
        let band = min(min(size.width, size.height) / 3, 26 + 34 * intensity)
        let edge = min(0.9, 0.5 * intensity + 0.15)
        let stops: [Gradient.Stop] = [
            .init(color: color.opacity(edge), location: 0),
            .init(color: color.opacity(edge * 0.35), location: 0.45),
            .init(color: color.opacity(0), location: 1),
        ]
        ZStack {
            color.opacity(min(0.08, 0.035 * intensity))
            VStack(spacing: 0) {
                LinearGradient(stops: stops, startPoint: .top, endPoint: .bottom).frame(height: band)
                Spacer(minLength: 0)
                LinearGradient(stops: stops, startPoint: .bottom, endPoint: .top).frame(height: band)
            }
            HStack(spacing: 0) {
                LinearGradient(stops: stops, startPoint: .leading, endPoint: .trailing).frame(width: band)
                Spacer(minLength: 0)
                LinearGradient(stops: stops, startPoint: .trailing, endPoint: .leading).frame(width: band)
            }
        }
    }
}

/// The behind-window blur, its strength as the view's alpha (state `.active`, so it blurs in an inactive app too).
struct ScreenEffectBlur: NSViewRepresentable {
    let alpha: Double

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.blendingMode = .behindWindow
        view.material = .fullScreenUI
        view.state = .active
        view.alphaValue = alpha
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        if view.alphaValue != alpha { view.alphaValue = alpha }
    }
}
