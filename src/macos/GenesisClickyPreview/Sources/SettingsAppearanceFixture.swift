import Combine
import Foundation
import GenesisKit

@MainActor
enum SettingsAppearanceFixture {
    private struct Receipt: Encodable {
        let status: String
        let pid: Int32
        let theme: String
        let reduceMotion: Bool
        let reduceTransparency: Bool
    }

    static func runIfRequested(_ arguments: [String]) -> Bool {
        guard let index = arguments.firstIndex(of: "--appearance-fixture") else { return false }
        guard arguments.indices.contains(index + 1),
              let suiteIndex = arguments.firstIndex(of: "--suite"), arguments.indices.contains(suiteIndex + 1),
              arguments[suiteIndex + 1].hasPrefix("dev.genesis.settings.fixture.") else {
            fputs("Appearance fixtures require --suite dev.genesis.settings.fixture.<unique-id>\n", stderr)
            exit(2)
        }
        let mode = arguments[index + 1]
        let suite = arguments[suiteIndex + 1]
        guard let defaults = UserDefaults(suiteName: suite) else {
            fputs("Could not open the fixture defaults suite\n", stderr)
            exit(2)
        }
        if mode == "clear" {
            defaults.removePersistentDomain(forName: suite)
            defaults.synchronize()
            return true
        }
        let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: suite,
                                                   observeExternalChanges: mode == "watch")
        if mode == "write" {
            appearance.theme = .gradient
            appearance.reduceMotion = true
            appearance.reduceTransparency = false
            emit("written", appearance: appearance)
            return true
        }
        guard mode == "watch" else {
            fputs("Appearance fixture mode must be write, watch or clear\n", stderr)
            exit(2)
        }
        var received = false
        let subscription = appearance.objectWillChange.sink {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard !received, appearance.theme == .gradient, appearance.reduceMotion,
                          !appearance.reduceTransparency else { return }
                    received = true
                    CFRunLoopStop(CFRunLoopGetMain())
                }
            }
        }
        emit("ready", appearance: appearance)
        CFRunLoopRunInMode(.defaultMode, 5, false)
        emit(received ? "received" : "timeout", appearance: appearance)
        withExtendedLifetime(subscription) {}
        if !received { exit(1) }
        return true
    }

    private static func emit(_ status: String, appearance: NativeSettingsAppearance) {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            var data = try encoder.encode(Receipt(status: status, pid: ProcessInfo.processInfo.processIdentifier,
                                                  theme: appearance.theme.rawValue,
                                                  reduceMotion: appearance.reduceMotion,
                                                  reduceTransparency: appearance.reduceTransparency))
            data.append(10)
            FileHandle.standardOutput.write(data)
        } catch {
            fputs("Could not encode appearance fixture receipt: \(error)\n", stderr)
            exit(1)
        }
    }
}
