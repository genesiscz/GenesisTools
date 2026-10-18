import Foundation

/// The environment every child of an app face inherits. A face started by Launch Services (a Dock or
/// Finder click, `open`, a notification, `tools hub` through `open`) gets launchd's bare environment:
/// PATH `/usr/bin:/bin:/usr/sbin:/sbin` and none of the login shell's exports. Its `tools` children
/// then failed the same way on every call site: `Executable not found in $PATH: "glab"` (code 127) for
/// every GitLab project in the PRs tab, and `unable to get local issuer certificate` for the PR
/// threads, because `NODE_EXTRA_CA_CERTS` lives in `~/.zshrc` (2026-09-30). Setting them once on this
/// process, before any child exists, covers every `Process` and `posix_spawn` call site.
///
/// The login shell's values come from `$SHELL -ilc env` (about 0.3 s), cached in
/// `~/.genesis-tools/app/login-env.json`: a face reads the cache at launch and the hub refreshes it in
/// the background for the next one. Without a cache the window faces capture once, synchronously.
enum ChildEnvironment {
    /// The login shell's variables a child needs and launchd does not give.
    static let capturedKeys = ["PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]
    private static let marker = "__GENESIS_TOOLS_LOGIN_ENV__"

    /// Where a login shell on this Mac usually finds the command-line tools: the floor when no login
    /// shell could be read.
    static func userDirectories(home: String) -> [String] {
        [
            "\(home)/.local/bin",
            "\(home)/.bun/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
        ]
    }

    /// The PATH launchd gives a face started by Launch Services.
    static let launchdPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

    /// `base` in its own order, then every directory of `adding` it lacks, in order. Nothing moves
    /// ahead of the base, so its choice of which `git` or `node` runs first stays the same.
    static func path(_ base: [String], adding directories: [String]) -> String {
        var result: [String] = []
        for directory in base + directories where !directory.isEmpty && !result.contains(directory) {
            result.append(directory)
        }
        return result.joined(separator: ":")
    }

    /// The variables to set: PATH merged, every other captured key only where this process has none.
    /// A face Launch Services started (launchd's PATH, or none) takes the login shell's PATH in its
    /// order; a face started from a terminal keeps that terminal's PATH in its order. Either way the
    /// usual directories that are missing come last.
    static func updates(current: [String: String], login: [String: String], home: String, exists: (String) -> Bool) -> [String: String] {
        var result: [String: String] = [:]
        let split: (String?) -> [String] = { ($0 ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty } }
        let currentPath = split(current["PATH"])
        let loginPath = split(login["PATH"])
        let fallback = userDirectories(home: home).filter(exists)
        let merged = currentPath.isEmpty || currentPath == launchdPath
            ? path(loginPath.isEmpty ? launchdPath : loginPath, adding: launchdPath + fallback)
            : path(currentPath, adding: loginPath.filter(exists) + fallback)
        if merged != current["PATH"] {
            result["PATH"] = merged
        }
        for key in capturedKeys where key != "PATH" {
            if let value = login[key], !value.isEmpty, (current[key] ?? "").isEmpty {
                result[key] = value
            }
        }
        return result
    }

    /// The captured keys from `env` output after the marker line.
    static func parse(_ output: String) -> [String: String] {
        guard let range = output.range(of: marker + "\n") else { return [:] }
        var result: [String: String] = [:]
        for line in output[range.upperBound...].split(separator: "\n") {
            guard let equals = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<equals])
            if capturedKeys.contains(key) {
                result[key] = String(line[line.index(after: equals)...])
            }
        }
        return result
    }

    /// Call once at launch, before any thread or child starts: `setenv` is not safe beside a spawn.
    /// `loginShell` reads the login shell's values (the cache, or a capture when there is none);
    /// `refresh` also recaptures in the background for the next launch (the hub, which lives long).
    static func install(loginShell: Bool, refresh: Bool) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var login = loginShell ? readCache() : nil
        let hadCache = login != nil
        if loginShell, login == nil {
            login = capture()
            if let login { writeCache(login) }
        }
        let current = ProcessInfo.processInfo.environment
        for (key, value) in updates(current: current, login: login ?? [:], home: home, exists: { FileManager.default.fileExists(atPath: $0) }) {
            setenv(key, value, 1)
        }
        if refresh, hadCache {
            DispatchQueue.global(qos: .utility).async {
                if let fresh = capture() { writeCache(fresh) }
            }
        }
    }

    private static var cacheURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/app/login-env.json")
    }

    private static func readCache() -> [String: String]? {
        guard let data = try? Data(contentsOf: cacheURL) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: data)
    }

    private static func writeCache(_ values: [String: String]) {
        do {
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(values).write(to: cacheURL, options: .atomic)
        } catch {
            FileHandle.standardError.write(Data("login env: cache not written: \(error)\n".utf8))
        }
    }

    /// The login shell's values, or nil when it failed or took longer than 5 s.
    private static func capture() -> [String: String]? {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.hasSuffix("zsh") || $0.hasSuffix("bash") ? $0 : nil } ?? "/bin/zsh"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-ilc", "echo \(marker); /usr/bin/env"]
        process.standardInput = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = "dumb"
        process.environment = environment
        do {
            let result = try process.runCapturing(timeout: 5)
            let values = parse(String(decoding: result.stdout, as: UTF8.self))
            return values["PATH"] == nil ? nil : values
        } catch {
            FileHandle.standardError.write(Data("login env: \(shell) -ilc failed: \(error)\n".utf8))
            return nil
        }
    }
}
