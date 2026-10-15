//
//  HoverHighlight.swift
//  GenesisKit
//
//  `.hoverHighlight()`: a soft fill and colored border on hover, for a view that is not a button (buttons use the
//  `.genHover*` styles). `.axMarker(_:)`: an accessibility identifier that never replaces its children's own.
//

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

public extension View {
    /// A soft themed fill and border on hover; green (`genSuccess`, spelled out because a public default cannot
    /// name an internal color) unless a color is passed.
    func hoverHighlight(
        color: Color = Color(red: 0.35, green: 0.85, blue: 0.55),
        cornerRadius: CGFloat = 8,
        fillOpacity: Double = 0.08,
        borderOpacity: Double = 0.7
    ) -> some View {
        modifier(HoverHighlight(
            color: color, cornerRadius: cornerRadius,
            fillOpacity: fillOpacity, borderOpacity: borderOpacity))
    }

    /// An accessibility identifier on a 1×1 leaf overlay instead of the view itself. On a container,
    /// `.accessibilityIdentifier` propagates to its children and replaces their own ids; a leaf has no children
    /// to clobber.
    func axMarker(_ id: String) -> some View {
        overlay(alignment: .topLeading) {
            Color.clear
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
                .accessibilityElement()
                .accessibilityIdentifier(id)
        }
    }
}
