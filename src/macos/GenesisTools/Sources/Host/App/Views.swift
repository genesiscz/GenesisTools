import SwiftUI

struct PermissionsView: View {
    @ObservedObject var model: PermissionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Everything `tools` runs is attributed to this app, so one grant per row serves every terminal and launchd job. Requests made here show the same prompt the CLI would.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Refresh") { model.refresh() }
            }

            Table(model.rows) {
                TableColumn("Permission") { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).fontWeight(.medium)
                        Text(row.usedBy).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .width(min: 260)
                TableColumn("Status") { row in
                    HStack(spacing: 6) {
                        Circle().fill(Color(nsColor: row.state.color)).frame(width: 9, height: 9)
                        Text(row.state.label)
                    }
                }
                .width(min: 150)
                TableColumn("") { row in
                    HStack {
                        actionButton(row)
                        // A row whose action already opens System Settings needs no second button for it.
                        if !(row.action.opensSettings && row.state != .granted) {
                            Button("Settings…") { model.openPane(row.pane) }
                                .help("Opens this permission's list in System Settings.")
                        }
                    }
                }
                .width(min: 220)
            }

            Text("Full Disk Access and Accessibility are turned on in System Settings, not in a prompt: open the list, then drag \(appName) into it.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                if let busy = model.busyTitle {
                    ProgressView().controlSize(.small)
                    Text("Asking macOS for \(busy)…").font(.caption)
                }
                if let message = model.lastMessage {
                    Text(message).font(.caption).foregroundStyle(.orange)
                }
                Spacer()
                Button("Reveal app in Finder") { model.revealApp() }
                    .help("Shows \(appName) in Finder, ready to drag into a System Settings list.")
            }
        }
    }

    private var appName: String { PermissionKind.appName }

    @ViewBuilder
    private func actionButton(_ row: PermissionRow) -> some View {
        switch row.action {
        case .prompt:
            Button(row.state == .granted ? "Granted" : "Ask macOS") { model.request(row) }
                .disabled(row.state == .granted || model.busy != nil)
                .help("Shows the macOS prompt for this permission.")
        case .openPane(let pane):
            Button(row.state == .granted ? "Granted" : "Open System Settings") {
                model.openPane(pane)
                model.revealApp()
            }
            .disabled(row.state == .granted)
            .help("Opens this list in System Settings and shows \(appName) in Finder, ready to drag into it.")
        case .probe:
            Button(row.state == .granted ? "Granted" : "Ask macOS") { model.request(row) }
                .disabled(row.state == .granted || model.busy != nil)
                .help("Uses it once, so macOS shows its prompt.")
        }
    }
}

struct ServicesView: View {
    @ObservedObject var model: ServicesModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("launchd jobs installed by tools (com.genesis-tools.*). A job written before this app existed keeps its bare command and the terminal-less grants; reinstall it with its own tool (for example `tools dev-dashboard ui up`) to route it through the launcher.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Refresh") { model.refresh() }
            }

            if model.jobs.isEmpty {
                Text("No com.genesis-tools.* jobs in ~/Library/LaunchAgents.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Table(model.jobs) {
                    TableColumn("Label") { job in Text(job.id) }
                        .width(min: 220)
                    TableColumn("Runs under app") { job in
                        HStack(spacing: 6) {
                            Circle().fill(job.underApp ? Color.green : Color.orange).frame(width: 9, height: 9)
                            Text(job.underApp ? "yes" : "no (reinstall)")
                        }
                    }
                    .width(min: 130)
                    TableColumn("Loaded") { job in Text(job.loaded ? "yes" : "no") }
                        .width(min: 60)
                    TableColumn("Program") { job in
                        Text(job.program).font(.caption).lineLimit(1).truncationMode(.middle)
                    }
                    TableColumn("") { job in Button("Reveal plist") { model.reveal(job) } }
                        .width(min: 100)
                }
            }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel
    @AppStorage(AppMainWindow.key) private var mainWindow = AppMainWindow.permissions
    @AppStorage(PermissionSettingsGuide.enabledKey) private var settingsGuide = true
    @AppStorage(ApprovalAttention.soundKey) private var approvalSound = ApprovalAttention.defaultSound
    @AppStorage(ApprovalAttention.notifyAfterKey) private var approvalNotifyAfter = ApprovalAttention.defaultNotifyAfter

    var body: some View {
        Form {
            Section("Main window") {
                Picker("Opening GenesisTools shows", selection: $mainWindow) {
                    ForEach(AppMainWindow.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                Text("A Dock click, a Finder double-click or `open -a GenesisTools`. This window stays one click away: the hub's lock button, ⌘, in the hub, or `tools macos permissions ui`.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Privacy panes") {
                Toggle("Show a drag helper over System Settings", isOn: $settingsGuide)
                Text("When GenesisTools opens a Privacy pane, its icon floats at the bottom of the list. Drag it into Accessibility, Input Monitoring, Screen Recording or Full Disk Access; other lists only need its switch turned on.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Approval requests") {
                HStack {
                    Picker("Sound when a request appears", selection: $approvalSound) {
                        Text("None").tag("none")
                        ForEach(ApprovalAttention.sounds, id: \.self) { name in
                            Text(name).tag(name)
                        }
                    }
                    Button("Play") { ApprovalAttention.play(approvalSound) }
                        .disabled(approvalSound == "none")
                }
                Picker("Notification while it waits", selection: $approvalNotifyAfter) {
                    ForEach(ApprovalAttention.notifyAfterChoices) { choice in
                        Text(choice.title).tag(choice.seconds)
                    }
                }
                Text("A program that asks for the vault key or an AI account opens a request window. The window never takes the keyboard by itself, so this sound and notification tell you it is waiting.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Launcher") {
                Toggle("Route `tools` through this app (owns the privacy grants)", isOn: $model.launcherEnabled)
                Text(model.launcherEnabled
                     ? "On. Every tool runs as GenesisTools; grants live on this bundle."
                     : "Off. Tools run under the terminal that starts them and use its grants. Marker: \(SettingsModel.disabledMarker)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let error = model.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }

            Section("This bundle") {
                LabeledContent("Version", value: "\(model.version) (build \(model.build))")
                LabeledContent("Bundle id", value: model.bundleId)
                LabeledContent("Path", value: model.bundlePath)
                LabeledContent("Signed by", value: model.teamId.isEmpty ? model.signature : "\(model.signature) [\(model.teamId)]")
                HStack {
                    Button("Reveal in Finder") { model.revealApp() }
                    Button("Open ~/.genesis-tools/app") { model.openAppDir() }
                    Button("Privacy & Security…") { model.openPrivacySettings() }
                }
            }

            Section("Build manifest") {
                Text(model.manifest)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }

            Section("Command line") {
                Text("tools macos permissions            status, exit 1 while something is missing\ntools macos permissions build      rebuild and re-sign this app\ntools macos permissions ui         open this window\ntools macos calendar doctor        calendar-specific diagnosis")
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
    }
}
