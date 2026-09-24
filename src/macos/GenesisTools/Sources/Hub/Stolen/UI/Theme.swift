// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Theme.swift at 2026-09-24T05:05:15+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
//
//  Theme.swift
//  Genesis
//
//  Design System: Cinematic Memory + Cyberpunk Settings
//  Ported from TimeTravel (Rewind) — see Genesis/docs/DESIGN.swift.md.
//  tt* prefix renamed gen*; settings*/neon* tokens kept verbatim.
//

import AppKit
import SwiftUI

// MARK: - Color Palette (Cinematic Memory)

extension Color {
    // Primary palette - Deep blacks with warm undertones
    static let genBackground = Color(red: 0.06, green: 0.05, blue: 0.07)
    static let genSurface = Color(red: 0.10, green: 0.09, blue: 0.11)
    static let genSurfaceElevated = Color(red: 0.14, green: 0.13, blue: 0.15)

    // Accent - Warm amber (nostalgia, film grain)
    static let genAccent = Color(red: 1.0, green: 0.76, blue: 0.28)
    static let genAccentSubtle = Color(red: 1.0, green: 0.76, blue: 0.28).opacity(0.15)
    static let genAccentGlow = Color(red: 1.0, green: 0.85, blue: 0.45)

    // Text hierarchy
    static let genTextPrimary = Color.white
    static let genTextSecondary = Color.white.opacity(0.7)
    static let genTextTertiary = Color.white.opacity(0.4)
    static let genTextMuted = Color.white.opacity(0.25)

    // Semantic colors
    static let genSuccess = Color(red: 0.35, green: 0.85, blue: 0.55)
    static let genWarning = Color(red: 1.0, green: 0.65, blue: 0.25)
    static let genError = Color(red: 1.0, green: 0.35, blue: 0.35)

    // Glass effect colors
    static let genGlassFill = Color.white.opacity(0.08)
    static let genGlassBorder = Color.white.opacity(0.12)
    static let genGlassHighlight = Color.white.opacity(0.15)
}

// MARK: - Typography

struct GenTypography {
    // Display - For large timestamps, titles
    static func display(_ size: CGFloat = 48, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    // Headline - Section headers
    static func headline(_ size: CGFloat = 17, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    // Body - Regular text
    static func body(_ size: CGFloat = 14, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    // Caption - Small labels
    static func caption(_ size: CGFloat = 12, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    // Mono - Timestamps, code
    static func mono(_ size: CGFloat = 13, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// MARK: - Spacing

struct GenSpacing {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let xxxl: CGFloat = 48
}

// MARK: - Radius

struct GenRadius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 14
    static let xl: CGFloat = 20
    static let full: CGFloat = 999
}

// MARK: - Shadows

struct GenShadow {
    static let subtle = (color: Color.black.opacity(0.25), radius: CGFloat(8), x: CGFloat(0), y: CGFloat(2))
    static let medium = (color: Color.black.opacity(0.35), radius: CGFloat(16), x: CGFloat(0), y: CGFloat(4))
    static let strong = (color: Color.black.opacity(0.5), radius: CGFloat(24), x: CGFloat(0), y: CGFloat(8))
    static let glow = (color: Color.genAccent.opacity(0.3), radius: CGFloat(20), x: CGFloat(0), y: CGFloat(0))
}

// MARK: - Animation

struct GenAnimation {
    static let quick = Animation.easeOut(duration: 0.15)
    static let standard = Animation.easeInOut(duration: 0.25)
    static let smooth = Animation.easeInOut(duration: 0.35)
    static let slow = Animation.easeInOut(duration: 0.5)

    // Spring animations — the load-bearing curves; don't invent new ones.
    static let springy = Animation.spring(response: 0.35, dampingFraction: 0.7)
    static let bouncy = Animation.spring(response: 0.4, dampingFraction: 0.6)
    static let gentle = Animation.spring(response: 0.5, dampingFraction: 0.85)
}

// MARK: - Glass Effect Modifier

struct GlassEffect: ViewModifier {
    var cornerRadius: CGFloat = GenRadius.lg
    var borderWidth: CGFloat = 1
    var intensity: Double = 0.08

    func body(content: Content) -> some View {
        content
            .background(
                ZStack {
                    // Blur background
                    VisualEffectBlur(material: .hudWindow, blendingMode: .behindWindow)

                    // Tinted overlay
                    Color.white.opacity(intensity)
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.2),
                                Color.white.opacity(0.05)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: borderWidth
                    )
            )
            .shadow(color: GenShadow.medium.color, radius: GenShadow.medium.radius, x: GenShadow.medium.x, y: GenShadow.medium.y)
    }
}

extension View {
    func glassEffect(cornerRadius: CGFloat = GenRadius.lg, borderWidth: CGFloat = 1, intensity: Double = 0.08) -> some View {
        modifier(GlassEffect(cornerRadius: cornerRadius, borderWidth: borderWidth, intensity: intensity))
    }
}

// MARK: - Visual Effect Blur (NSVisualEffectView wrapper)

struct VisualEffectBlur: NSViewRepresentable {
    var material: NSVisualEffectView.Material
    var blendingMode: NSVisualEffectView.BlendingMode
    var state: NSVisualEffectView.State = .active

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = state
        view.wantsLayer = true
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blendingMode
        nsView.state = state
    }
}

// MARK: - Glow Effect Modifier

struct GlowEffect: ViewModifier {
    var color: Color = .genAccent
    var radius: CGFloat = 12
    var isActive: Bool = true

    func body(content: Content) -> some View {
        content
            .shadow(color: isActive ? color.opacity(0.5) : .clear, radius: radius)
            .shadow(color: isActive ? color.opacity(0.3) : .clear, radius: radius * 2)
    }
}

extension View {
    func glowEffect(color: Color = .genAccent, radius: CGFloat = 12, isActive: Bool = true) -> some View {
        modifier(GlowEffect(color: color, radius: radius, isActive: isActive))
    }
}

// MARK: - Hover Scale Effect

struct HoverScaleEffect: ViewModifier {
    @State private var isHovered = false
    var scale: CGFloat = 1.02

    func body(content: Content) -> some View {
        content
            .scaleEffect(isHovered ? scale : 1.0)
            .animation(GenAnimation.quick, value: isHovered)
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

extension View {
    func hoverScale(_ scale: CGFloat = 1.02) -> some View {
        modifier(HoverScaleEffect(scale: scale))
    }
}

// MARK: - Shimmer Effect

/// Start — or genuinely RESTART — a `repeatForever` animation.
///
/// `withAnimation(loop) { flag = true }` on its own is a no-op whenever `flag`
/// is ALREADY true. SwiftUI sees no value change, installs no animation, and
/// the view sits frozen at the end phase. That happens in two ordinary cases:
/// a second `onAppear` for a view identity that survived being removed and
/// re-added, and any attempt to retarget a running loop (e.g. changing its
/// duration). Writing `flag = false` immediately before doesn't help either —
/// both writes land in the SAME transaction and collapse to `true -> true`.
///
/// So: reset in its own non-animated transaction, then start the loop on the
/// next turn of the main actor.
@MainActor
func restartLoopingAnimation(
    _ animation: Animation,
    reset: () -> Void,
    start: @escaping () -> Void
) {
    var instant = Transaction()
    instant.disablesAnimations = true
    withTransaction(instant, reset)
    Task { @MainActor in
        withAnimation(animation, start)
    }
}

/// STOP a `repeatForever` animation started by `restartLoopingAnimation`.
///
/// The obvious move — writing the property inside a transaction with
/// `disablesAnimations = true` — does NOT work. The repeating animation is
/// attached to the animatable attribute, and a transaction that carries no
/// animation leaves it attached: the view keeps rendering (and burning a
/// display frame) forever. Verified 2026-07-25: the agent orb still cost
/// 16.5% of a core after its stop path had demonstrably run (the state flag
/// was false in the log and the rings kept turning).
///
/// Replacing it with a zero-duration animation is what actually detaches it.
@MainActor
func stopLoopingAnimation(_ stop: () -> Void) {
    withAnimation(.linear(duration: 0), stop)
}

struct ShimmerEffect: ViewModifier {
    @State private var phase: CGFloat = 0
    var isActive: Bool = true

    @ViewBuilder
    func body(content: Content) -> some View {
        if isActive {
            // Only run the GeometryReader + .repeatForever animation when
            // shimmer is actually enabled — installing it unconditionally
            // carries permanent layout cost on every view (TimeTravel perf fix).
            content
                .overlay(
                    GeometryReader { geo in
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0),
                                Color.white.opacity(0.15),
                                Color.white.opacity(0)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geo.size.width * 0.5)
                        .offset(x: phase * geo.size.width * 1.5 - geo.size.width * 0.25)
                        .mask(content)
                    }
                )
                .onAppear {
                    // Restart, not just start: `isActive` gates this whole
                    // branch, so toggling shimmer off and on again re-fires
                    // onAppear with `phase` already at 1 — the shimmer used to
                    // stay frozen at the end of its sweep from then on.
                    restartLoopingAnimation(
                        .linear(duration: 1.5).repeatForever(autoreverses: false),
                        reset: { phase = 0 },
                        start: { phase = 1 })
                }
        } else {
            content
        }
    }
}

extension View {
    func shimmer(isActive: Bool = true) -> some View {
        modifier(ShimmerEffect(isActive: isActive))
    }
}

// MARK: - Cyberpunk Settings Design System

extension Color {
    // Cyberpunk deep backgrounds
    static let settingsBackground = Color(red: 0.012, green: 0.012, blue: 0.031)
    static let settingsSidebar = Color(red: 0.024, green: 0.024, blue: 0.047)
    /// Vault reading pane — the near-black settings base, nudged a touch lighter
    /// (was the muddy mid-gray `genSurface`, which read as inconsistent "garbage"
    /// against the rest of the near-black UI).
    static let vaultReadingBg = Color(red: 0.02, green: 0.02, blue: 0.045)
    static let settingsCard = Color(red: 0.039, green: 0.039, blue: 0.078)
    static let settingsCardHover = Color(red: 0.055, green: 0.055, blue: 0.098)

    // Neon accents
    static let neonAmber = Color(red: 1.0, green: 0.63, blue: 0.2)
    /// Light-ish orange for highlighting query matches in search results.
    static let searchHighlight = Color(red: 1.0, green: 0.80, blue: 0.48)
    static let neonAmberGlow = Color(red: 1.0, green: 0.72, blue: 0.35)
    static let neonCyan = Color(red: 0.0, green: 0.94, blue: 1.0)
    static let neonCyanGlow = Color(red: 0.35, green: 0.96, blue: 1.0)
    static let neonPurple = Color(red: 0.66, green: 0.33, blue: 0.97)

    // Settings-specific
    static let settingsBorder = Color.white.opacity(0.06)
    static let settingsBorderActive = Color.neonAmber.opacity(0.4)
    static let settingsText = Color.white.opacity(0.92)
    static let settingsTextSecondary = Color.white.opacity(0.55)
    static let settingsTextMuted = Color.white.opacity(0.35)
}

// MARK: - JARVIS Teal Accent

extension Color {
    // From docs/DESIGN.jarvis.html (--primary-teal / --primary-cyan / --border-color).
    // First-class accent for the agent orb, welcome, voice panel, and composer
    // surfaces. Additive: the amber/cyan neons above stay for Settings etc.
    static let jarvisTeal = Color(red: 0.0, green: 0.85, blue: 0.72) // #00d9b8
    static let jarvisCyan = Color(red: 0.0, green: 0.85, blue: 1.0) // #00d9ff
    static let jarvisBorder = Color(red: 0.0, green: 0.85, blue: 1.0).opacity(0.15)
    static let genWaiting = Color(red: 0.61, green: 0.55, blue: 1.0) // #9b8cff — web --color-wait
}

// MARK: - Neon Card Style

struct NeonCardStyle: ViewModifier {
    var isHovered: Bool = false
    var accentColor: Color = .neonAmber

    func body(content: Content) -> some View {
        content
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.settingsCard.opacity(isHovered ? 1.0 : 0.9),
                                    Color.settingsCard.opacity(isHovered ? 0.95 : 0.85)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )

                    // Subtle inner glow on hover
                    if isHovered {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(accentColor.opacity(0.03))
                    }
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [
                                isHovered ? accentColor.opacity(0.4) : Color.white.opacity(0.08),
                                isHovered ? accentColor.opacity(0.2) : Color.white.opacity(0.03)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            )
            .shadow(
                color: isHovered ? accentColor.opacity(0.15) : Color.clear,
                radius: 20,
                x: 0,
                y: 4
            )
    }
}

extension View {
    func neonCard(isHovered: Bool = false, accentColor: Color = .neonAmber) -> some View {
        modifier(NeonCardStyle(isHovered: isHovered, accentColor: accentColor))
    }
}

// MARK: - Neon Toggle Style

struct NeonToggleStyle: ToggleStyle {
    var accent: Color = .neonAmber

    func makeBody(configuration: Configuration) -> some View {
        HStack {
            configuration.label
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.settingsText)

            Spacer()

            ZStack {
                // Track
                Capsule()
                    .fill(configuration.isOn ? accent.opacity(0.2) : Color.white.opacity(0.08))
                    .frame(width: 44, height: 24)
                    .overlay(
                        Capsule()
                            .stroke(
                                configuration.isOn ? accent.opacity(0.5) : Color.white.opacity(0.1),
                                lineWidth: 1
                            )
                    )

                // Thumb
                Circle()
                    .fill(configuration.isOn ? accent : Color.white.opacity(0.7))
                    .frame(width: 18, height: 18)
                    .shadow(color: configuration.isOn ? accent.opacity(0.5) : Color.clear, radius: 6)
                    .offset(x: configuration.isOn ? 10 : -10)
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isOn)
            .onTapGesture {
                configuration.isOn.toggle()
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture {
            configuration.isOn.toggle()
        }
    }
}

// MARK: - Settings Card

struct SettingsCard<Content: View>: View {
    let icon: String
    let title: String
    var accentColor: Color = .neonAmber
    @ViewBuilder let content: Content

    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(icon: icon, title: title, accentColor: accentColor)
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 6)
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .neonCard(isHovered: isHovered, accentColor: accentColor)
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.15)) { isHovered = hovering }
        }
    }
}

// MARK: - Settings Toggle Row

struct SettingsToggleRow: View {
    let title: String
    var subtitle: String? = nil
    @Binding var isOn: Bool
    var accent: Color = .neonAmber
    var isDisabled: Bool = false

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(.settingsTextMuted)
                }
            }
        }
        .toggleStyle(NeonToggleStyle(accent: accent))
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1.0)
    }
}

// MARK: - Settings Info Row

struct SettingsInfoRow: View {
    let label: String
    let value: String
    var valueColor: Color = .settingsTextSecondary

    var body: some View {
        // Baseline-align so a value that wraps to 2+ lines keeps its first line
        // level with the label instead of floating the label to vertical center.
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.settingsText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 16)
            Text(value)
                .font(.system(size: 12.5, weight: .medium, design: .monospaced))
                .foregroundColor(valueColor)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Settings Section Header

struct SettingsSectionHeader: View {
    let icon: String
    let title: String
    var accentColor: Color = .neonAmber

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(accentColor)
                .frame(width: 28, height: 28)
                .background(accentColor.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .shadow(color: accentColor.opacity(0.3), radius: 4)

            // The title takes the width it needs and the rule gives way. Without this the
            // HStack splits the space proportionally and a long title wraps to two lines —
            // "FOCUS WHILE LISTENING" broke across the icon in the General pane.
            Text(title)
                .font(.system(size: 13, weight: .semibold, design: .default))
                .foregroundColor(.settingsText)
                .tracking(0.5)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)

            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [accentColor.opacity(0.3), accentColor.opacity(0.0)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(minWidth: 8, maxWidth: .infinity)
                .frame(height: 1)
        }
        .padding(.bottom, 8)
    }
}

// MARK: - Settings Row

struct SettingsRow<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        // No horizontal inset: SettingsInfoRow and SettingsToggleRow have
        // none, and the 14pt this used to add pushed every Companion picker
        // and button out of line with the labels above and below it.
        content
            .padding(.vertical, 6)
    }
}

// MARK: - Sidebar Navigation Item

struct SidebarNavItem: View {
    let icon: String
    let title: String
    let isSelected: Bool
    var accent: Color = .neonAmber
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            // 38pt rows. At 52pt, eleven Settings tabs overflowed the 520pt
            // window: the VStack centred itself, the "Settings" header slid
            // under the traffic lights and "About" fell off the bottom. The
            // title used to be `.fixedSize()` too, which let "Permissions"
            // widen DevTools' 168pt rail and shift the whole column left.
            HStack(spacing: 10) {
                // Icon with glow
                ZStack {
                    if isSelected {
                        Circle()
                            .fill(accent.opacity(0.2))
                            .frame(width: 26, height: 26)
                            .blur(radius: 7)
                    }

                    Image(systemName: icon)
                        .font(.system(size: 14, weight: isSelected ? .semibold : .medium))
                        .foregroundColor(isSelected ? accent : .settingsTextSecondary)
                        .frame(width: 22, height: 22)
                }
                .frame(width: 26, height: 26)

                Text(title)
                    .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
                    .foregroundColor(isSelected ? .settingsText : .settingsTextSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 0)
            }
            .padding(.leading, 10)
            // Room for the active bar, which is an overlay so it never takes
            // width from the title.
            .padding(.trailing, 16)
            .padding(.vertical, 6)
            .overlay(alignment: .trailing) {
                if isSelected {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(accent)
                        .frame(width: 3, height: 18)
                        .shadow(color: accent.opacity(0.6), radius: 4)
                        .padding(.trailing, 8)
                }
            }
            .contentShape(Rectangle()) // Makes entire area clickable
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isSelected ? accent.opacity(0.1) : (isHovered ? Color.white.opacity(0.04) : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(isSelected ? accent.opacity(0.3) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.genHoverPlain())
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
    }
}

// MARK: - Neon Slider

struct NeonSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    var accent: Color = .neonAmber
    var trailing: (Double) -> String = { String(format: "%.0f", $0) }
    /// Called ONCE when the drag ends, with the final value. Persist here, not
    /// from `.onChange(of: value)` — the binding is written on every drag delta,
    /// and settings writes go through ConfigStore.mutate, which does a
    /// synchronous flock + full client.json read + serialize + write on the
    /// main actor. Persisting per delta is dozens of blocking disk round-trips
    /// per second while the thumb moves.
    var onCommit: (Double) -> Void = { _ in }

    @State private var isDragging = false

    var body: some View {
        HStack(spacing: 12) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.08))
                        .frame(height: 6)
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [accent.opacity(0.7), accent],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(0, fillWidth(in: geo.size.width)), height: 6)
                        .shadow(color: accent.opacity(0.6), radius: 6)
                    Circle()
                        .fill(accent)
                        .frame(width: 16, height: 16)
                        .shadow(color: accent.opacity(0.7), radius: isDragging ? 10 : 6)
                        .scaleEffect(isDragging ? 1.2 : 1.0)
                        .offset(x: max(0, fillWidth(in: geo.size.width) - 8))
                        .animation(.spring(response: 0.25, dampingFraction: 0.7), value: isDragging)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { g in
                            isDragging = true
                            updateValue(at: g.location.x, width: geo.size.width)
                        }
                        .onEnded { _ in
                            isDragging = false
                            onCommit(value)
                        }
                )
            }
            .frame(height: 20)

            Text(trailing(value))
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(.settingsText)
                .frame(minWidth: 56, alignment: .trailing)
        }
    }

    private func fillWidth(in totalWidth: CGFloat) -> CGFloat {
        let progress = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
        return CGFloat(max(0, min(1, progress))) * totalWidth
    }

    private func updateValue(at x: CGFloat, width: CGFloat) {
        let p = max(0, min(1, x / max(1, width)))
        value = range.lowerBound + Double(p) * (range.upperBound - range.lowerBound)
    }
}

// MARK: - Primary Button Style

struct PrimaryButtonStyle: ButtonStyle {
    var accent: Color = .neonAmber

    // Hover feedback, like `.genHover` (see DESIGN.swift.md "Buttons must
    // react to the pointer"): these two styles had press feedback only, so
    // every Save / Reveal / Open button looked dead under the pointer.
    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let active = isHovering && isEnabled
        return configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundColor(.black)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [accent, accent.opacity(0.85)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .shadow(color: accent.opacity(configuration.isPressed ? 0.2 : 0.5), radius: 8)
            )
            .brightness(active && !configuration.isPressed ? 0.06 : 0)
            .scaleEffect(configuration.isPressed ? 0.97 : (active && !reduceMotion ? 1.02 : 1.0))
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .onHover { hovering in
                withAnimation(reduceMotion ? nil : GenAnimation.quick) { isHovering = hovering }
            }
    }
}

// MARK: - Secondary Button Style

struct SecondaryButtonStyle: ButtonStyle {
    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let active = isHovering && isEnabled
        return configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(.settingsText)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.14 : (active ? 0.12 : 0.08)))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.white.opacity(active ? 0.24 : 0.12), lineWidth: 1)
            )
            .opacity(isEnabled ? 1 : 0.45)
            .scaleEffect(configuration.isPressed ? 0.97 : (active && !reduceMotion ? 1.02 : 1.0))
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .onHover { hovering in
                withAnimation(reduceMotion ? nil : GenAnimation.quick) { isHovering = hovering }
            }
    }
}

// MARK: - Tag Pill

struct TagPill: View {
    let text: String
    var color: Color = .neonAmber

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .bold))
            .foregroundColor(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(color.opacity(0.15))
            )
            .overlay(
                Capsule()
                    .stroke(color.opacity(0.4), lineWidth: 1)
            )
    }
}

// MARK: - Animated Background Grid

struct CyberpunkGrid: View {
    var body: some View {
        GeometryReader { geo in
            Canvas { context, size in
                let gridSize: CGFloat = 40
                let lineWidth: CGFloat = 0.5

                // Horizontal lines
                for y in stride(from: 0, through: size.height, by: gridSize) {
                    var path = Path()
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: size.width, y: y))
                    context.stroke(path, with: .color(.neonAmber.opacity(0.04)), lineWidth: lineWidth)
                }

                // Vertical lines
                for x in stride(from: 0, through: size.width, by: gridSize) {
                    var path = Path()
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: size.height))
                    context.stroke(path, with: .color(.neonAmber.opacity(0.04)), lineWidth: lineWidth)
                }
            }
        }
    }
}

// MARK: - Pulse Glow (static)

struct PulseGlow: ViewModifier {
    var color: Color = .neonAmber

    // Deliberately STATIC (GenesisFanControl lesson): the TimeTravel original
    // animated shadow radius+opacity with `.repeatForever`. Profiling (`sample`)
    // showed it the single biggest idle-CPU sink — an always-visible view
    // animating a shadow forces a Core Animation commit every display frame,
    // and the radius change re-rasterizes the offscreen blur each frame,
    // dragging WindowServer up too. A static shadow renders once.
    func body(content: Content) -> some View {
        content.shadow(color: color.opacity(0.3), radius: 10)
    }
}

extension View {
    func pulseGlow(color: Color = .neonAmber) -> some View {
        modifier(PulseGlow(color: color))
    }
}
