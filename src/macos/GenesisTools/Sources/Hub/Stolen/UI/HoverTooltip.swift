// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/UI/HoverTooltip.swift at 2026-09-24T05:05:15+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
//
//  HoverTooltip.swift
//  Genesis
//
//  Themed hover affordances shared across the app. `.hoverHighlight()` gives
//  any view a soft fill + colored border on hover. `.instantTooltip()` is a
//  thin forward to the ONE shared tooltip implementation in
//  GenesisAIMonitorKit/InstantTooltip.swift (floating NSPanel + watchdog), so
//  the main window, Session Details and the menu-bar usage popup all share the
//  same bubble and the same dismiss rules. The app injects its palette once at
//  launch via `TooltipTheme.install()`.
//

// GenesisTools adaptation: the kit types are compiled into this module.
// import GenesisAIMonitorKit
import SwiftUI

struct HoverHighlight: ViewModifier {
    var color: Color
    var cornerRadius: CGFloat
    var fillOpacity: Double
    var borderOpacity: Double
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(color.opacity(hovering ? fillOpacity : 0))
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(color.opacity(hovering ? borderOpacity : 0), lineWidth: 1)
            )
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.14), value: hovering)
    }
}

extension View {
    /// Soft themed fill + border on hover. Default green (`genSuccess`) matches
    /// the "green border on hover" ask; pass a color for other accents.
    func hoverHighlight(
        color: Color = .genSuccess,
        cornerRadius: CGFloat = 8,
        fillOpacity: Double = 0.08,
        borderOpacity: Double = 0.7
    ) -> some View {
        modifier(HoverHighlight(
            color: color, cornerRadius: cornerRadius,
            fillOpacity: fillOpacity, borderOpacity: borderOpacity))
    }

    /// Quick, theme-styled tooltip on hover — a floating panel, always frontmost,
    /// works in every host (titlebar, content, sheets, HUD). Non-interactive.
    // GenesisTools adaptation: InstantTooltip.swift (kit) declares the identical modifier; in Genesis
    // they live in separate modules, here they would collide.
    // func instantTooltip(_ text: String, below: Bool = true) -> some View {
    //     modifier(InstantTooltip(text: text, below: below))
    // }

    /// No-op retained so existing call sites compile. The panel-based tooltip
    /// needs no per-window layer.
    func tooltipLayer() -> some View { self }
}

/// Points the kit's tooltip bubble at the app palette. Call once at launch.
@MainActor
enum TooltipTheme {
    static func install() {
        InstantTooltipStyle.current = InstantTooltipStyle(
            fontSize: 11,
            textColor: .settingsText,
            border: Color.white.opacity(0.12)
        )
    }
}
