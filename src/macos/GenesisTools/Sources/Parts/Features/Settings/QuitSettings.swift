import Foundation
import GenesisKit
import SwiftUI

/// General → Quitting: what ⌘Q does in the widget and in Clicky while other GenesisTools parts run beside them
/// (Host/PartQuit). The quit question's "Don't ask again" writes the same key, so the card follows it.
struct QuitSettingsCard: View {
    @StateObject private var model: QuitSettingsModel

    init(defaults: UserDefaults) {
        _model = StateObject(wrappedValue: QuitSettingsModel(defaults: defaults))
    }

    static let options: [NativeSettingsOption<QuitBehavior>] = [
        NativeSettingsOption(
            .ask, "Ask",
            detail: "Asks whether to quit only that part or every GenesisTools part that is running.",
            symbol: "questionmark.circle"),
        NativeSettingsOption(
            .thisPart, "Quit only this part",
            detail: "Quits only the part you are in. The other parts keep running.", symbol: "square"),
        NativeSettingsOption(
            .allParts, "Quit all parts",
            detail: "Quits every GenesisTools part that is running, such as the widget, Clicky and the hub.",
            symbol: "square.stack"),
    ]

    var body: some View {
        NativeSettingsCard("Quitting", subtitle: "Applies in the widget and in Clicky.") {
            NativeSettingsPicker(
                "When I press ⌘Q", detail: "With no other part running, ⌘Q always quits at once.",
                identifier: "settings.general.quitBehavior", options: Self.options, selection: $model.behavior)
        }
    }
}

/// The stored choice, read again when another face writes it (the quit question's "Don't ask again").
@MainActor
final class QuitSettingsModel: ObservableObject {
    @Published var behavior: QuitBehavior {
        didSet {
            guard behavior != oldValue, !reloading else { return }
            QuitBehavior.store(behavior, in: defaults)
        }
    }
    private let defaults: UserDefaults
    private var reloading = false
    private var observer: NSObjectProtocol?

    init(defaults: UserDefaults) {
        self.defaults = defaults
        behavior = QuitBehavior.stored(in: defaults)
        observer = DistributedNotificationCenter.default().addObserver(
            forName: QuitBehavior.changedNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
    }

    deinit {
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
    }

    private func reload() {
        let stored = QuitBehavior.stored(in: defaults)
        guard stored != behavior else { return }
        reloading = true
        behavior = stored
        reloading = false
    }
}
