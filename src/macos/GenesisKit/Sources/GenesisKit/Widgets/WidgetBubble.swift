import SwiftUI

/// The chrome of a session bubble on the rail and the top strip: a ring that answers the pointer, and the flash of
/// a session that just asked for you.
///
/// Hover: the ring fades in strong, then settles to a quieter ring while the pointer stays, so a bubble reads as a
/// control the moment it is reached (Martin, 2026-10-23: "missing hover effects (pulsing around)"). Opacity only,
/// two timed steps, never a repeating animation: a `repeatForever` lays the whole window out every frame (swift skill).
struct WidgetBubbleChrome: ViewModifier {
    let trigger: Int
    let attention: AttentionPulseStyle
    let reduceMotion: Bool
    /// When the session's flash began; a bubble rebuilt mid-flash (the rail reordered) plays the rest of it.
    var since: Date?
    @State private var ring = 0.0
    @State private var settle: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .background(Circle().fill(Color.white.opacity(ring > 0 ? 0.07 : 0)).padding(2))
            .overlay(Circle().strokeBorder(Color.white.opacity(ring), lineWidth: 1.5).padding(2).allowsHitTesting(false))
            .attentionPulse(trigger: trigger, style: attention, since: since)
            .onHover { inside in
                settle?.cancel()
                guard inside else {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { ring = 0 }
                    return
                }
                guard !reduceMotion else {
                    ring = 0.5
                    return
                }
                withAnimation(.easeOut(duration: 0.14)) { ring = 0.9 }
                settle = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(220))
                    guard !Task.isCancelled else { return }
                    withAnimation(.easeInOut(duration: 0.35)) { ring = 0.45 }
                }
            }
            .onDisappear { settle?.cancel() }
    }
}

extension WidgetModel {
    /// A rail bubble's tooltip under `bubbleTooltip`: "auto" shows it only while hover previews are off, because
    /// the preview already names the session and an extra label over it read as the preview failing to open.
    func bubbleTooltip(_ content: TooltipContent) -> TooltipContent {
        switch snapshot?.state.preferences.bubbleTooltip ?? "auto" {
        case "always": return content
        case "never": return TooltipContent()
        default: return layout.hoverPreviews ? TooltipContent() : content
        }
    }
}
