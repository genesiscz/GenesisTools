import SwiftUI

/// The only way to put an icon-only button on screen: it always carries an instant tooltip, and the
/// tooltip is also the name VoiceOver and UI automation read.
public struct IconButton: View {
    let systemName: String
    let tooltip: String
    var size: CGFloat
    var tint: Color?
    var accent: Color?
    let action: () -> Void

    /// `tint` colours the glyph; `accent` the hover disc (the kit's amber by default).
    public init(systemName: String, tooltip: String, size: CGFloat = 12, tint: Color? = nil, accent: Color? = nil, action: @escaping () -> Void) {
        self.systemName = systemName
        self.tooltip = tooltip
        self.size = size
        self.tint = tint
        self.accent = accent
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size))
                .foregroundColor(tint)
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverIcon(accent: accent ?? KitTheme.accent))
        .instantTooltip(tooltip)
        .accessibilityLabel(Text(tooltip))
    }
}
