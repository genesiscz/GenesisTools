import AppKit
import GenesisKit
import SwiftUI

/// The recorder in the feature settings window (Parts/Features): every choice the recorder keeps in the app's
/// defaults, on two pages. The same keys stay editable where they were (the capture picker, the menu bar menu, the
/// editor's View menu and tabs); this window shows the stored values. Added by the executable
/// (Sources/GenesisTools/Parts.swift); it knows no other part and starts nothing in the window's process.
@MainActor
package final class RecorderSettingsPlugin: FeatureSettingsPlugin {
    static let recordingPageID = "recorder.recording"
    static let editorPageID = "recorder.editor"

    private var model: RecorderSettingsModel?

    package init() {}

    package func install(in host: FeatureSettingsPluginHost) {
        // A snapshot's defaults drop every write; it tells no running recorder anything either.
        let model = RecorderSettingsModel(defaults: host.defaults, broadcasts: host.mode != .snapshot)
        self.model = model
        host.register(section: RecorderSettingsPages.section(model: model))
    }

    package func settingsReopened() {
        model?.refresh()
    }
}

/// The recorder's stored choices as bindings over one defaults domain. A write tells the running recorder face (its
/// own process) to read its shortcuts, picker and camera bubble again; every other choice is read where it is used.
@MainActor
final class RecorderSettingsModel: ObservableObject {
    let defaults: UserDefaults
    private let broadcasts: Bool
    private var pendingBroadcast: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    init(defaults: UserDefaults, broadcasts: Bool) {
        self.defaults = defaults
        self.broadcasts = broadcasts
        // The picker, the menu bar menu and the editor write the same keys from the recorder's process: coming back
        // to this window shows what they stored.
        for name in [NSApplication.didBecomeActiveNotification, NSWindow.didBecomeKeyNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            })
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    func refresh() {
        objectWillChange.send()
    }

    // MARK: Bindings

    func bool(_ key: String, _ fallback: Bool) -> Binding<Bool> {
        Binding(get: { [defaults] in defaults.object(forKey: key) as? Bool ?? fallback },
                set: { [weak self] in self?.write($0, key) })
    }

    /// `allowed`: a stored value outside it reads as `fallback`, as the value's reader does.
    func int(_ key: String, _ fallback: Int, allowed: [Int]? = nil) -> Binding<Int> {
        Binding(get: { [defaults] in
            guard let value = defaults.object(forKey: key) as? Int, allowed?.contains(value) ?? true else { return fallback }
            return value
        }, set: { [weak self] in self?.write($0, key) })
    }

    func double(_ key: String, _ fallback: Double, allowed: [Double]? = nil) -> Binding<Double> {
        Binding(get: { [defaults] in
            guard let value = defaults.object(forKey: key) as? Double, allowed?.contains(value) ?? true else { return fallback }
            return value
        }, set: { [weak self] in self?.write($0, key) })
    }

    func choice<Value: RawRepresentable>(_ key: String, _ fallback: Value) -> Binding<Value> where Value.RawValue == String {
        Binding(get: { [defaults] in defaults.string(forKey: key).flatMap(Value.init(rawValue:)) ?? fallback },
                set: { [weak self] in self?.write($0.rawValue, key) })
    }

    /// One field of the capture picker's options, read and saved through `CaptureOptions` (its ranges and defaults).
    func capture<Value>(_ path: WritableKeyPath<CaptureOptions, Value>) -> Binding<Value> {
        Binding(get: { [defaults] in CaptureOptions.load(defaults)[keyPath: path] }, set: { [weak self] value in
            guard let self else { return }
            var options = CaptureOptions.load(defaults)
            options[keyPath: path] = value
            objectWillChange.send()
            options.save(defaults)
            changed()
        })
    }

    func shortcut(_ action: RecorderShortcutAction) -> RecorderShortcutBinding {
        RecorderShortcutBinding.load(action, defaults: defaults)
    }

    func setShortcut(_ action: RecorderShortcutAction, _ binding: RecorderShortcutBinding) {
        objectWillChange.send()
        binding.save(action, defaults: defaults)
        changed()
    }

    /// The shortcut field records a chord: the recorder lets go of that action's key meanwhile.
    func listening(_ action: RecorderShortcutAction?) {
        guard broadcasts else { return }
        RecorderPreferencesSync.postListening(action)
    }

    private func write(_ value: Any, _ key: String) {
        objectWillChange.send()
        defaults.set(value, forKey: key)
        changed()
    }

    /// One notice per burst of changes (a stepper held down writes many).
    private func changed() {
        guard broadcasts else { return }
        pendingBroadcast?.cancel()
        let work = DispatchWorkItem { RecorderPreferencesSync.postChanged() }
        pendingBroadcast = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
}
