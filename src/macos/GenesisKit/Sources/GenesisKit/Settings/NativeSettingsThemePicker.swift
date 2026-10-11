import SwiftUI

/// A row of picture choices: each option is a small window drawn over its own `background`, with its title and a
/// check mark under it (General → Theme, Hub → Window style).
public struct NativeSettingsTilePicker<Option: Identifiable & Hashable, Background: View>: View {
    @Binding private var selection: Option
    private let options: [Option]
    private let title: (Option) -> String
    private let accessibilityLabel: (Option) -> String
    private let identifier: (Option) -> String
    private let background: (Option) -> Background

    public init(
        selection: Binding<Option>, options: [Option], title: @escaping (Option) -> String,
        accessibilityLabel: @escaping (Option) -> String, identifier: @escaping (Option) -> String,
        @ViewBuilder background: @escaping (Option) -> Background
    ) {
        _selection = selection
        self.options = options
        self.title = title
        self.accessibilityLabel = accessibilityLabel
        self.identifier = identifier
        self.background = background
    }

    public var body: some View {
        HStack(spacing: 14) {
            ForEach(options) { option in
                Button {
                    selection = option
                } label: {
                    VStack(spacing: 10) {
                        ZStack {
                            background(option)
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
                                        selection == option ? Color.accentColor : .white.opacity(0.12),
                                        lineWidth: selection == option ? 2 : 1))
                        HStack(spacing: 6) {
                            Text(title(option)).font(.system(size: 12, weight: selection == option ? .semibold : .regular))
                            if selection == option {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                            }
                        }
                    }.frame(maxWidth: .infinity)
                }.buttonStyle(.genHoverPlain()).accessibilityLabel(accessibilityLabel(option))
                    .accessibilityIdentifier(identifier(option))
                    .accessibilityAddTraits(selection == option ? .isSelected : [])
            }
        }
    }
}

public struct NativeSettingsThemePicker: View {
    @Binding private var selection: NativeSettingsTheme
    public init(selection: Binding<NativeSettingsTheme>) { _selection = selection }
    public var body: some View {
        NativeSettingsTilePicker(
            selection: $selection, options: NativeSettingsTheme.allCases, title: \.title,
            accessibilityLabel: { "Theme: \($0.title)" }, identifier: { "settings.theme.\($0.id)" }
        ) { theme in
            Self.preview(theme)
        }
    }

    /// The background a theme's tile shows.
    @ViewBuilder
    public static func preview(_ theme: NativeSettingsTheme) -> some View {
        switch theme {
        case .glass:
            LinearGradient(
                colors: [Color(white: 0.35), Color(white: 0.22)],
                startPoint: .topLeading, endPoint: .bottomTrailing)
        case .solid: Color(white: 0.12)
        case .gradient: NativeSettingsGradient()
        }
    }
}
