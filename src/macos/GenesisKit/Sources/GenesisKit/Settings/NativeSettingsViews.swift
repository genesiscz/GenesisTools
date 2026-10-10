import SwiftUI

public struct NativeSettingsCard<Content: View>: View {
    private let title: String?
    private let subtitle: String?
    private let content: Content

    public init(_ title: String? = nil, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let title {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    if let subtitle { Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary) }
                }
            }
            content
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .nativeGlassSurface()
    }
}

public struct NativeSettingsRow<Accessory: View>: View {
    private let title: String
    private let detail: String?
    private let accessory: Accessory

    public init(_ title: String, detail: String? = nil, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.detail = detail
        self.accessory = accessory()
    }

    public var body: some View {
        HStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 13, weight: .medium))
                if let detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            accessory
        }
    }
}

public struct NativeSettingsToggle: View {
    private let title: String
    private let detail: String?
    private let identifier: String?
    @Binding private var value: Bool

    public init(_ title: String, detail: String? = nil, identifier: String? = nil, isOn: Binding<Bool>) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        _value = isOn
    }

    public var body: some View {
        NativeSettingsRow(title, detail: detail) {
            Toggle(title, isOn: $value).labelsHidden().toggleStyle(.switch).controlSize(.small)
                .accessibilityIdentifier(identifier ?? "settings.toggle.\(title)")
        }
    }
}

public struct NativeSettingsPageIcon: View {
    private let symbol: String
    private let tint: Color
    private let size: CGFloat

    public init(symbol: String, tint: Color, size: CGFloat = 28) {
        self.symbol = symbol
        self.tint = tint
        self.size = size
    }

    public var body: some View {
        Image(systemName: symbol).font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white).frame(width: size, height: size)
            .background(tint.gradient, in: RoundedRectangle(cornerRadius: size * 0.26))
            .overlay(RoundedRectangle(cornerRadius: size * 0.26).stroke(.white.opacity(0.16), lineWidth: 0.5))
            .accessibilityHidden(true)
    }
}

@MainActor
public struct FeatureSettingsView: View {
    @ObservedObject private var store: NativeSettingsStore
    @ObservedObject private var appearance: NativeSettingsAppearance
    @Environment(\.accessibilityReduceMotion) private var systemStill
    @Namespace private var navigation
    private let title: String

    public init(store: NativeSettingsStore, title: String = "Settings") {
        self.store = store
        self.appearance = store.appearance
        self.title = title
    }

    public var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(.white.opacity(0.075)).frame(width: 1)
            VStack(alignment: .leading, spacing: 0) {
                if let page = store.selectedPage {
                    HStack(spacing: 13) {
                        NativeSettingsPageIcon(symbol: page.symbol, tint: page.tint, size: 36)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(page.title).font(.system(size: 24, weight: .semibold))
                            if !page.subtitle.isEmpty {
                                Text(page.subtitle).font(.system(size: 12)).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }.padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 23)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            if let error = store.catalogError {
                                Label(error.description, systemImage: "exclamationmark.triangle")
                                    .font(.system(size: 12)).foregroundStyle(.orange)
                            }
                            page.content()
                        }.padding(.horizontal, 28).padding(.bottom, 28)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.id(page.id)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 34)).foregroundStyle(.secondary)
                        Text(store.catalogError?.description ?? "Choose a feature to see its settings.")
                            .font(.system(size: 14)).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .titlebarBackground(NativeSettingsBackdrop())
        .titlebarZone()
        .frame(minWidth: 860, minHeight: 650)
        .environmentObject(store)
        .environmentObject(appearance)
        .nativeSettingsAppearance(appearance)
        .preferredColorScheme(.dark)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "slider.horizontal.3").font(.system(size: 19, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
                Text(title).font(.system(size: 24, weight: .semibold, design: .rounded))
            }.padding(.horizontal, 24).padding(.top, 28).padding(.bottom, 16)
            // The list scrolls under the header with a visible scroller and room after the last row, so the last
            // page is never hidden behind a footer (it was: "Providers" sat half cut above one in a 760 pt window).
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(store.sections) { section in
                        VStack(alignment: .leading, spacing: 1) {
                            if !section.title.isEmpty {
                                Text(section.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(
                                    .secondary
                                )
                                .padding(.horizontal, 10).padding(.bottom, 4)
                            }
                            ForEach(section.pages) { page in navigationRow(page) }
                        }
                    }
                }.padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 16)
            }
            .scrollIndicators(.automatic)
        }.frame(width: 238)
            .titlebarBackground(Color.white.opacity(0.025))
    }

    private func navigationRow(_ page: NativeSettingsPage) -> some View {
        let selected = store.selectedPageID == page.id
        return Button {
            if systemStill || appearance.reduceMotion {
                store.select(pageID: page.id)
            } else {
                withAnimation(.easeInOut(duration: 0.18)) { _ = store.select(pageID: page.id) }
            }
        } label: {
            HStack(spacing: 10) {
                NativeSettingsPageIcon(symbol: page.symbol, tint: page.tint, size: 22)
                Text(page.title).font(.system(size: 13, weight: selected ? .semibold : .regular))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }.padding(.horizontal, 10).padding(.vertical, 5).contentShape(Rectangle())
        }.buttonStyle(.genHoverRow())
            .nativeSettingsPointer()
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.09))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.08), lineWidth: 0.5))
                        .matchedGeometryEffect(id: "settings.selection", in: navigation)
                }
            }
            .accessibilityIdentifier("settings.page.\(page.id)")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
