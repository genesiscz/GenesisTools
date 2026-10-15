import SwiftUI

/// A settings row that runs something: "Preview effect", "Benchmark engines", "Rescan now", "Reset history". The
/// title and detail on the left, one button on the right. While the async action runs, the button shows a small
/// spinner and its `progressTitle`, cannot be pressed again, and reads "In progress" to accessibility; when it
/// throws, the error's message stays under the row until the next run.
///
/// `confirmation` asks first, in a sheet with the button's title on the confirming button (red for `.destructive`).
///
/// A run belongs to the row's `identifier`, not to the view: leaving the page does not stop it, coming back shows it
/// still running (or its error), and a press while it runs does nothing, also from another copy of the row. So give
/// each action its own identifier.
public struct NativeSettingsActionRow: View {
    public enum Role: Sendable {
        /// A plain button, for a harmless action.
        case normal
        /// The accent fill, for the one action the page is about.
        case prominent
        /// Red, for an action that deletes or resets.
        case destructive
    }

    private let title: String
    private let detail: String?
    private let identifier: String
    private let buttonTitle: String
    private let symbol: String?
    private let role: Role
    private let progressTitle: String?
    private let confirmation: String?
    private let action: () async throws -> Void
    @ObservedObject private var runs = NativeSettingsActionRuns.shared
    @State private var asking = false
    @GenReduceMotion private var reduceMotion

    private var running: Bool { runs.isRunning(identifier) }
    private var failure: String? { runs.failure(identifier) }

    /// - Parameters:
    ///   - progressTitle: the button's title while the action runs ("Scanning…"); the button title otherwise.
    ///   - confirmation: when set, a sheet with this text asks before the action runs.
    public init(
        _ title: String, detail: String? = nil, identifier: String, buttonTitle: String, symbol: String? = nil,
        role: Role = .normal, progressTitle: String? = nil, confirmation: String? = nil,
        action: @escaping () async throws -> Void
    ) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        self.buttonTitle = buttonTitle
        self.symbol = symbol
        self.role = role
        self.progressTitle = progressTitle
        self.confirmation = confirmation
        self.action = action
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            NativeSettingsRow(title, detail: detail) {
                Button {
                    if confirmation != nil { asking = true } else { run() }
                } label: {
                    NativeSettingsActionLabel(
                        title: running ? (progressTitle ?? buttonTitle) : buttonTitle, symbol: symbol, role: role,
                        running: running)
                }
                .buttonStyle(.genHoverPlain(brighten: role == .prominent ? 0.08 : 0.14))
                .disabled(running)
                .accessibilityLabel(buttonTitle)
                .accessibilityValue(running ? "In progress" : "")
                .accessibilityIdentifier(identifier)
                .confirmationDialog(confirmation ?? title, isPresented: $asking, titleVisibility: .visible) {
                    Button(buttonTitle, role: role == .destructive ? .destructive : nil) { run() }
                        .accessibilityIdentifier(identifier + ".confirm")
                    Button("Cancel", role: .cancel) {}
                }
            }
            if let failure {
                Label {
                    Text(verbatim: failure).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.system(size: 11))
                .foregroundStyle(KitPalette.removed)
                .transition(.genReveal)
                .accessibilityIdentifier(identifier + ".error")
            }
        }
        .animation(GenMotion.animation(expanding: failure != nil, reduceMotion: reduceMotion), value: failure)
    }

    private func run() {
        runs.start(identifier, action: action)
    }
}

/// The action runs of every `NativeSettingsActionRow`, by identifier, outside any view, so a run outlives the page
/// that started it and cannot be started twice.
@MainActor
final class NativeSettingsActionRuns: ObservableObject {
    static let shared = NativeSettingsActionRuns()

    @Published private var running: Set<String> = []
    @Published private var failures: [String: String] = [:]

    func isRunning(_ id: String) -> Bool { running.contains(id) }
    func failure(_ id: String) -> String? { failures[id] }

    /// Starts `action` under `id`; false (and nothing starts) while a run of `id` is still going.
    @discardableResult
    func start(_ id: String, action: @escaping () async throws -> Void) -> Bool {
        guard !running.contains(id) else { return false }
        running.insert(id)
        if failures[id] != nil { failures[id] = nil }
        Task { @MainActor in
            do {
                try await action()
            } catch is CancellationError {
            } catch {
                failures[id] = error.localizedDescription
            }
            running.remove(id)
        }
        return true
    }
}

/// The drawn button of a `NativeSettingsActionRow`, one look per role.
struct NativeSettingsActionLabel: View {
    let title: String
    let symbol: String?
    let role: NativeSettingsActionRow.Role
    let running: Bool

    var body: some View {
        HStack(spacing: 6) {
            if running {
                ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 12, height: 12)
            } else if let symbol {
                Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
            }
            Text(verbatim: title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 12)
        .frame(minWidth: 96, minHeight: 28)
        .background(background, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(border, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .fixedSize()
    }

    private var foreground: Color {
        switch role {
        case .normal: return .primary
        case .prominent: return .white
        case .destructive: return KitPalette.removed
        }
    }

    private var background: AnyShapeStyle {
        switch role {
        case .normal: return AnyShapeStyle(Color.white.opacity(0.08))
        case .prominent: return AnyShapeStyle(Color.accentColor.gradient)
        case .destructive: return AnyShapeStyle(KitPalette.removed.opacity(0.14))
        }
    }

    private var border: Color {
        switch role {
        case .normal: return .white.opacity(0.10)
        case .prominent: return .white.opacity(0.20)
        case .destructive: return KitPalette.removed.opacity(0.35)
        }
    }
}
