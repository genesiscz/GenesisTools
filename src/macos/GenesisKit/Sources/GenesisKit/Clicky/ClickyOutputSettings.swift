import SwiftUI

/// Clicky's "Output" card: the device it plays on, the rules per system output, and the late-output prompt.
struct ClickyOutputCard: View {
    @ObservedObject var model: ClickyModel

    var body: some View {
        NativeSettingsCard("Output", subtitle: nowPlaying) {
            NativeSettingsPicker(
                "Play Clicky on", detail: model.output?.reason, identifier: "clicky.output.device",
                options: deviceOptions, selection: deviceSelection, width: 260)
            if model.preferences.outputDeviceUID == nil {
                Divider()
                rules
            }
            Divider()
            NativeSettingsToggle(
                "Suggest a faster output",
                detail: "When Clicky's output is late by more than the limit below, a small prompt offers a faster one. It never takes the keyboard.",
                identifier: "clicky.output.delayWarning", isOn: $model.preferences.delayWarning)
            if model.preferences.delayWarning {
                NativeSettingsSegmented(
                    "Late after", detail: "AirPlay speakers such as a HomePod are about 2 s late; built-in speakers about 30 ms.",
                    identifier: "clicky.output.delayLimit",
                    options: [100, 150, 300, 500].map { NativeSettingsOption($0, "\($0) ms") },
                    selection: $model.preferences.delayWarningMilliseconds)
            }
            if !model.preferences.delayAcceptedUIDs.isEmpty {
                NativeSettingsRow("Kept although late", detail: keptNames) {
                    Button("Ask again", action: model.askAgainAboutLateOutputs)
                        .accessibilityIdentifier("clicky.output.askAgain")
                }
            }
        }
    }

    private var nowPlaying: String? {
        guard let effective = model.output?.effective else { return nil }
        return "Now playing on \(effective.name), \(effective.delayText)."
    }

    private var deviceOptions: [NativeSettingsOption<String>] {
        var options = [NativeSettingsOption("", "Same as the system output", detail: nil, symbol: "speaker.wave.2")]
        options += model.outputs.filter { !$0.isVirtual || $0.uid == model.preferences.outputDeviceUID }.map {
            NativeSettingsOption($0.uid, "\($0.name) (\($0.delayText))")
        }
        if let uid = model.preferences.outputDeviceUID, !model.outputs.contains(where: { $0.uid == uid }) {
            options.append(NativeSettingsOption(uid, "\(model.preferences.outputDeviceName ?? "Output") (not connected)"))
        }
        return options
    }

    private var deviceSelection: Binding<String> {
        Binding(
            get: { model.preferences.outputDeviceUID ?? "" },
            set: { uid in
                if uid.isEmpty {
                    model.pickOutput(nil)
                } else if let device = model.outputs.first(where: { $0.uid == uid }) {
                    model.pickOutput(device)
                }
            })
    }

    private var keptNames: String {
        model.preferences.delayAcceptedUIDs.map { uid in model.outputs.first { $0.uid == uid }?.name ?? "A disconnected output" }
            .joined(separator: ", ")
    }

    @ViewBuilder private var rules: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Rules").font(.system(size: 12, weight: .semibold))
            Text("While the system plays on one output, Clicky can play on another one.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            ForEach(model.preferences.outputRules) { rule in
                ClickyOutputRuleRow(model: model, rule: rule)
            }
            if let system = model.output?.system, !model.preferences.outputRules.contains(where: { $0.whenUID == system.uid }) {
                Button("Add a rule for \(system.name)") {
                    let target = AudioOutputs.suggestion(instead: system, outputs: model.outputs, limit: .infinity)
                    model.setRule(when: system, playOn: target ?? system)
                }
                .accessibilityIdentifier("clicky.output.addRule")
            }
        }
    }
}

private struct ClickyOutputRuleRow: View {
    @ObservedObject var model: ClickyModel
    let rule: ClickyOutputRule

    var body: some View {
        HStack(spacing: 8) {
            Text("When the system plays on \(rule.whenName), play on").font(.system(size: 12))
            Picker("Play on", selection: target) {
                ForEach(model.outputs.filter { !$0.isVirtual }) { device in
                    Text("\(device.name) (\(device.delayText))").tag(device.uid)
                }
                if !model.outputs.contains(where: { $0.uid == rule.playOnUID }) {
                    Text("\(rule.playOnName) (not connected)").tag(rule.playOnUID)
                }
            }
            .labelsHidden().fixedSize()
            Spacer(minLength: 0)
            IconButton(systemName: "trash", tooltip: "Remove this rule") { model.removeRule(rule.id) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("clicky.output.rule.\(rule.whenUID)")
    }

    private var target: Binding<String> {
        Binding(
            get: { rule.playOnUID },
            set: { uid in
                guard let device = model.outputs.first(where: { $0.uid == uid }) else { return }
                let system = AudioOutputDevice(id: 0, uid: rule.whenUID, name: rule.whenName, transport: 0, delay: 0)
                model.setRule(when: system, playOn: device)
            })
    }
}
