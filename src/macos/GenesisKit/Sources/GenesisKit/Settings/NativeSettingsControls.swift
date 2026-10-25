import AppKit
import SwiftUI

/// Disclosures a settings run opens before it draws: `--expand <identifier>[,<identifier>…]` on the command line. A
/// `--snapshot` cannot click, so this is how a page's folded content is checked off screen.
public enum NativeSettingsLaunch {
    public static let expanded: Set<String> = {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--expand"), args.indices.contains(index + 1) else { return [] }
        return Set(args[index + 1].split(separator: ",").map { String($0) })
    }()
}

public struct NativeSettingsDisclosure<Content: View>: View {
    private let title: String
    private let identifier: String
    private let content: Content
    @State private var expanded: Bool
    /// The search keys of the rows inside, read from the folded copy, so a search jump to one of them opens this.
    @State private var keys: [String] = []
    @GenReduceMotion private var reduceMotion
    @Environment(\.nativeSettingsIndexing) private var indexing
    @Environment(\.nativeSettingsPageID) private var page
    @ObservedObject private var center = NativeSettingsHighlightCenter.shared

    public init(_ title: String, identifier: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.identifier = identifier
        self.content = content()
        _expanded = State(initialValue: NativeSettingsLaunch.expanded.contains(identifier))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                let opening = !expanded
                GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) { expanded = opening }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text(title).font(.system(size: 12, weight: .medium))
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverRow(cornerRadius: KitTheme.radiusSmall))
            .nativeSettingsPointer()
            .nativeSettingsDisabledLook()
            .accessibilityIdentifier(identifier)
            .accessibilityLabel(title)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded || indexing {
                content.padding(.top, 8).transition(.genReveal)
            } else {
                folded
            }
        }
        // The section closes over its content; a few points of slack keep a control's focus ring.
        .clipShape(Rectangle().inset(by: -3))
        .onChange(of: center.token) { _, _ in openForSearch() }
        .onChange(of: keys) { _, _ in openForSearch() }
    }

    /// The content while folded: drawn with no height and hidden, as the search indexer draws other pages, so the
    /// settings search still lists the rows inside.
    private var folded: some View {
        content
            .environment(\.nativeSettingsIndexing, true)
            .frame(height: 0)
            .clipped()
            .hidden()
            .disabled(true)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onPreferenceChange(NativeSettingsSearchKey.self) { entries in
                MainActor.assumeIsolated { keys = entries.map(\.key) }
            }
    }

    /// Opens the section when a fresh search jump names a row inside it.
    private func openForSearch() {
        guard !expanded, !indexing, let page, let anchor = center.anchor, let at = center.requestedAt,
              Date().timeIntervalSince(at) < 2,
              keys.contains(where: { NativeSettingsSearch.anchor(page: page, key: $0) == anchor }) else { return }
        expanded = true
    }
}

extension View {
    /// A settings control's disabled look: the whole control at 0.4, as the `.genHover*` button styles draw a disabled
    /// button. AppKit's own disabled switch and stepper differ too little from the enabled ones over the settings
    /// backdrop (Hub → Appearance → Glass in the Native style read as live). Put it on the control itself; `.disabled`
    /// from any container above reaches it through the environment.
    public func nativeSettingsDisabledLook() -> some View { modifier(NativeSettingsDisabledLook()) }

    /// The pointing-hand cursor over a clickable settings control, so a row, a recorder or a text-like button reads as
    /// clickable before it is pressed. The shared `pointerCursor()`, which also resets the cursor when the control
    /// disappears under the pointer. A disabled control keeps the arrow; apply `.disabled` after this modifier, since
    /// the environment reaches it only from outside.
    public func nativeSettingsPointer() -> some View { modifier(NativeSettingsPointer()) }
}

private struct NativeSettingsPointer: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View { content.pointerCursor(isEnabled) }
}

private struct NativeSettingsDisabledLook: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View { content.opacity(isEnabled ? 1 : 0.4) }
}

public struct NativeSettingsNumberPicker: View {
    private let title: String
    private let range: Range<Int>
    private let identifier: String
    @Binding private var value: Int
    @State private var entry = ""
    @FocusState private var editing: Bool

    public init(_ title: String, range: Range<Int>, identifier: String, value: Binding<Int>) {
        self.title = title
        self.range = range
        self.identifier = identifier
        _value = value
    }

    public var body: some View {
        if range.count > 60 {
            HStack(spacing: 6) {
                TextField(title, text: $entry)
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .font(.system(size: 16, weight: .medium, design: .rounded)).monospacedDigit()
                    .frame(width: 58)
                    .focused($editing)
                    .onSubmit { commitEntry() }
                    .onChange(of: editing) { _, focused in
                        if focused { entry = String(value) } else { commitEntry() }
                    }
                    .onChange(of: value) { _, updated in
                        entry = String(updated)
                    }
                    .onAppear { entry = String(value) }
                    .accessibilityLabel(title)
                    .accessibilityIdentifier(identifier)
                Stepper(title, value: $value, in: range.lowerBound...(range.upperBound - 1))
                    .labelsHidden().fixedSize()
                    .accessibilityIdentifier(identifier + ".stepper")
            }.fixedSize()
                .nativeSettingsDisabledLook()
        } else {
            menu.nativeSettingsDisabledLook()
        }
    }

    private func commitEntry() {
        value = min(range.upperBound - 1, max(range.lowerBound, Int(entry) ?? value))
        entry = String(value)
    }

    private var menu: some View {
        Menu {
            ForEach(Array(range), id: \.self) { option in
                Button { value = option } label: {
                    if option == value {
                        Label(String(format: "%02d", option), systemImage: "checkmark")
                    } else { Text(String(format: "%02d", option)) }
                }
            }
        } label: {
            Text(String(format: "%02d", value))
                .font(.system(size: 19, weight: .medium, design: .rounded)).monospacedDigit()
                .frame(width: 42, height: 34)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel(title).accessibilityValue(String(value)).accessibilityIdentifier(identifier)
    }
}

public struct NativeSettingsTimePicker: View {
    private let title: String
    private let identifier: String
    @Binding private var minutes: Int

    public init(_ title: String, identifier: String, minutes: Binding<Int>) {
        self.title = title
        self.identifier = identifier
        _minutes = minutes
    }

    private var hour: Binding<Int> {
        Binding(get: { min(1439, max(0, minutes)) / 60 }, set: { minutes = $0 * 60 + minutes % 60 })
    }
    private var minute: Binding<Int> {
        Binding(get: { min(1439, max(0, minutes)) % 60 }, set: { minutes = (minutes / 60) * 60 + $0 })
    }

    public var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "clock").font(.system(size: 17)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                HStack(spacing: 2) {
                    NativeSettingsNumberPicker("\(title) hour", range: 0..<24,
                        identifier: identifier + ".hour", value: hour)
                    Text(":").foregroundStyle(.secondary)
                    NativeSettingsNumberPicker("\(title) minute", range: 0..<60,
                        identifier: identifier + ".minute", value: minute)
                }
                .labelsHidden()
                .font(.system(size: 19, weight: .medium, design: .rounded)).monospacedDigit()
                .fixedSize()
            }
            Spacer(minLength: 0)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.08), lineWidth: 0.5))
    }
}

public struct NativeSettingsApplicationRow: View {
    private let bundleID: String
    private let remove: () -> Void
    @State private var name = "Loading application…"
    @State private var installed = true

    public init(bundleID: String, remove: @escaping () -> Void) {
        self.bundleID = bundleID
        self.remove = remove
    }

    public var body: some View {
        HStack(spacing: 12) {
            AppIcon(bundleId: bundleID, size: 32, cornerRadius: 7)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.system(size: 13, weight: .medium))
                if !installed {
                    Text("Application unavailable · \(bundleID)").font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            IconButton(systemName: "minus.circle", tooltip: "Remove \(name)", action: remove)
        }
        .padding(.vertical, 5)
        .task(id: bundleID) {
            AppIconService.shared.preload([bundleID], sizes: [32])
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
                name = FileManager.default.displayName(atPath: url.path)
                if name.hasSuffix(".app") { name.removeLast(4) }
                installed = true
            } else {
                name = "Unknown application"
                installed = false
            }
        }
    }
}
