import AppKit
import SwiftUI

public struct NativeSettingsDisclosure<Content: View>: View {
    private let title: String
    private let identifier: String
    private let content: Content
    @State private var expanded = false
    @Environment(\.nativeSettingsReduceMotion) private var reduceMotion

    public init(_ title: String, identifier: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.identifier = identifier
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
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
            .buttonStyle(.plain)
            .accessibilityIdentifier(identifier)
            .accessibilityLabel(title)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded { content.padding(.top, 8) }
        }
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
                    Picker("\(title) hour", selection: hour) {
                        ForEach(0..<24) { Text(String(format: "%02d", $0)).tag($0) }
                    }.accessibilityIdentifier(identifier + ".hour")
                    Text(":").foregroundStyle(.secondary)
                    Picker("\(title) minute", selection: minute) {
                        ForEach(0..<60) { Text(String(format: "%02d", $0)).tag($0) }
                    }.accessibilityIdentifier(identifier + ".minute")
                }
                .labelsHidden().pickerStyle(.menu).menuStyle(.borderlessButton)
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
