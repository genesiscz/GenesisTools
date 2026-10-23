import Foundation
import GenesisKit

/// Why a disk command gave no model.
public enum ToolsDiskProviderError: Error, LocalizedError, Equatable, Sendable {
    /// The command exited non-zero. `stderr` is the tail of what it printed there, `[profile:` lines dropped.
    case exit(code: Int32, stderr: String)
    /// Stdout was not the JSON the model expects. `detail` names the key or type and quotes the output.
    case decode(command: String, detail: String)
    /// Refused before running: the command needs at least one path.
    case invalidArgument(String)

    public var errorDescription: String? {
        switch self {
        case .exit(let code, let stderr):
            let lastLines = stderr.split(whereSeparator: \.isNewline).suffix(3).joined(separator: "\n")
            let reason = MonitorJSON.preview(lastLines, limit: 300)
            return reason.isEmpty ? "tools exited with code \(code)" : "tools exited with code \(code): \(reason)"
        case .decode(let command, let detail):
            return "tools \(command) printed output that could not be read: \(detail)"
        case .invalidArgument(let reason):
            return reason
        }
    }
}

/// Flags of `tools du clonesize`. Every default is the CLI's own, so `DuClonesizeOptions()` adds nothing.
/// `--save` and `--diff` are left out: one writes a file, the other prints a different shape.
public struct DuClonesizeOptions: Equatable, Sendable {
    /// `--depth N`: the per-directory tree down to depth N, in `DuClonesizeResult.nodes`.
    public var depth: Int?
    /// `--freeable`: Σ per-file private bytes, in `privateSumBytes` (C engines only).
    public var freeable: Bool
    /// `--freeable-tree`: private bytes per tree node (implies depth 1).
    public var freeableTree: Bool
    /// `--min-bytes N`: skip files whose allocated size is below N.
    public var minBytes: Int64?
    /// `--threads N`. Nil uses every CPU.
    public var threads: Int?
    /// `--ignore-worktrees`: exclude nested git worktrees and `.worktrees/`.
    public var ignoreWorktrees: Bool
    /// `--changed-within <duration>`, such as `7d`, `24h` or `30m`.
    public var changedWithin: String?
    /// `--include-cloud`: also walk cloud-provider roots. Slow, and a placeholder can download.
    public var includeCloud: Bool
    /// False passes `--no-cache`: the extent cache is not read, but it is still written.
    public var readsCache: Bool
    /// `--engine`. Nil uses the CLI default, `c-ffi`.
    public var engine: DuScanEngine?

    public init(
        depth: Int? = nil,
        freeable: Bool = false,
        freeableTree: Bool = false,
        minBytes: Int64? = nil,
        threads: Int? = nil,
        ignoreWorktrees: Bool = false,
        changedWithin: String? = nil,
        includeCloud: Bool = false,
        readsCache: Bool = true,
        engine: DuScanEngine? = nil
    ) {
        self.depth = depth
        self.freeable = freeable
        self.freeableTree = freeableTree
        self.minBytes = minBytes
        self.threads = threads
        self.ignoreWorktrees = ignoreWorktrees
        self.changedWithin = changedWithin
        self.includeCloud = includeCloud
        self.readsCache = readsCache
        self.engine = engine
    }

    var arguments: [String] {
        var args: [String] = []
        if let depth { args += ["--depth", String(depth)] }
        if freeable { args.append("--freeable") }
        if freeableTree { args.append("--freeable-tree") }
        if let minBytes { args += ["--min-bytes", String(minBytes)] }
        if let threads { args += ["--threads", String(threads)] }
        if ignoreWorktrees { args.append("--ignore-worktrees") }
        if let changedWithin { args += ["--changed-within", changedWithin] }
        if includeCloud { args.append("--include-cloud") }
        if !readsCache { args.append("--no-cache") }
        if let engine { args += ["--engine", engine.rawValue] }
        return args
    }
}

/// What `tools macos clones reclaim plan` searches. Defaults are the CLI's, except `registersDaemon`.
public struct ClonesReclaimPlanOptions: Equatable, Sendable {
    /// Each one is a `--dir`. At least one is required.
    public var dirs: [String]
    /// `--worktrees-of <repo>`: also resolve this repository's git worktrees.
    public var worktreesOf: String?
    /// `--targets`: kinds (`gitignored`, `node_modules`, `vendor`, `Pods`, `.cxx`, `all`) or `find -name` patterns.
    /// `all` wins over the others: every file at or above `minReal` under each folder counts. Nil uses the CLI default,
    /// `gitignored`.
    public var targets: [String]?
    /// `--keep-partners`: package-manager stores never rewritten.
    public var keepPartners: [ClonesKeepPartnerID]
    /// `--rewrite-stores`: stores whose files may be rewritten onto an identical file of the same store.
    public var rewriteStores: [ClonesKeepPartnerID]
    /// `--keep-unfreeable`: keep sets that free nothing.
    public var keepUnfreeable: Bool
    /// Each one is an `--exclude` glob.
    public var exclude: [String]
    /// `--min-real <n>B`: the minimum per-file size in bytes (the CLI refuses a size without a unit). Nil uses the CLI
    /// default, 10 MB.
    public var minReal: Int64?
    /// True lets the plan register the daily scan with `tools daemon`, the CLI's default. False (the default
    /// here) passes `--no-daemon`, so a plan the app runs leaves only the run log and the 60 s plan snapshot.
    public var registersDaemon: Bool

    public init(
        dirs: [String],
        worktreesOf: String? = nil,
        targets: [String]? = nil,
        keepPartners: [ClonesKeepPartnerID] = [],
        rewriteStores: [ClonesKeepPartnerID] = [],
        keepUnfreeable: Bool = false,
        exclude: [String] = [],
        minReal: Int64? = nil,
        registersDaemon: Bool = false
    ) {
        self.dirs = dirs
        self.worktreesOf = worktreesOf
        self.targets = targets
        self.keepPartners = keepPartners
        self.rewriteStores = rewriteStores
        self.keepUnfreeable = keepUnfreeable
        self.exclude = exclude
        self.minReal = minReal
        self.registersDaemon = registersDaemon
    }

    var arguments: [String] {
        selectorArguments + (registersDaemon ? [] : ["--no-daemon"])
    }

    /// The selector flags alone, for `presets save` (which takes no `--no-daemon`).
    var selectorArguments: [String] {
        var args: [String] = []
        for dir in dirs { args += ["--dir", dir] }
        if let worktreesOf { args += ["--worktrees-of", worktreesOf] }
        if let targets, !targets.isEmpty { args += ["--targets", targets.joined(separator: ",")] }
        if !keepPartners.isEmpty { args += ["--keep-partners", keepPartners.map(\.rawValue).joined(separator: ",")] }
        if !rewriteStores.isEmpty { args += ["--rewrite-stores", rewriteStores.map(\.rawValue).joined(separator: ",")] }
        if keepUnfreeable { args.append("--keep-unfreeable") }
        for glob in exclude { args += ["--exclude", glob] }
        if let minReal { args += ["--min-real", ToolsDiskProvider.sizeArgument(minReal)] }
        return args
    }
}

/// Filters that `clones measure`, `clones duplicates` and `clones optimize` share. Defaults are the CLI's.
public struct ClonesScanFilters: Equatable, Sendable {
    /// `--min-real`: measure hides smaller subtrees, duplicates and optimize ignore smaller files. Nil is the CLI
    /// default (10 MB for measure and optimize, none for duplicates).
    public var minReal: Int64?
    /// `--node-modules`: expand each root to the node_modules folders under it.
    public var nodeModules: Bool
    /// Each one is an `--include` glob.
    public var include: [String]
    /// Each one is an `--exclude` glob. An exclude wins over an include.
    public var exclude: [String]

    public init(minReal: Int64? = nil, nodeModules: Bool = false, include: [String] = [], exclude: [String] = []) {
        self.minReal = minReal
        self.nodeModules = nodeModules
        self.include = include
        self.exclude = exclude
    }

    var arguments: [String] {
        var args: [String] = []
        if nodeModules { args.append("--node-modules") }
        if let minReal { args += ["--min-real", ToolsDiskProvider.sizeArgument(minReal)] }
        for glob in include { args += ["--include", glob] }
        for glob in exclude { args += ["--exclude", glob] }
        return args
    }
}

/// How `clones measure` orders its rows.
public enum ClonesMeasureSort: String, CaseIterable, Sendable {
    /// du ÷ real: the folders du overstates most.
    case overcount
    case real
    case du
}

/// What `tools macos clones measure` reports. Defaults are the CLI's.
public struct ClonesMeasureOptions: Equatable, Sendable {
    public var filters: ClonesScanFilters
    /// `--top <n>`: only the first n rows. Nil shows every row.
    public var top: Int?
    /// `--sort`. Nil is the CLI default, `overcount`.
    public var sort: ClonesMeasureSort?
    /// False passes `--no-breakdown`: totals and the clone analysis only.
    public var breakdown: Bool
    /// False passes `--no-unique`: skips the deduplicated on-disk figure, which costs a second walk.
    public var unique: Bool
    /// `--show-partners`: probe bun's install cache for cross-tree partner paths (seconds on a large cache).
    public var showPartners: Bool

    public init(filters: ClonesScanFilters = ClonesScanFilters(), top: Int? = nil, sort: ClonesMeasureSort? = nil,
                breakdown: Bool = true, unique: Bool = true, showPartners: Bool = false) {
        self.filters = filters
        self.top = top
        self.sort = sort
        self.breakdown = breakdown
        self.unique = unique
        self.showPartners = showPartners
    }

    var arguments: [String] {
        var args = filters.arguments
        if let top { args += ["--top", String(top)] }
        if let sort { args += ["--sort", sort.rawValue] }
        if !breakdown { args.append("--no-breakdown") }
        if !unique { args.append("--no-unique") }
        if showPartners { args.append("--show-partners") }
        return args
    }
}

/// What `tools macos clones duplicates` searches. JSON always returns every set, so there is no `--top` here.
public struct ClonesDuplicatesOptions: Equatable, Sendable {
    public var filters: ClonesScanFilters
    /// `--prefix-hash`: a 4 KB hash before the full one. Helps a cold scan of mixed files; may slow a warm one.
    public var prefixHash: Bool

    public init(filters: ClonesScanFilters = ClonesScanFilters(), prefixHash: Bool = false) {
        self.filters = filters
        self.prefixHash = prefixHash
    }

    var arguments: [String] {
        filters.arguments + (prefixHash ? ["--prefix-hash"] : [])
    }
}

/// What `tools macos clones optimize` clones: every duplicate file at or above the minimum under `roots`, or under
/// the trees found in `dirs` (and `worktreesOf`). Unlike reclaim, it needs no install trees.
public struct ClonesOptimizeOptions: Equatable, Sendable {
    /// Positional roots. With `dirs` or `worktreesOf`, the CLI searches them for trees too.
    public var roots: [String]
    /// Each one is a `--dir`: search this folder for install trees.
    public var dirs: [String]
    /// `--worktrees-of <repo>`.
    public var worktreesOf: String?
    /// `--targets`, as for reclaim. Used only with `dirs` or `worktreesOf`.
    public var targets: [String]?
    public var filters: ClonesScanFilters

    public init(roots: [String] = [], dirs: [String] = [], worktreesOf: String? = nil, targets: [String]? = nil,
                filters: ClonesScanFilters = ClonesScanFilters()) {
        self.roots = roots
        self.dirs = dirs
        self.worktreesOf = worktreesOf
        self.targets = targets
        self.filters = filters
    }

    var arguments: [String] {
        var args: [String] = []
        for dir in dirs { args += ["--dir", dir] }
        if let worktreesOf { args += ["--worktrees-of", worktreesOf] }
        if let targets, !targets.isEmpty { args += ["--targets", targets.joined(separator: ",")] }
        return args + filters.arguments
    }
}

/// Runs the `tools` disk commands and decodes their JSON into the `ToolsDiskModels`, `DuIndexModels` and
/// `ToolsDiskActions` types.
///
/// Every method waits for the process, throws `ToolsDiskProviderError.exit` on a non-zero exit, and decodes
/// off the main actor. A `ToolsBridgeError` (binary missing, timeout) passes through unchanged. The `du`, `clones`,
/// `doctor`, `hub worktrees` and `swap` reads delete, rewrite or apply nothing (scans may write their own caches
/// and run logs). `duIndexUpdate`, `duIndexSchedule(enable:)` and `doctorAct` change state, and a streamed
/// `du index build` is started by the caller from `duIndexBuildArguments`.
public struct ToolsDiskProvider: Sendable {
    public let bridge: ToolsBridge
    /// Per call. A whole-volume `du volume` takes minutes.
    public let timeoutSeconds: Int

    /// The timeout of a `doctor act` that changes the disk (not a dry run). Killing a deletion halfway leaves it
    /// without a result, so it gets longer than `timeoutSeconds`.
    public var actTimeoutSeconds = 3600

    public init(bridge: ToolsBridge, timeoutSeconds: Int = 600) {
        self.bridge = bridge
        self.timeoutSeconds = timeoutSeconds
    }

    // MARK: tools du

    /// `tools du volume [mount] --format json`. Nil `mount` is the CLI default, `/System/Volumes/Data`.
    public func duVolume(mount: String? = nil, depth: Int? = nil, includeCloud: Bool = false) async throws -> DuVolumeReport {
        var args = ["volume"]
        if let mount { args.append(Self.operand(mount)) }
        args += ["--format", "json"]
        if let depth { args += ["--depth", String(depth)] }
        if includeCloud { args.append("--include-cloud") }
        return try await fetch(DuVolumeReport.self, command: "du volume", subcommand: "du", args: args)
    }

    /// `tools du clonesize <path> --format json`.
    public func duClonesize(path: String, options: DuClonesizeOptions = DuClonesizeOptions()) async throws -> DuClonesizeResult {
        let args = ["clonesize", Self.operand(path), "--format", "json"] + options.arguments
        return try await fetch(DuClonesizeResult.self, command: "du clonesize", subcommand: "du", args: args)
    }

    /// `tools du partners <path> --format json`. `against` must contain `path`; nil is its parent.
    public func duPartners(path: String, against: String? = nil, top: Int? = nil) async throws -> DuPartnersResult {
        var args = ["partners", Self.operand(path), "--format", "json"]
        if let against { args += ["--against", against] }
        if let top { args += ["--top", String(top)] }
        return try await fetch(DuPartnersResult.self, command: "du partners", subcommand: "du", args: args)
    }

    // MARK: tools macos clones

    /// `tools macos clones measure <paths...> --format json`: clone-aware sizes per folder.
    public func clonesMeasure(paths: [String], options: ClonesMeasureOptions = ClonesMeasureOptions()) async throws
        -> ClonesMeasureReport {
        try Self.requirePaths(paths, command: "macos clones measure")
        let args = ["clones", "measure"] + paths.map(Self.operand) + ["--format", "json", "--silent"] + options.arguments
        return try await fetch(ClonesMeasureReport.self, command: "macos clones measure", subcommand: "macos", args: args)
    }

    /// `tools macos clones du <path> --format json`: one folder, measured deeply.
    public func clonesDu(path: String, depth: Int? = nil, minReal: Int64? = nil) async throws -> ClonesMeasureReport {
        var args = ["clones", "du", Self.operand(path), "--format", "json"]
        if let depth { args += ["--depth", String(depth)] }
        if let minReal { args += ["--min-real", Self.sizeArgument(minReal)] }
        return try await fetch(ClonesMeasureReport.self, command: "macos clones du", subcommand: "macos", args: args)
    }

    /// `tools macos clones duplicates <paths...> --format json`: content-identical files that are not clones yet.
    public func clonesDuplicates(paths: [String], options: ClonesDuplicatesOptions = ClonesDuplicatesOptions())
        async throws -> ClonesDuplicatesReport {
        try Self.requirePaths(paths, command: "macos clones duplicates")
        let args = ["clones", "duplicates"] + paths.map(Self.operand) + ["--format", "json", "--silent"]
            + options.arguments
        return try await fetch(ClonesDuplicatesReport.self, command: "macos clones duplicates", subcommand: "macos",
                               args: args)
    }

    /// `tools macos clones reclaim plan --format json`: what apply would rewrite. Planning rewrites nothing.
    public func clonesReclaimPlan(_ options: ClonesReclaimPlanOptions) async throws -> ClonesReclaimPlan {
        try Self.requirePaths(options.dirs, command: "macos clones reclaim plan")
        let args = ["clones", "reclaim", "plan", "--format", "json", "--silent"] + options.arguments
        return try await fetch(ClonesReclaimPlan.self, command: "macos clones reclaim plan", subcommand: "macos", args: args)
    }

    // MARK: tools doctor

    /// `tools doctor --json --dry-run`. JSON mode only collects findings and never runs a fix; `--dry-run`
    /// says so again. `only` picks analyzer ids (`disk-space`, `dev-caches`, `system-caches`, …); empty runs all.
    public func doctorReport(only: [String] = [], thorough: Bool = false, fresh: Bool = false) async throws -> DoctorReport {
        var args = ["--json", "--dry-run"]
        if !only.isEmpty { args += ["--only", only.joined(separator: ",")] }
        if thorough { args.append("--thorough") }
        if fresh { args.append("--fresh") }
        return try await fetch(DoctorReport.self, command: "doctor", subcommand: "doctor", args: args)
    }

    // MARK: tools hub worktrees

    /// `tools hub worktrees list [repos...] --json`. Empty `repos` is the CLI default: the repository of its
    /// working directory, which `ToolsBridge` sets to the GenesisTools checkout. An unresolvable `base` exits 1.
    public func hubWorktrees(
        repos: [String] = [],
        liveMinutes: Int? = nil,
        base: String? = nil,
        olderThanDays: Int? = nil
    ) async throws -> HubWorktreeReport {
        var args = ["worktrees", "list"] + repos + ["--json"]
        if let liveMinutes { args += ["--live-minutes", String(liveMinutes)] }
        if let base { args += ["--base", base] }
        if let olderThanDays { args += ["--older-than", String(olderThanDays)] }
        return try await fetch(HubWorktreeReport.self, command: "hub worktrees list", subcommand: "hub", args: args)
    }

    /// `tools hub worktrees size <paths...> --json`: one entry per path, in order. A missing folder is an
    /// entry with `error` set, not a throw.
    public func hubWorktreeSizes(paths: [String]) async throws -> [HubWorktreeSize] {
        try Self.requirePaths(paths, command: "hub worktrees size")
        let args = ["worktrees", "size"] + paths.map(Self.operand) + ["--json"]
        return try await fetch([HubWorktreeSize].self, command: "hub worktrees size", subcommand: "hub", args: args)
    }

    // MARK: tools macos swap

    /// `tools macos swap --json`. `limit` is how many top-RSS processes `vmmap` reads (CLI default 30);
    /// `all` reads every process at or above 25 MB RSS, which is slow.
    public func macosSwap(limit: Int? = nil, all: Bool = false) async throws -> SwapReport {
        var args = ["swap", "--json"]
        if let limit { args += ["--limit", String(limit)] }
        if all { args.append("--all") }
        return try await fetch(SwapReport.self, command: "macos swap", subcommand: "macos", args: args)
    }

    // MARK: Decoding

    /// Decodes a command's stdout. A preamble before the JSON (a banner, a warning, `[profile:` lines) is
    /// dropped, whether the JSON is an object or a top-level array. Throws `ToolsDiskProviderError.decode`.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data, command: String) throws -> T {
        try decode(type, from: data, command: command, snakeCaseKeys: false)
    }

    /// `decode` for the snake_case JSON of `tools du index`.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data, command: String,
                                            snakeCaseKeys: Bool) throws -> T {
        let payload: Data
        do {
            payload = try jsonPayload(data)
        } catch {
            let stdout = String(decoding: data, as: UTF8.self)
            throw ToolsDiskProviderError.decode(
                command: command,
                detail: MonitorJSON.failureDetail(error, stdout: stdout, stderr: "")
            )
        }
        do {
            let decoder = JSONDecoder()
            if snakeCaseKeys { decoder.keyDecodingStrategy = .convertFromSnakeCase }
            return try decoder.decode(T.self, from: payload)
        } catch {
            let stdout = String(decoding: payload, as: UTF8.self)
            throw ToolsDiskProviderError.decode(
                command: command,
                detail: MonitorJSON.failureDetail(error, stdout: stdout, stderr: "")
            )
        }
    }

    /// The last `limit` characters of stderr without `[profile:` timing lines: the error is usually last.
    static func stderrTail(_ stderr: String, limit: Int = 2_000) -> String {
        let lines = stderr.split(whereSeparator: \.isNewline).filter { !$0.hasPrefix("[profile:") }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count <= limit ? text : "…" + String(text.suffix(limit))
    }

    /// `MonitorJSON` finds a JSON object after a preamble. `hub worktrees size` prints a top-level array,
    /// so a `[` that starts a line is tried as well.
    static func jsonPayload(_ data: Data) throws -> Data {
        do {
            return try MonitorJSON.dataByDroppingPreamble(data)
        } catch {
            let text = String(decoding: data, as: UTF8.self)
            var searchFrom = text.startIndex
            var attempts = 0
            while attempts < 16, let index = text[searchFrom...].firstIndex(of: "[") {
                if index == text.startIndex || text[text.index(before: index)].isNewline {
                    attempts += 1
                    let candidate = Data(text[index...].utf8)
                    if (try? JSONSerialization.jsonObject(with: candidate)) != nil {
                        return candidate
                    }
                }
                searchFrom = text.index(after: index)
            }
            throw error
        }
    }

    /// A size flag's value in bytes with its unit: the CLI refuses a bare number.
    public static func sizeArgument(_ bytes: Int64) -> String {
        "\(bytes)B"
    }

    /// A path as a command-line operand: a relative path that starts with `-` gets `./`, so it never parses as a flag.
    static func operand(_ path: String) -> String {
        path.hasPrefix("-") ? "./" + path : path
    }

    /// An empty path string is no path: the CLI would resolve it to its own working folder and act on that.
    private static func requirePaths(_ paths: [String], command: String) throws {
        if paths.isEmpty {
            throw ToolsDiskProviderError.invalidArgument("tools \(command) needs at least one path")
        }
        if paths.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            throw ToolsDiskProviderError.invalidArgument("tools \(command) got an empty path")
        }
    }

    private func fetch<T: Decodable & Sendable>(
        _ type: T.Type,
        command: String,
        subcommand: String,
        args: [String]
    ) async throws -> T {
        let result = try await bridge.run(subcommand: subcommand, args: args, timeoutSeconds: timeoutSeconds)
        guard result.exitCode == 0 else {
            throw ToolsDiskProviderError.exit(code: result.exitCode, stderr: Self.stderrTail(result.stderr))
        }
        let stdout = Data(result.stdout.utf8)
        // Detached, so a large report never decodes on the caller's actor (the main actor for a view).
        return try await Task.detached(priority: .userInitiated) {
            try Self.decode(T.self, from: stdout, command: command)
        }.value
    }
}

// MARK: - tools du index, doctor act, clones apply

extension ToolsDiskProvider {
    /// `tools du index query --path <p> --format json`; nil `path` is the indexed root. A path inside a folded
    /// region answers `found: false` with `foldedIn` and a `clonesize` hint. Throws `DuIndexError` for the CLI's
    /// own error document (`locked`, `schema_newer`, …).
    public func duIndexQuery(path: String? = nil, children: Bool = true, sort: String? = nil, limit: Int? = nil,
                             minBytes: Int64? = nil, changedWithin: String? = nil, topFiles: Int? = nil,
                             db: String? = nil) async throws -> DuIndexQueryResult {
        var args = ["index", "query", "--format", "json"]
        if let path { args += ["--path", Self.operand(path)] }
        if !children { args.append("--no-children") }
        if let sort { args += ["--sort", sort] }
        if let limit { args += ["--limit", String(limit)] }
        if let minBytes { args += ["--min-bytes", String(minBytes)] }
        if let changedWithin { args += ["--changed-within", changedWithin] }
        if let topFiles { args += ["--top-files", String(topFiles)] }
        return try await fetchIndex(DuIndexQueryResult.self, args: args, db: db)
    }

    /// `tools du index query --largest dirs|files --format json`.
    public func duIndexLargest(files: Bool = false, limit: Int? = nil, db: String? = nil) async throws -> DuIndexLargestResult {
        var args = ["index", "query", "--largest", files ? "files" : "dirs", "--format", "json"]
        if let limit { args += ["--limit", String(limit)] }
        return try await fetchIndex(DuIndexLargestResult.self, args: args, db: db)
    }

    /// `tools du index query --info --format json`: meta, row counts, recent scans and the file size.
    public func duIndexInfo(db: String? = nil) async throws -> DuIndexInfo {
        try await fetchIndex(DuIndexInfo.self, args: ["index", "query", "--info", "--format", "json"], db: db)
    }

    /// `tools du index diff --format json`. `from` is a snapshot id, an ISO date or a duration back (`7d`).
    public func duIndexDiff(from: String? = nil, to: String? = nil, minDelta: Int64? = nil, limit: Int? = nil,
                            attributeAll: Bool = false, db: String? = nil) async throws -> DuIndexDiff {
        var args = ["index", "diff", "--format", "json"]
        if let from { args += ["--from", from] }
        if let to { args += ["--to", to] }
        if let minDelta { args += ["--min-delta", String(minDelta)] }
        if let limit { args += ["--limit", String(limit)] }
        if attributeAll { args += ["--attribute", "all"] }
        return try await fetchIndex(DuIndexDiff.self, args: args, db: db)
    }

    /// `tools du index update --paths <p>… --format json`: re-walks only the regions that own the paths. A running
    /// build makes it queue the paths (`deferred`). `shallow`: the paths are files, recheck their folders only;
    /// `recursive`: re-walk whole subtrees (after an FSEvents MustScanSubDirs).
    public func duIndexUpdate(paths: [String], shallow: Bool = false, recursive: Bool = false, fromQueue: Bool = false,
                              db: String? = nil) async throws -> DuIndexUpdateResult {
        guard !paths.isEmpty || fromQueue else {
            throw ToolsDiskProviderError.invalidArgument("tools du index update needs paths or --from-queue")
        }
        var args = ["index", "update", "--format", "json"]
        if !paths.isEmpty { args += ["--paths"] + paths.map(Self.operand) }
        if shallow { args.append("--shallow") }
        if recursive { args.append("--recursive") }
        if fromQueue { args.append("--from-queue") }
        return try await fetchIndex(DuIndexUpdateResult.self, args: args, db: db)
    }

    /// `tools du index schedule --status|--on|--off --format json`.
    public func duIndexSchedule(enable: Bool? = nil, db: String? = nil) async throws -> DuIndexSchedule {
        let flag = enable.map { $0 ? "--on" : "--off" } ?? "--status"
        return try await fetchIndex(DuIndexSchedule.self, args: ["index", "schedule", flag, "--format", "json"], db: db)
    }

    /// The argv after `du` for a build whose NDJSON lines go through `DuIndexEvent.parse`. `stopOnStdin` is for a
    /// `ToolsLineStream` pipe (the build stops when the stream closes); leave it off for a `DetachedToolsJob`,
    /// whose stdin is /dev/null and which stops with SIGTERM.
    public static func duIndexBuildArguments(root: String? = nil, threads: Int? = nil, measurePrivate: Bool = true,
                                             exclude: [String] = [], includeCloud: Bool = false,
                                             snapshot: Bool = true, reset: Bool = false, db: String? = nil,
                                             stopOnStdin: Bool = false) -> [String] {
        var args = ["index", "build", "--format", "ndjson"]
        if stopOnStdin { args.append("--stop-on-stdin") }
        if let root { args += ["--root", root] }
        if let threads { args += ["--threads", String(threads)] }
        if !measurePrivate { args.append("--no-private") }
        if !exclude.isEmpty { args += ["--exclude"] + exclude }
        if includeCloud { args.append("--include-cloud") }
        if !snapshot { args.append("--no-snapshot") }
        if reset { args.append("--reset") }
        if let db { args += ["--db", db] }
        return args
    }

    /// The argv after `doctor` for `tools doctor act`. `yes` satisfies a yes/no confirmation, each phrase a typed
    /// one; `dryRun` plans only. `ndjson` streams events for `ToolsLineStream` (parse with `DoctorActEvent.parse`).
    /// `expect` (finding id to the `reclaimableBytes` the UI showed) and `expectPaths` (finding id to its
    /// `pathsHash`) make the CLI refuse an item whose size drifted or whose path set changed as `stale`.
    public static func doctorActArguments(actionId: String, analyzerId: String, findingIDs: [String],
                                          method: DoctorActMethod?, yes: Bool = false, confirmPhrases: [String] = [],
                                          dryRun: Bool = false, ndjson: Bool = false,
                                          expect: [String: Int64] = [:],
                                          expectPaths: [String: String] = [:]) -> [String] {
        var args = ["act", actionId, "--analyzer", analyzerId]
        for id in findingIDs { args += ["--id", id] }
        if let method { args += ["--method", method.rawValue] }
        if yes { args.append("--yes") }
        for phrase in confirmPhrases { args += ["--confirm", phrase] }
        for (id, bytes) in expect.sorted(by: { $0.key < $1.key }) { args += ["--expect", "\(id)=\(bytes)"] }
        for (id, hash) in expectPaths.sorted(by: { $0.key < $1.key }) { args += ["--expect-paths", "\(id)=\(hash)"] }
        if dryRun { args.append("--dry-run") }
        args.append(ndjson ? "--ndjson" : "--json")
        return args
    }

    /// `tools doctor act … --json`. A refused or failed item is a result, not a thrown error: read `items`.
    /// Cancelling the calling task does not stop it: the run is detached, so a view's `.task` that ends mid-way does
    /// not kill a deletion halfway. It ends on its own or after `actTimeoutSeconds` (`timeoutSeconds` for a dry run).
    public func doctorAct(actionId: String, analyzerId: String, findingIDs: [String], method: DoctorActMethod?,
                          yes: Bool = false, confirmPhrases: [String] = [], dryRun: Bool = false,
                          expect: [String: Int64] = [:],
                          expectPaths: [String: String] = [:]) async throws -> DoctorActResult {
        guard !findingIDs.isEmpty else { throw ToolsDiskProviderError.invalidArgument("tools doctor act needs a finding id") }
        let args = Self.doctorActArguments(actionId: actionId, analyzerId: analyzerId, findingIDs: findingIDs,
                                           method: method, yes: yes, confirmPhrases: confirmPhrases, dryRun: dryRun,
                                           expect: expect, expectPaths: expectPaths)
        let bridge = self.bridge
        let timeout = dryRun ? timeoutSeconds : max(timeoutSeconds, actTimeoutSeconds)
        let run = Task.detached(priority: .userInitiated) {
            try await bridge.run(subcommand: "doctor", args: args, timeoutSeconds: timeout)
        }
        let result = try await run.value
        let stdout = Data(result.stdout.utf8)
        // A run where every item was refused may exit non-zero and still print its result.
        if let decoded = try? Self.decode(DoctorActResult.self, from: stdout, command: "doctor act") { return decoded }
        guard result.exitCode == 0 else {
            throw ToolsDiskProviderError.exit(code: result.exitCode, stderr: Self.stderrTail(result.stderr))
        }
        return try Self.decode(DoctorActResult.self, from: stdout, command: "doctor act")
    }

    // MARK: tools macos clones: apply, rollback, presets, daemon, config

    /// The argv after `macos` for `clones reclaim apply`. `usesCachedPlan` false passes `--no-cache` (always rescan).
    public static func clonesReclaimApplyArguments(_ options: ClonesReclaimPlanOptions,
                                                   usesCachedPlan: Bool = true) -> [String] {
        ["clones", "reclaim", "apply", "--format", "json", "--silent", "--yes"] + options.arguments
            + (usesCachedPlan ? [] : ["--no-cache"])
    }

    /// `tools macos clones reclaim apply --format json --yes`: converts the planned duplicates into clones
    /// (audited, reversible with `clonesRollback`). Detached like `doctorAct`, with `actTimeoutSeconds`. An error
    /// envelope throws `ClonesCommandError`; a run with failed files is a result (read `totals.errors`).
    public func clonesReclaimApply(_ options: ClonesReclaimPlanOptions,
                                   usesCachedPlan: Bool = true) async throws -> ClonesReclaimApplyOutcome {
        try Self.requirePaths(options.dirs, command: "macos clones reclaim apply")
        let args = Self.clonesReclaimApplyArguments(options, usesCachedPlan: usesCachedPlan)
        let payload = try await runClones(args: args, command: "macos clones reclaim apply", changesDisk: true)
        return try await Task.detached(priority: .userInitiated) {
            try Self.decodeClonesReclaimApply(payload)
        }.value
    }

    /// Decodes a reclaim apply output: the clone run, or the plan it printed when there was nothing to clone.
    public static func decodeClonesReclaimApply(_ data: Data) throws -> ClonesReclaimApplyOutcome {
        let payload = (try? jsonPayload(data)) ?? data
        if let error = ClonesCommandError.from(payload) { throw error }
        let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        if object?["ops"] == nil {
            return .nothingToApply(try decode(ClonesReclaimPlan.self, from: payload,
                                              command: "macos clones reclaim apply"))
        }
        return .applied(try decode(ClonesApplyResult.self, from: payload, command: "macos clones reclaim apply"))
    }

    /// The argv after `macos` for `clones optimize --rollback`.
    public static func clonesRollbackArguments(processId: String) -> [String] {
        ["clones", "optimize", "--rollback", "--process", processId, "--yes", "--format", "json", "--silent"]
    }

    /// `tools macos clones optimize --rollback --process <id> --yes --format json`: un-shares the clones of an
    /// earlier apply (a reclaim apply's `id`). Not enough space throws `ClonesCommandError` kind `rollback-space`.
    public func clonesRollback(processId: String) async throws -> ClonesApplyResult {
        let payload = try await runClones(args: Self.clonesRollbackArguments(processId: processId),
                                          command: "macos clones optimize --rollback", changesDisk: true)
        return try Self.decodeClonesApply(payload)
    }

    /// The argv after `macos` for `clones reclaim presets save <id>`.
    public static func clonesPresetSaveArguments(id: String, options: ClonesReclaimPlanOptions) -> [String] {
        ["clones", "reclaim", "presets", "save", id, "--json"] + options.selectorArguments
    }

    /// `tools macos clones reclaim presets save <id> … --json`: saves the selector without scanning.
    public func clonesPresetSave(id: String, options: ClonesReclaimPlanOptions) async throws -> ClonesPreset {
        try Self.requirePaths(options.dirs, command: "macos clones reclaim presets save")
        let payload = try await runClones(args: Self.clonesPresetSaveArguments(id: id, options: options),
                                          command: "macos clones reclaim presets save", changesDisk: false)
        return try Self.decode(PresetLine.self, from: payload, command: "macos clones reclaim presets save").preset
    }

    /// `tools macos clones reclaim presets rm <id> --json`. An unknown id throws `ClonesCommandError` kind
    /// `unknown-preset` (with `known`).
    @discardableResult
    public func clonesPresetRemove(id: String) async throws -> String {
        let payload = try await runClones(args: ["clones", "reclaim", "presets", "rm", id, "--json"],
                                          command: "macos clones reclaim presets rm", changesDisk: false)
        return try Self.decode(RemovedLine.self, from: payload, command: "macos clones reclaim presets rm").removed
    }

    /// `tools macos clones reclaim presets list --format json`: every saved selector with its last run and auto state.
    public func clonesPresets() async throws -> [ClonesPreset] {
        let payload = try await runClones(args: ["clones", "reclaim", "presets", "list", "--format", "json"],
                                          command: "macos clones reclaim presets list", changesDisk: false)
        return try Self.decode(PresetList.self, from: payload, command: "macos clones reclaim presets list").presets
    }

    /// The argv after `macos` for `clones reclaim presets run <id>`: a plan, or `--apply --yes`. `usesCachedPlan`
    /// false passes `--no-cache` to an apply (a plan always rescans).
    public static func clonesPresetRunArguments(id: String, apply: Bool, usesCachedPlan: Bool = true) -> [String] {
        ["clones", "reclaim", "presets", "run", id, "--format", "json", "--silent", "--no-daemon"]
            + (apply ? ["--apply", "--yes"] : [])
            + (apply && !usesCachedPlan ? ["--no-cache"] : [])
    }

    /// `tools macos clones reclaim presets run <id> --format json`: plans the preset's whole saved selector and records
    /// its last run and reclaimable bytes. Planning rewrites nothing.
    public func clonesPresetPlan(id: String) async throws -> ClonesReclaimPlan {
        let payload = try await runClones(args: Self.clonesPresetRunArguments(id: id, apply: false),
                                          command: "macos clones reclaim presets run", changesDisk: false)
        return try await Task.detached(priority: .userInitiated) {
            try Self.decode(ClonesReclaimPlan.self, from: payload, command: "macos clones reclaim presets run")
        }.value
    }

    /// `tools macos clones reclaim presets run <id> --apply --yes --format json`: applies the preset's plan, reusing
    /// a plan of the same selector from the last 60 s unless `usesCachedPlan` is false. Detached like
    /// `clonesReclaimApply`; the preset records the run only when the apply completed.
    public func clonesPresetApply(id: String, usesCachedPlan: Bool = true) async throws -> ClonesReclaimApplyOutcome {
        let args = Self.clonesPresetRunArguments(id: id, apply: true, usesCachedPlan: usesCachedPlan)
        let payload = try await runClones(args: args, command: "macos clones reclaim presets run --apply",
                                          changesDisk: true)
        return try await Task.detached(priority: .userInitiated) {
            try Self.decodeClonesReclaimApply(payload)
        }.value
    }

    /// The argv after `macos` for `clones reclaim presets auto <id>`. `enabled` nil changes only the limits.
    public static func clonesPresetAutoArguments(id: String, enabled: Bool?, maxBytes: ClonesAutoLimit<Int64> = .unchanged,
                                                 maxFiles: ClonesAutoLimit<Int> = .unchanged) -> [String] {
        var args = ["clones", "reclaim", "presets", "auto", id, "--json"]
        if let enabled { args.append(enabled ? "--on" : "--off") }
        switch maxBytes {
        case .unchanged: break
        case .set(let bytes): args += ["--max-bytes", sizeArgument(bytes)]
        case .none: args += ["--max-bytes", "none"]
        }
        switch maxFiles {
        case .unchanged: break
        case .set(let files): args += ["--max-files", String(files)]
        case .none: args += ["--max-files", "none"]
        }
        return args
    }

    /// `tools macos clones reclaim presets auto <id> --json`: lets the daily scan task run the preset on its own (the
    /// first run after arming is a dry run), stops it, or changes its per-run limits. Returns the preset after it.
    public func clonesPresetAuto(id: String, enabled: Bool?, maxBytes: ClonesAutoLimit<Int64> = .unchanged,
                                 maxFiles: ClonesAutoLimit<Int> = .unchanged) async throws -> ClonesPreset {
        let args = Self.clonesPresetAutoArguments(id: id, enabled: enabled, maxBytes: maxBytes, maxFiles: maxFiles)
        let payload = try await runClones(args: args, command: "macos clones reclaim presets auto", changesDisk: false)
        return try Self.decode(ClonesPreset.self, from: payload, command: "macos clones reclaim presets auto")
    }

    /// The argv after `macos` for `clones optimize --log --process <id>`.
    public static func clonesProcessLogArguments(processId: String) -> [String] {
        ["clones", "optimize", "--log", "--process", processId, "--format", "json", "--silent"]
    }

    /// `tools macos clones optimize --log --process <id> --format json`: a recorded run with every file operation
    /// (keep, replace, status, hashes before and after, error). Reads the audit log; changes nothing.
    public func clonesProcessLog(processId: String) async throws -> ClonesApplyResult {
        let payload = try await runClones(args: Self.clonesProcessLogArguments(processId: processId),
                                          command: "macos clones optimize --log", changesDisk: false)
        return try await Task.detached(priority: .userInitiated) { try Self.decodeClonesApply(payload) }.value
    }

    /// The argv after `macos` for `clones optimize`: a dry run, or `--apply --yes`.
    public static func clonesOptimizeArguments(_ options: ClonesOptimizeOptions, apply: Bool,
                                               usesCachedPlan: Bool = true) -> [String] {
        ["clones", "optimize"] + options.roots.map(operand) + ["--format", "json", "--silent"] + options.arguments
            + (apply ? ["--apply", "--yes"] : [])
            + (apply && !usesCachedPlan ? ["--no-cache"] : [])
    }

    /// `tools macos clones optimize --format json`: plans (a recorded dry run) or applies the cloning of every
    /// duplicate file under the roots. An apply is audited and reversible with `clonesRollback`, and runs detached
    /// with `actTimeoutSeconds`.
    public func clonesOptimize(_ options: ClonesOptimizeOptions, apply: Bool,
                               usesCachedPlan: Bool = true) async throws -> ClonesApplyResult {
        // `--worktrees-of <repo>` is a selector of its own: the CLI finds that repo's worktrees with no root or --dir.
        try Self.requirePaths(options.roots + options.dirs + [options.worktreesOf].compactMap { $0 },
                              command: "macos clones optimize")
        let args = Self.clonesOptimizeArguments(options, apply: apply, usesCachedPlan: usesCachedPlan)
        let payload = try await runClones(args: args, command: apply ? "macos clones optimize --apply" : "macos clones optimize",
                                          changesDisk: apply)
        return try await Task.detached(priority: .userInitiated) { try Self.decodeClonesApply(payload) }.value
    }

    /// `tools macos clones reclaim stores --format json`: bun cache entries no install tree clones. Report only; it
    /// deletes nothing. `minBytes` judges each entry by its files of at least that size (CLI default 1 MB).
    public func clonesStoreReport(minBytes: Int64? = nil) async throws -> ClonesStoreReport {
        var args = ["clones", "reclaim", "stores", "--format", "json"]
        if let minBytes { args += ["--min-size", Self.sizeArgument(minBytes)] }
        let payload = try await runClones(args: args, command: "macos clones reclaim stores", changesDisk: false)
        return try await Task.detached(priority: .userInitiated) {
            try Self.decode(ClonesStoreReport.self, from: payload, command: "macos clones reclaim stores")
        }.value
    }

    /// `tools macos clones daemon enable --json`: registers the daily scan and prune tasks.
    public func clonesDaemonEnable() async throws -> ClonesDaemonChange {
        let payload = try await runClones(args: ["clones", "daemon", "enable", "--json"],
                                          command: "macos clones daemon enable", changesDisk: false)
        return try Self.decode(ClonesDaemonChange.self, from: payload, command: "macos clones daemon enable")
    }

    /// `tools macos clones daemon disable --json`: removes the tasks and keeps plans from registering them again.
    public func clonesDaemonDisable() async throws -> ClonesDaemonChange {
        let payload = try await runClones(args: ["clones", "daemon", "disable", "--json"],
                                          command: "macos clones daemon disable", changesDisk: false)
        return try Self.decode(ClonesDaemonChange.self, from: payload, command: "macos clones daemon disable")
    }

    /// `tools macos clones daemon status --json`.
    public func clonesDaemonStatus() async throws -> ClonesDaemonStatus {
        try await fetch(ClonesDaemonStatus.self, command: "macos clones daemon status", subcommand: "macos",
                        args: ["clones", "daemon", "status", "--json"])
    }

    /// The argv after `macos` for `clones config`: `--list` prints the config; each added or removed folder is its
    /// own flag. A path with a comma cannot pass (the CLI splits comma lists), so it is refused.
    public static func clonesConfigArguments(addDirs: [String] = [], removeDirs: [String] = [], minReal: Int64? = nil,
                                             nodeModules: Bool? = nil) throws -> [String] {
        if let bad = (addDirs + removeDirs).first(where: { $0.contains(",") }) {
            throw ToolsDiskProviderError.invalidArgument("tools macos clones config splits on commas: \(bad)")
        }
        var args = ["clones", "config", "--list"]
        for dir in addDirs { args += ["--add-dir", dir] }
        for dir in removeDirs { args += ["--remove-dir", dir] }
        if let minReal { args += ["--set-min-real", sizeArgument(minReal)] }
        if let nodeModules { args += ["--node-modules", nodeModules ? "on" : "off"] }
        return args
    }

    /// `tools macos clones config --list`: the watched folders and scan defaults.
    public func clonesConfig() async throws -> ClonesConfig {
        try await fetch(ClonesConfig.self, command: "macos clones config", subcommand: "macos",
                        args: Self.clonesConfigArguments())
    }

    /// `tools macos clones config --add-dir … --remove-dir … --set-min-real … --node-modules …`: the config after the
    /// change. The CLI skips a folder that does not exist (compare `watchedDirs`). `minReal` and `nodeModules` are the
    /// daily scan's defaults.
    public func clonesConfigUpdate(addDirs: [String] = [], removeDirs: [String] = [], minReal: Int64? = nil,
                                   nodeModules: Bool? = nil) async throws -> ClonesConfig {
        try await fetch(ClonesConfig.self, command: "macos clones config", subcommand: "macos",
                        args: Self.clonesConfigArguments(addDirs: addDirs, removeDirs: removeDirs, minReal: minReal,
                                                         nodeModules: nodeModules))
    }

    private struct PresetList: Decodable {
        var presets: [ClonesPreset]
    }

    private struct PresetLine: Decodable {
        var preset: ClonesPreset
    }

    private struct RemovedLine: Decodable {
        var removed: String
    }

    /// Runs a clones command that prints `{"error": …}` instead of its result: the envelope throws
    /// `ClonesCommandError` whatever the exit code, and a run without JSON throws `.exit`. A command that changes
    /// the disk runs detached (a cancelled caller cannot stop it halfway) with `actTimeoutSeconds`.
    private func runClones(args: [String], command: String, changesDisk: Bool) async throws -> Data {
        let bridge = self.bridge
        let timeout = changesDisk ? max(timeoutSeconds, actTimeoutSeconds) : timeoutSeconds
        let result: ToolsRunResult
        if changesDisk {
            result = try await Task.detached(priority: .userInitiated) {
                try await bridge.run(subcommand: "macos", args: args, timeoutSeconds: timeout)
            }.value
        } else {
            result = try await bridge.run(subcommand: "macos", args: args, timeoutSeconds: timeout)
        }
        let stdout = Data(result.stdout.utf8)
        let payload = try? Self.jsonPayload(stdout)
        if let payload, let error = ClonesCommandError.from(payload) { throw error }
        // A run with failed files exits 1 and still prints its result.
        guard let payload else {
            throw ToolsDiskProviderError.exit(code: result.exitCode, stderr: Self.stderrTail(result.stderr))
        }
        return payload
    }

    /// Decodes a clones apply or rollback output, throwing `ClonesCommandError` for an error envelope.
    public static func decodeClonesApply(_ data: Data) throws -> ClonesApplyResult {
        let payload = (try? jsonPayload(data)) ?? data
        if let error = ClonesCommandError.from(payload) { throw error }
        return try decode(ClonesApplyResult.self, from: data, command: "macos clones apply")
    }

    private func fetchIndex<T: Decodable & Sendable>(_ type: T.Type, args: [String], db: String?) async throws -> T {
        var argv = args
        if let db { argv += ["--db", db] }
        let command = "du " + args.prefix(2).joined(separator: " ")
        let result = try await bridge.run(subcommand: "du", args: argv, timeoutSeconds: timeoutSeconds)
        let stdout = Data(result.stdout.utf8)
        guard result.exitCode == 0 else {
            if let payload = try? Self.jsonPayload(stdout),
               let error = try? DuIndexJSON.decoder().decode(DuIndexError.self, from: payload) {
                throw error
            }
            throw ToolsDiskProviderError.exit(code: result.exitCode, stderr: Self.stderrTail(result.stderr))
        }
        return try await Task.detached(priority: .userInitiated) {
            try Self.decode(T.self, from: stdout, command: command, snakeCaseKeys: true)
        }.value
    }
}
