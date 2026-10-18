import AppKit
import GenesisKit

/// The widget in the feature settings window (Parts/Features): the Widgets, Dictation and Focus sections, and the Flow
/// and Focus runtime they edit, which runs in that window's process. Added by the executable
/// (Sources/GenesisTools/Parts.swift); it knows no other part.
@MainActor
package final class WidgetSettingsPlugin: FeatureSettingsPlugin {
    private var model: WidgetModel?
    private var flowRuntime: FlowFocusRuntime?
    private var transforms: FlowTransformTools?
    private var runtimeStart: Task<Void, Never>?

    package init() {}

    package func install(in host: FeatureSettingsPluginHost) {
        let stateRoot = Bundle.main.object(forInfoDictionaryKey: "GenesisToolsWidgetStateRoot") as? String
        let runtime: FlowFocusRuntime
        do { runtime = try NativeFlowRuntime.resolve(stateRoot: stateRoot) }
        catch {
            NSLog("Feature runtime setup failed, no widget pages: %@", error.localizedDescription)
            return
        }
        flowRuntime = runtime
        let model = WidgetModel(binaryPath: ToolsBridge.defaultBinaryPath(), stateRoot: stateRoot)
        self.model = model
        let transforms = FlowTransformTools(bridge: model.bridge, configuration: runtime.configuration)
        self.transforms = transforms
        FlowFocusHost.shared.openSettings = { [weak host] in host?.showSettings(pageID: "focus.general") }
        FlowFocusHost.shared.runTransform = { [weak transforms] request in
            guard let transforms else { throw CancellationError() }
            return try await transforms.run(request)
        }
        // A snapshot only draws the pages. Headless Settings presses switches and reopens pages
        // (scripts/native/settings-v2.ts), so it joins the running owner as a settings-only client: its writes land
        // like the normal Settings' do, and it never owns, so it starts no capture, hotkeys or sounds.
        if host.mode == .headless { runtime.settingsOnly = true }
        if host.mode != .snapshot { runtimeStart = Task { await runtime.start() } }
        for section in WidgetFeatureSettings.sections(
            model: model, modules: WidgetModuleChoice.builtins, flowRuntime: runtime, transforms: transforms,
            openSession: { session in
                WidgetLaunch.start(["--widget", "--session-key", session.key])
            })
        {
            host.register(section: section)
        }
        // This window only edits the settings. Turning "Show the widget" on must also start the widget face that
        // owns the panels, once the switch is stored, so the face reads it as on.
        model.preferencesSaved = { patch in
            if patch["showWidget"] == .bool(true) { WidgetLaunch.ensureRunning() }
        }
        model.startSettings()
    }

    package var settingsReady: Bool { model?.settingsLoaded ?? true }

    package func settingsReopened() {
        model?.refreshSettings()
    }

    package func stop() async {
        runtimeStart?.cancel()
        await runtimeStart?.value
        model?.stop()
        await flowRuntime?.stop()
    }
}
