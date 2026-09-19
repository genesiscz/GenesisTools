import AppKit
import Foundation

func cmdInstalledApps() {
    let roots = ["/Applications", "/System/Applications", "/System/Library/CoreServices",
                 NSHomeDirectory() + "/Applications"]
    let running = NSWorkspace.shared.runningApplications
    var entries: [[String: Any]] = []
    var visited = Set<String>()
    var inspected = 0
    var truncated = false
    outer: for root in roots {
        guard let enumerator = FileManager.default.enumerator(at: URL(fileURLWithPath: root),
                includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
        for case let url as URL in enumerator {
            inspected += 1
            if inspected > 20000 { truncated = true; break outer }
            guard url.pathExtension.lowercased() == "app" else { continue }
            enumerator.skipDescendants()
            let resolved = url.resolvingSymlinksInPath().standardizedFileURL
            guard visited.insert(resolved.path).inserted, let bundle = Bundle(url: resolved),
                  let id = bundle.bundleIdentifier else { continue }
            let instances = running.filter { $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == resolved }
            entries.append(["id": id, "displayName": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName")
                as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent,
                "path": resolved.path, "isRunning": !instances.isEmpty,
                "pids": instances.map { $0.processIdentifier }])
        }
    }
    entries.sort { ($0["displayName"] as? String ?? "").localizedCaseInsensitiveCompare($1["displayName"] as? String ?? "") == .orderedAscending }
    jsonOutput(["ok": true, "apps": entries, "truncated": truncated, "roots": roots])
}

func cmdLaunchApp() {
    let id = argValue("--bundle-id")
    let path = argValue("--path")
    guard (id == nil) != (path == nil) else { errorExit("choose one exact --bundle-id or absolute .app --path") }
    let url: URL?
    if let path {
        guard path.hasPrefix("/"), path.lowercased().hasSuffix(".app") else { errorExit("--path must be an absolute .app path") }
        url = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    } else {
        url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id!)
    }
    guard let url, let bundle = Bundle(url: url), let bundleId = bundle.bundleIdentifier,
          id == nil || bundleId == id else { errorExit("exact installed application was not found") }
    let canonical = url.resolvingSymlinksInPath().standardizedFileURL
    let matches = NSWorkspace.shared.runningApplications.filter {
        $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == canonical
    }
    guard matches.count <= 1 else { errorExit("multiple instances of this exact app path are running; choose an observed PID instead") }
    func report(_ app: NSRunningApplication, existing: Bool) {
        guard app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == canonical,
              let launch = try? observedLaunch(app.processIdentifier), launch > 0 else {
            jsonOutput(["ok":false,"error":"launch returned a different or vanished app instance; inspect before retrying",
                        "dispatchState":"uncertain"])
            exit(1)
        }
        jsonOutput(["ok":true,"id":bundleId,"path":canonical.path,"pid":app.processIdentifier,
                    "processLaunch":launch,"frontmost":app.isActive,"alreadyRunning":existing,
                    "dispatchState":"dispatched"])
    }
    if let existing = matches.first {
        if !args.contains("--background") && !existing.activate(options: [.activateIgnoringOtherApps]) {
            jsonOutput(["ok":false,"error":"existing app activation was not accepted; inspect before retrying",
                        "dispatchState":"uncertain"])
            exit(1)
        }
        report(existing, existing:true)
        return
    }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = !args.contains("--background")
    config.createsNewApplicationInstance = true
    NSWorkspace.shared.openApplication(at: canonical, configuration: config) { app, error in
        guard let app else {
            jsonOutput(["ok": false, "error": error?.localizedDescription ?? "application did not launch",
                        "dispatchState": "uncertain"])
            exit(1)
        }
        report(app, existing:false)
        exit(0)
    }
    // The bounded main loop delivers AppKit's completion handler; a port prevents an empty-loop spin.
    let port = Port()
    RunLoop.main.add(port, forMode: .default)
    RunLoop.main.run(until: Date().addingTimeInterval(10))
    port.invalidate()
    jsonOutput(["ok": false, "error": "launch completion timed out; inspect running apps before retrying",
                "dispatchState": "uncertain"])
    exit(1)
}

func cmdQuitApp() {
    guard let rawPID = argValue("--pid"), let pid = Int32(rawPID),
          let rawLaunch = argValue("--launch"), let launch = Double(rawLaunch), launch.isFinite,
          let app = NSRunningApplication(processIdentifier: pid), let actualLaunch = try? observedLaunch(pid),
          actualLaunch == launch else { errorExit("observed app instance no longer exists; nothing was terminated") }
    let accepted = app.terminate()
    jsonOutput(["ok": accepted, "pid": pid, "requestAccepted": accepted, "terminated": app.isTerminated,
                "dispatchState": accepted ? "dispatched" : "not_started",
                "note": "normal quit request only; unsaved-document prompts may keep the app open"])
    if !accepted { exit(1) }
}
