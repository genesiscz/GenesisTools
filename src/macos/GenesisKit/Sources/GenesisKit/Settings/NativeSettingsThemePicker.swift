import SwiftUI

public struct NativeSettingsThemePicker: View {
    @Binding private var selection: NativeSettingsTheme
    public init(selection: Binding<NativeSettingsTheme>) { _selection = selection }
    public var body: some View {
        HStack(spacing: 14) {
            ForEach(NativeSettingsTheme.allCases) { theme in
                Button {
                    selection = theme
                } label: {
                    VStack(spacing: 10) {
                        ZStack {
                            switch theme {
                            case .glass:
                                LinearGradient(
                                    colors: [Color(white: 0.35), Color(white: 0.22)],
                                    startPoint: .topLeading, endPoint: .bottomTrailing)
                            case .solid: Color(white: 0.12)
                            case .gradient: NativeSettingsGradient()
                            }
                            HStack(spacing: 7) {
                                RoundedRectangle(cornerRadius: 4).fill(.white.opacity(0.08)).frame(width: 28)
                                VStack(spacing: 7) {
                                    RoundedRectangle(cornerRadius: 5).fill(.white.opacity(0.12))
                                    RoundedRectangle(cornerRadius: 5).fill(.white.opacity(0.08))
                                }
                            }.padding(12)
                        }.frame(height: 78).clipShape(RoundedRectangle(cornerRadius: 11))
                            .overlay(
                                RoundedRectangle(cornerRadius: 11)
                                    .stroke(
                                        selection == theme ? Color.accentColor : .white.opacity(0.12),
                                        lineWidth: selection == theme ? 2 : 1))
                        HStack(spacing: 6) {
                            Text(theme.title).font(.system(size: 12, weight: selection == theme ? .semibold : .regular))
                            if selection == theme {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                            }
                        }
                    }.frame(maxWidth: .infinity)
                }.buttonStyle(.genHoverPlain()).accessibilityLabel("Theme: \(theme.title)")
                    .accessibilityIdentifier("settings.theme.\(theme.id)")
                    .accessibilityAddTraits(selection == theme ? .isSelected : [])
            }
        }
    }
}
