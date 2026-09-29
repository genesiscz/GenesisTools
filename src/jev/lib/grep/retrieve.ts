import { basename, extname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { localCallContext } from "./call-context";
import { fileCard } from "./cards";
import { createFilesystem, type DirectoryEntry, type Snapshot } from "./filesystem";
import { repositoryContext, withCurrentTestCommands } from "./repository-context";
import {
    type DirectoryPreview,
    type Evidence,
    type FilePreview,
    fileAssessmentRequest,
    type NavigationItem,
    navigationRequest,
    type RelationAnchor,
} from "./requests";
import { KEEP_THRESHOLD, planSelection, type SelectionResult, selectFile } from "./selection";
import { inspect, sourceForUnit, splitSource } from "./source";
import { selectTestBodies } from "./test-bodies";
import {
    EvaluationFailure,
    type EvaluationRequest,
    type Evaluator,
    type FileEvidence,
    jsonBytes,
    type RetrievalResult,
    type SearchInput,
} from "./types";

const { log } = logger.scoped("jev-grep");
const prof = profiler.scope("jev-grep");

/** Bounds per-stage source work. The evaluator separately caps shared provider attempts. */
export const STAGE_WORKERS = 32;
const MAX_ENTRIES = 100_000;
const MAX_INSPECTED_BYTES = 1_000_000;
/** Bytes one directory's content samples may read, over all its files. */
const MAX_DIRECTORY_SAMPLE_BYTES = 4_000_000;
const NAVIGATION_BATCH_ITEMS = 128;
const NAVIGATION_BATCH_BYTES = 38_000;
/**
 * Directories are explored, and files admitted, above this probability. Upstream's decision record
 * (`specs/done/jevgrep/contracts.md`) still says files are admitted at 0.25, but `discover` on the
 * pinned commit compares files with `probability > 0.5`, the same operator as directories. This port
 * follows the code. Do not "correct" it back to the markdown.
 */
export const ADMIT_THRESHOLD = 0.5;
/**
 * Budgeted loop (`SearchInput.budget > 0`). Each stage may spend calls until the running request count
 * reaches its share of the budget; selection takes what is left. Upstream's loop ignores all of these.
 */
export const BUDGET_SHARES = { discover: 0.4, verify: 0.6, relate: 0.65 } as const;
/** Directories expanded per best-first round. */
export const BUDGET_BEAM = 6;
/** Card scores at or below this never earn a full-source check. */
export const VERIFY_FLOOR = 0.25;
/** Shortlisted files whose full source is checked in one parallel wave. */
const VERIFY_WAVE = 12;
/** Pruned directories, closest to the bar first, the relationship pass may reconsider. */
const BUDGET_RELATED_DIRECTORIES = 4;
/**
 * Admitted files, best admission score first, that get a role assessment (one call each). Their
 * `priority` decides which files then get source selection, and the rest keep their roles as leads.
 */
export const BUDGET_ASSESSED_FILES = 12;

/** Kinds that end the walk: nothing later can succeed, or the caller asked to stop. */
const STOPPING_KINDS = new Set(["authentication", "request-limit", "cancelled", "interrupted"]);

type Donor = { path: string; contentHash: string };
type Candidate = Donor & { score: number };

function emptyEvidence(candidate: Candidate): FileEvidence {
    return { ...candidate, roles: [], leads: [], selected: [], rendered: [], excerpts: [], sourceOmitted: false };
}

function failureKind(error: unknown): { kind: string; message?: string } {
    return error instanceof EvaluationFailure
        ? { kind: error.kind, message: error.message }
        : { kind: "provider", message: undefined };
}

/** Traversal owns admission. Every stage reads through the same eligibility policy. */
export async function retrieve(input: SearchInput, evaluator: Evaluator): Promise<RetrievalResult> {
    const reader = await createFilesystem({
        root: input.root,
        policy: input.policy,
        signal: input.signal,
        protectedPaths: input.protectedPaths,
    });
    const issues = new Map<string, number>();
    let providerFailure: string | undefined;
    const inspected = new Set<string>();
    const candidates = new Map<string, Candidate>();
    const files = new Map<string, FileEvidence>();
    const declarations = new Map<string, SelectionResult["declarations"]>();
    const visited = new Set<string>();
    const pruned = new Map<string, NavigationItem>();
    const previews = new Map<string, FilePreview>();
    const donors = new WeakMap<NavigationItem, Donor[]>();
    const anchors = new WeakMap<RelationAnchor, Donor>();
    const detailed = profiler.detail === "all";

    function buffered(item: NavigationItem, sources: Donor[]): NavigationItem {
        donors.set(
            item,
            sources.map(({ path, contentHash }) => ({ path, contentHash }))
        );
        return item;
    }

    let validationQueue: Promise<void> = Promise.resolve();
    function freshEvaluation(request: EvaluationRequest, sources: Donor[], navigation = false) {
        const validate = async () => {
            for (const source of new Map(sources.map((item) => [item.path, item])).values()) {
                if (!(await unchanged(source))) {
                    throw new EvaluationFailure("source-invalid");
                }
            }
        };
        const beforeAttempt = () => {
            const pending = validationQueue.then(validate);
            validationQueue = pending.catch(() => undefined);
            return pending;
        };
        return evaluator.evaluate(request, { navigation, beforeAttempt, sources });
    }

    let entriesSeen = 0;
    let stop = false;
    function issue(kind: string, count = 1, message?: string): void {
        if (kind === "provider") {
            providerFailure ??= message;
        }

        issues.set(kind, (issues.get(kind) ?? 0) + count);
        if (STOPPING_KINDS.has(kind)) {
            stop = true;
        }
    }

    async function snapshot(path: string, maxBytes?: number): Promise<Snapshot | undefined> {
        const result = await reader.readSnapshot(path, { maxBytes });
        if (result.status === "issue") {
            issue(result.issue.kind);
            return undefined;
        }

        if (result.status === "excluded") {
            return undefined;
        }

        inspected.add(path);
        return result.snapshot;
    }

    async function unchanged(candidate: Donor): Promise<Snapshot | undefined> {
        const result = await reader.readSnapshot(candidate.path);
        if (result.status === "ok" && result.snapshot.contentHash === candidate.contentHash) {
            inspected.add(candidate.path);
            return result.snapshot;
        }

        issue(result.status === "issue" ? result.issue.kind : "changed");
        if (result.status === "issue" && result.issue.kind === "interrupted") {
            return undefined;
        }

        log.debug({ path: candidate.path }, "Grep snapshot changed; dropping its source");
        const prior = files.get(candidate.path);
        if (prior) {
            files.set(candidate.path, {
                ...prior,
                roles: [],
                priority: undefined,
                presentationExcerpts: [],
                selectedPresentationExcerpts: [],
                callLeads: [],
                presentationSelected: [],
                sourceDecisions: [],
                leads: [],
                selected: [],
                rendered: [],
                excerpts: [],
                sourceOmitted: true,
            });
        }

        return undefined;
    }

    async function score(items: NavigationItem[], anchor?: RelationAnchor) {
        const results: Array<{ item: NavigationItem; score: number }> = [];
        const batches: NavigationItem[][] = [];
        let batch: NavigationItem[] = [];
        for (const item of items) {
            if (jsonBytes(navigationRequest(input.query, [item], anchor)) > NAVIGATION_BATCH_BYTES) {
                issue("request-size");
                continue;
            }

            if (
                batch.length &&
                (batch.length >= NAVIGATION_BATCH_ITEMS ||
                    jsonBytes(navigationRequest(input.query, [...batch, item], anchor)) > NAVIGATION_BATCH_BYTES)
            ) {
                batches.push(batch);
                batch = [];
            }

            batch.push(item);
        }

        if (batch.length) {
            batches.push(batch);
        }

        async function scoreGroup(group: NavigationItem[]): Promise<void> {
            try {
                const sources = group.flatMap((item) => donors.get(item) ?? []);
                const anchorDonor = anchor ? anchors.get(anchor) : undefined;
                if (anchorDonor) {
                    sources.push(anchorDonor);
                }

                const scores = await freshEvaluation(navigationRequest(input.query, group, anchor), sources, true);
                for (const [index, item] of group.entries()) {
                    results.push({ item, score: scores[`q${index}`]! });
                }
            } catch (error) {
                if (
                    error instanceof EvaluationFailure &&
                    (error.kind === "source-invalid" || (error.kind === "provider" && error.splitEligible)) &&
                    group.length > 1
                ) {
                    const middle = Math.ceil(group.length / 2);
                    batches.push(group.slice(0, middle), group.slice(middle));
                } else if (!(error instanceof EvaluationFailure && error.kind === "source-invalid")) {
                    const failure = failureKind(error);
                    issue(failure.kind, 1, failure.message);
                }
            }
        }

        // Failed groups append their halves to the same queue. A recovered parent is not incomplete;
        // only an exhausted leaf or a terminal failure records an issue.
        await new Promise<void>((resolve, reject) => {
            let active = 0;
            let rejected = false;
            function pump(): void {
                if (rejected) {
                    return;
                }

                while (active < STAGE_WORKERS && batches.length && !stop && !input.signal.aborted) {
                    const group = batches.shift()!;
                    active++;
                    scoreGroup(group).then(
                        () => {
                            active--;
                            pump();
                        },
                        (error: unknown) => {
                            rejected = true;
                            reject(error);
                        }
                    );
                }

                if (active === 0) {
                    resolve();
                }
            }

            pump();
        });
        return results;
    }

    async function previewDirectory(path: string): Promise<DirectoryPreview | undefined> {
        const preview: DirectoryPreview = {
            entries: [],
            truncated: false,
            sampledFiles: 0,
            sampledDirectories: 0,
            sampledExtensions: {},
        };
        let cursor: string | undefined;
        let bytes = 0;
        try {
            do {
                const page = await reader.listPage(path, cursor);
                cursor = page.nextCursor;
                for (const entry of page.issues) {
                    issue(entry.kind);
                }

                if (page.issues.length) {
                    return undefined;
                }

                for (const entry of page.entries) {
                    const child = { name: basename(entry.path), kind: entry.kind };
                    const size = jsonBytes(child);
                    if (preview.entries.length >= 64 || bytes + size > 4096) {
                        preview.truncated = true;
                        break;
                    }

                    preview.entries.push(child);
                    bytes += size;
                    if (entry.kind === "directory") {
                        preview.sampledDirectories++;
                    } else {
                        preview.sampledFiles++;
                        const extension = extname(entry.path) || "[no extension]";
                        preview.sampledExtensions[extension] = (preview.sampledExtensions[extension] ?? 0) + 1;
                    }
                }

                if (preview.truncated) {
                    break;
                }
            } while (cursor && !stop);

            if (cursor) {
                preview.truncated = true;
            }
        } finally {
            if (cursor) {
                await reader.closeCursor(cursor);
            }
        }

        preview.entries.sort((a, b) => a.name.localeCompare(b.name));
        return preview;
    }

    async function withDirectoryContent(item: NavigationItem): Promise<NavigationItem> {
        const preview: DirectoryPreview = {
            ...(item.childPreview as DirectoryPreview),
            contentSamples: [],
        };
        const samples = preview.contentSamples ?? [];
        const sources: Donor[] = [];
        const children = preview.entries.filter((child) => child.kind === "file");
        const perFile = Math.max(80, Math.floor(16000 / Math.max(1, children.length)));
        // The request carries a few short slices; the whole file is read only to hash it for the donor check.
        let sampleBytes = MAX_DIRECTORY_SAMPLE_BYTES;
        for (const child of children) {
            if (stop || sampleBytes <= 0) {
                break;
            }

            const snapshotValue = await snapshot(
                `${item.path}/${child.name}`,
                Math.min(MAX_INSPECTED_BYTES, sampleBytes)
            );
            if (!snapshotValue) {
                continue;
            }

            sampleBytes -= Buffer.byteLength(snapshotValue.source);
            sources.push({ path: snapshotValue.path, contentHash: snapshotValue.contentHash });
            const source = snapshotValue.source;
            const part = Math.floor(perFile / 3);
            const offsets = [
                0,
                Math.max(0, Math.floor(source.length / 2) - Math.floor(part / 2)),
                Math.max(0, source.length - part),
            ];
            samples.push({
                name: child.name,
                truncated: source.length > perFile,
                source:
                    source.length <= perFile
                        ? source
                        : offsets
                              .map((start) => `[character offset ${start}]\n${source.slice(start, start + part)}`)
                              .join("\n...\n"),
            });
        }

        while (jsonBytes(preview) > 28000 && samples.some((sample) => sample.source.length > 80)) {
            for (const sample of samples) {
                sample.source = sample.source.slice(0, Math.max(80, Math.floor(sample.source.length * 0.8)));
                sample.truncated = true;
            }
        }

        return buffered({ ...item, childPreview: preview }, sources);
    }

    function previewFile(source: Snapshot): FilePreview {
        const bytes = Buffer.from(source.source);
        let text = new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, 16384), {
            stream: bytes.length > 16384,
        });
        let truncated = bytes.length > 16384;
        while (jsonBytes(text) > 24000) {
            let end = Math.floor(text.length * 0.75);
            const last = text.charCodeAt(end - 1);
            if (last >= 0xd800 && last <= 0xdbff) {
                end--;
            }

            text = text.slice(0, end);
            truncated = true;
        }

        const preview: FilePreview = {
            sizeBytes: bytes.length,
            extension: extname(source.path),
            text,
            previewBytes: Buffer.byteLength(text),
            truncated,
            range: "opening bytes",
            declarations: [],
            declarationIndexTruncated: false,
        };
        // Upstream also samples Python ranges through CPython here. Without it, Python keeps the opening bytes.
        if (truncated && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(source.path) && bytes.length <= MAX_INSPECTED_BYTES) {
            const syntax = inspect(source, { maxUnitBytes: Math.max(4, bytes.length) });
            const declarationIndex = syntax.units
                .filter((unit) => !unit.partial)
                .map((unit) => ({ name: unit.name, ...unit.range }));
            preview.declarations = declarationIndex;
            while (declarationIndex.length && jsonBytes(preview) > 32000) {
                declarationIndex.pop();
                preview.declarationIndexTruncated = true;
            }
        }

        return preview;
    }

    /** The whole file is snapshotted once; the 12 KB chunks are views of it, each its own question. */
    function chunkItems(source: Snapshot): NavigationItem[] {
        const chunks = splitSource(source, 12_000);
        return chunks.map((chunk) => {
            const text = sourceForUnit(source, chunk);
            return buffered(
                {
                    path: source.path,
                    kind: "file",
                    filePreview: {
                        sizeBytes: Buffer.byteLength(source.source),
                        extension: extname(source.path),
                        text,
                        previewBytes: Buffer.byteLength(text),
                        truncated: chunks.length > 1,
                        range: "sampled source ranges",
                    },
                },
                [source]
            );
        });
    }

    /** Every eligible entry of one directory, paged, charged against the shared entry ceiling. */
    async function listDirectory(path: string): Promise<DirectoryEntry[]> {
        const entries: DirectoryEntry[] = [];
        let cursor: string | undefined;
        try {
            do {
                const page = await reader.listPage(path, cursor);
                cursor = page.nextCursor;
                for (const entry of page.issues) {
                    issue(entry.kind);
                }

                entries.push(...page.entries);
                if (
                    entriesSeen + entries.length > MAX_ENTRIES ||
                    (cursor && entriesSeen + entries.length === MAX_ENTRIES)
                ) {
                    issue("resource_limit");
                    break;
                }
            } while (cursor && !stop);
        } finally {
            if (cursor) {
                await reader.closeCursor(cursor);
            }
        }

        return entries.sort((a, b) => a.path.localeCompare(b.path));
    }

    async function discover(seeds: string[], anchor?: RelationAnchor): Promise<void> {
        const directories = [...seeds];
        while (directories.length && !stop && entriesSeen < MAX_ENTRIES) {
            const level = directories.splice(0).map((path) => ({ path, depth: 0 }));
            const items: NavigationItem[] = [];
            const hashes = new Map<string, string>();
            for (let index = 0; index < level.length && !stop; index++) {
                const current = level[index]!;
                if (entriesSeen >= MAX_ENTRIES) {
                    issue("resource_limit");
                    break;
                }

                if (visited.has(current.path)) {
                    continue;
                }

                visited.add(current.path);
                const entries = await listDirectory(current.path);
                for (const entry of entries) {
                    if (stop) {
                        break;
                    }

                    if (entriesSeen++ >= MAX_ENTRIES) {
                        issue("resource_limit");
                        break;
                    }

                    if (entry.kind === "directory") {
                        // Two-level lookahead: children of a depth-0 directory are expanded without a Jev call.
                        if (current.depth === 0) {
                            level.push({ path: entry.path, depth: 1 });
                            continue;
                        }

                        const childPreview = await previewDirectory(entry.path);
                        if (!childPreview) {
                            continue;
                        }

                        const item: NavigationItem = { path: entry.path, kind: "directory", childPreview };
                        items.push(anchor ? await withDirectoryContent(item) : item);
                        continue;
                    }

                    const source = await snapshot(entry.path);
                    if (!source) {
                        continue;
                    }

                    hashes.set(entry.path, source.contentHash);
                    const filePreview = previewFile(source);
                    previews.set(entry.path, filePreview);
                    if (Buffer.byteLength(source.source) > MAX_INSPECTED_BYTES) {
                        issue("resource_limit");
                        items.push(buffered({ path: entry.path, kind: "file", filePreview }, [source]));
                        continue;
                    }

                    items.push(...chunkItems(source));
                }
            }

            for (const { item, score: probability } of await score(items, anchor)) {
                if (item.kind === "directory") {
                    if (probability > ADMIT_THRESHOLD) {
                        directories.push(item.path);
                    } else if (!anchor) {
                        pruned.set(item.path, item);
                    }

                    continue;
                }

                // A file is admitted when any chunk passes; its score is the best chunk.
                if (probability > ADMIT_THRESHOLD) {
                    const prior = candidates.get(item.path);
                    if (!prior || probability > prior.score) {
                        candidates.set(item.path, {
                            path: item.path,
                            contentHash: hashes.get(item.path)!,
                            score: probability,
                        });
                    }
                }
            }
        }

        if (directories.length) {
            issue("resource_limit");
        }
    }

    function sortedCandidates(): Candidate[] {
        return [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    }

    async function parallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
        let next = 0;
        const results = await Promise.allSettled(
            Array.from({ length: Math.min(STAGE_WORKERS, items.length) }, async () => {
                try {
                    while (next < items.length && !stop && !input.signal.aborted) {
                        await work(items[next++]!);
                    }
                } catch (error) {
                    stop = true;
                    throw error;
                }
            })
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
            throw failed.reason;
        }
    }

    /** The first admitted file above the keep bar whose units carry a `ClassName.context` header. */
    async function findAnchor(): Promise<RelationAnchor | undefined> {
        for (const candidate of sortedCandidates()) {
            if (candidate.score <= ADMIT_THRESHOLD || stop) {
                break;
            }

            const source = await unchanged(candidate);
            if (!source) {
                continue;
            }

            const size = Buffer.byteLength(source.source);
            const units = inspect(source, { maxParseBytes: Math.max(1, size), maxUnitBytes: Math.max(4, size) }).units;
            const classes = [
                ...new Set(
                    units.filter((unit) => unit.name.endsWith(".context")).map((unit) => unit.name.split(".")[0]!)
                ),
            ];
            if (classes.length && jsonBytes(classes) < 4000) {
                const anchor = { path: candidate.path, classes };
                anchors.set(anchor, candidate);
                return anchor;
            }
        }

        return undefined;
    }

    const budget = input.budget && input.budget > 0 ? input.budget : undefined;
    const warnings = new Map<string, number>();
    const warn = (kind: string, count = 1) => warnings.set(kind, (warnings.get(kind) ?? 0) + count);
    const cardScores = new Map<string, Candidate>();
    const prunedScores = new Map<string, number>();

    /**
     * One directory's children, each file as a card and each subdirectory as a preview. `lookahead`
     * (the root only) also lists the subdirectories' children without a call, as upstream does at every
     * level; below the root that would card every file of a broad directory such as `src/utils`, which
     * measured at 770 to 990 cards a search, so best-first descends one level at a time instead.
     */
    async function expandBudgeted(
        path: string,
        items: NavigationItem[],
        hashes: Map<string, string>,
        lookahead = false
    ): Promise<void> {
        const level = [{ path, depth: lookahead ? 0 : 1 }];
        for (let index = 0; index < level.length && !stop; index++) {
            const current = level[index]!;
            if (entriesSeen >= MAX_ENTRIES) {
                issue("resource_limit");
                return;
            }

            if (visited.has(current.path)) {
                continue;
            }

            visited.add(current.path);
            for (const entry of await listDirectory(current.path)) {
                if (stop) {
                    return;
                }

                if (entriesSeen++ >= MAX_ENTRIES) {
                    issue("resource_limit");
                    return;
                }

                if (entry.kind === "directory") {
                    if (current.depth === 0) {
                        level.push({ path: entry.path, depth: 1 });
                        continue;
                    }

                    const childPreview = await previewDirectory(entry.path);
                    if (childPreview) {
                        items.push({ path: entry.path, kind: "directory", childPreview });
                    }

                    continue;
                }

                const source = await snapshot(entry.path);
                if (!source) {
                    continue;
                }

                hashes.set(entry.path, source.contentHash);
                previews.set(entry.path, previewFile(source));
                items.push(buffered({ path: entry.path, kind: "file", filePreview: fileCard(source) }, [source]));
            }
        }
    }

    /** Best-first: expand the highest-scoring directories until the discovery share is spent. */
    async function discoverBudgeted(until: number): Promise<void> {
        const frontier = [{ path: ".", score: 1 }];
        let rounds = 0;
        while (frontier.length && !stop && evaluator.requests < until) {
            frontier.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
            const items: NavigationItem[] = [];
            const hashes = new Map<string, string>();
            let itemBytes = 0;
            // Stop adding directories once this round alone would spend the rest of the share.
            for (let taken = 0; taken < BUDGET_BEAM && frontier.length; taken++) {
                if (taken > 0 && evaluator.requests + Math.ceil(itemBytes / NAVIGATION_BATCH_BYTES) >= until) {
                    break;
                }

                const before = items.length;
                const directory = frontier.shift()!.path;
                await expandBudgeted(directory, items, hashes, directory === ".");
                itemBytes += jsonBytes(items.slice(before));
            }

            rounds++;
            for (const { item, score: probability } of await score(items)) {
                if (item.kind === "directory") {
                    if (probability > ADMIT_THRESHOLD) {
                        frontier.push({ path: item.path, score: probability });
                    } else {
                        pruned.set(item.path, item);
                        prunedScores.set(item.path, probability);
                    }

                    continue;
                }

                cardScores.set(item.path, { path: item.path, contentHash: hashes.get(item.path)!, score: probability });
            }
        }

        log.debug(
            { rounds, cards: cardScores.size, unexplored: frontier.length, requests: evaluator.requests },
            "Grep budgeted discovery finished"
        );
        if (frontier.length) {
            warn("budget_unexplored_directories", frontier.length);
        }
    }

    /**
     * Upstream's admission for the shortlist: every chunk of a card-shortlisted file gets the full-source
     * question, and the file is admitted when a chunk passes. Best cards first, until the share is spent.
     */
    async function verifyShortlist(shortlist: Candidate[], until: number, anchor?: RelationAnchor): Promise<void> {
        let next = 0;
        while (next < shortlist.length && !stop && evaluator.requests < until) {
            const items: NavigationItem[] = [];
            const hashes = new Map<string, string>();
            for (const card of shortlist.slice(next, next + VERIFY_WAVE)) {
                const source = await unchanged(card);
                if (!source) {
                    continue;
                }

                hashes.set(card.path, source.contentHash);
                items.push(
                    ...(Buffer.byteLength(source.source) > MAX_INSPECTED_BYTES
                        ? [buffered({ path: card.path, kind: "file", filePreview: previews.get(card.path)! }, [source])]
                        : chunkItems(source))
                );
            }

            next += VERIFY_WAVE;
            for (const { item, score: probability } of await score(items, anchor)) {
                const prior = candidates.get(item.path);
                if (probability > ADMIT_THRESHOLD && (!prior || probability > prior.score)) {
                    candidates.set(item.path, {
                        path: item.path,
                        contentHash: hashes.get(item.path)!,
                        score: probability,
                    });
                }
            }
        }

        if (next < shortlist.length) {
            warn("budget_unverified_files", shortlist.length - next);
        }
    }

    function shortlistFrom(cards: Iterable<Candidate>): Candidate[] {
        return [...cards]
            .filter((card) => card.score > VERIFY_FLOOR && !candidates.has(card.path))
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    }

    /** Upstream's relationship pass, reduced to the pruned directories closest to the bar. */
    async function relateBudgeted(until: number): Promise<void> {
        const anchor = await findAnchor();
        if (!anchor || stop || evaluator.requests >= until) {
            return;
        }

        const closest = [...prunedScores]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, BUDGET_RELATED_DIRECTORIES)
            .map(([path]) => pruned.get(path)!);
        const items: NavigationItem[] = [];
        for (const item of closest) {
            items.push(await withDirectoryContent(item));
        }

        const seeds = (await score(items, anchor)).filter((decision) => decision.score > ADMIT_THRESHOLD);
        const related = new Map<string, Candidate>();
        for (const { item } of seeds) {
            const cards: NavigationItem[] = [];
            const hashes = new Map<string, string>();
            await expandBudgeted(item.path, cards, hashes);
            for (const { item: card, score: probability } of await score(cards, anchor)) {
                if (card.kind === "file") {
                    related.set(card.path, {
                        path: card.path,
                        contentHash: hashes.get(card.path)!,
                        score: probability,
                    });
                }
            }
        }

        log.debug(
            { anchor: anchor.path, reconsidered: closest.length, seeds: seeds.length },
            "Grep budgeted relationship pass"
        );
        await verifyShortlist(shortlistFrom(related.values()), until, anchor);
    }

    /** Budgeted: one selection pass costs one call per declaration group of each file. */
    const selectionCalls = new Map<string, number>();

    /**
     * Budgeted: the assessed files in the packet's order (priority, then score) whose first selection
     * pass, every declaration group, still fits the budget. A file gets its whole first pass or nothing,
     * so its source is upstream's first-pass choice; the rest stay admitted as leads.
     */
    async function affordableForSelection(
        assessed: Candidate[],
        priorities: ReadonlyMap<string, { priority: number }>,
        total: number
    ): Promise<Candidate[]> {
        const rank = (candidate: Candidate) => priorities.get(candidate.path)?.priority ?? candidate.score;
        const byPriority = [...assessed].sort(
            (a, b) => rank(b) - rank(a) || b.score - a.score || a.path.localeCompare(b.path)
        );
        let room = total - evaluator.requests;
        const chosen: Candidate[] = [];
        for (const candidate of byPriority) {
            const source = await unchanged(candidate);
            if (!source || Buffer.byteLength(source.source) > MAX_INSPECTED_BYTES) {
                continue;
            }

            const calls = planSelection(source).groups.length;
            if (calls <= room) {
                selectionCalls.set(candidate.path, calls);
                chosen.push(candidate);
                room -= calls;
            }
        }

        return chosen;
    }

    /** Budgeted: the reference pass runs only when the whole of it still fits. Upstream always runs it. */
    function secondPassFits(list: Candidate[]): boolean {
        if (!budget) {
            return true;
        }

        const calls = list.reduce((sum, candidate) => sum + (selectionCalls.get(candidate.path) ?? 0), 0);
        if (evaluator.requests + calls <= budget) {
            return true;
        }

        warn("budget_skipped_reference_pass");
        return false;
    }

    try {
        try {
            if (budget) {
                await prof.measureAsync("discover", () => discoverBudgeted(budget * BUDGET_SHARES.discover));
                await prof.measureAsync("verify", () =>
                    verifyShortlist(shortlistFrom(cardScores.values()), budget * BUDGET_SHARES.verify)
                );
                await prof.measureAsync("discover-related", () => relateBudgeted(budget * BUDGET_SHARES.relate));
            }

            let anchor: RelationAnchor | undefined;
            if (!budget) {
                await prof.measureAsync("discover", () => discover(["."]));
                anchor = await findAnchor();
            }

            if (anchor && !stop) {
                // One relationship pass, anchored before new candidates are admitted. Never looped.
                log.debug(
                    { anchor: anchor.path, classes: anchor.classes.length, pruned: pruned.size },
                    "Grep relationship pass"
                );
                const items: NavigationItem[] = [];
                for (const item of pruned.values()) {
                    if (stop) {
                        break;
                    }

                    items.push(await withDirectoryContent(item));
                }

                const seeds = (await score(items, anchor))
                    .filter((decision) => decision.score > ADMIT_THRESHOLD)
                    .map((decision) => decision.item.path);
                await prof.measureAsync("discover-related", () => discover(seeds, anchor));
            }

            const admitted = [...candidates.values()];
            // Every admitted path survives even if later source inspection fails: a path is a lead.
            for (const candidate of admitted) {
                files.set(candidate.path, emptyEvidence(candidate));
            }

            log.debug({ admitted: admitted.map((candidate) => candidate.path) }, "Grep admitted files");
            const select = async (list: Candidate[], evidence?: () => Promise<Evidence[] | undefined>) =>
                parallel(list, async (candidate) => {
                    const source = await unchanged(candidate);
                    if (!source) {
                        return;
                    }

                    if (Buffer.byteLength(source.source) > MAX_INSPECTED_BYTES) {
                        issue("source_inspection_limit");
                        return;
                    }

                    const run = () =>
                        selectFile({
                            snapshot: source,
                            query: input.query,
                            score: candidate.score,
                            evaluator: {
                                evaluate: (request) => {
                                    const context = request.state as { selectedEvidence?: Evidence[] };
                                    return freshEvaluation(request, [
                                        candidate,
                                        ...(context.selectedEvidence ?? []).flatMap((entry) => {
                                            const donor = candidates.get(entry.path);
                                            return donor ? [donor] : [];
                                        }),
                                    ]);
                                },
                            },
                            prepare: async () => {
                                if (input.signal.aborted) {
                                    throw new EvaluationFailure("cancelled");
                                }

                                const current = await unchanged(candidate);
                                if (input.signal.aborted) {
                                    throw new EvaluationFailure("cancelled");
                                }

                                if (!current) {
                                    return null;
                                }

                                return { evidence: await evidence?.() };
                            },
                            previous: files.get(candidate.path),
                        });
                    const selection = detailed ? await prof.measureAsync(`select ${candidate.path}`, run) : await run();
                    files.set(candidate.path, selection.file);
                    declarations.set(candidate.path, selection.declarations);
                    for (const entry of selection.issues) {
                        if (entry.kind !== "source-invalid") {
                            issue(entry.kind, entry.count, selection.providerFailure);
                        }
                    }
                });
            const selectEvidence = async (list: Candidate[]) => {
                await select(list);
                const evidence: Evidence[] = [];
                // Donors follow score, then path. Upstream uses completion order, so the same tree could send
                // a different context, and miss the cache, depending on which of 32 calls answered first.
                for (const candidate of sortedCandidates().filter((entry) => declarations.has(entry.path))) {
                    if (stop || input.signal.aborted) {
                        break;
                    }

                    if (!files.get(candidate.path)!.excerpts.length) {
                        continue;
                    }

                    // Context donors pass the same eligibility and hash check as target files.
                    if (!(await unchanged(candidate))) {
                        continue;
                    }

                    evidence.push(
                        ...files.get(candidate.path)!.excerpts.map((excerpt) => ({
                            path: candidate.path,
                            ...excerpt.range,
                            source: excerpt.source,
                        }))
                    );
                }

                if (evidence.length && jsonBytes(evidence) <= 64_000 && !stop && secondPassFits(list)) {
                    await select(list, async () => {
                        const current = new Set<string>();
                        for (const path of new Set(evidence.map((entry) => entry.path))) {
                            const candidate = candidates.get(path)!;
                            if (await unchanged(candidate)) {
                                current.add(path);
                            }
                        }

                        const fresh = evidence.filter((entry) => current.has(entry.path));
                        return fresh.length ? fresh : undefined;
                    });
                }
            };
            const assessments = new Map<string, { labels: string[]; priority: number }>();
            const assessFiles = (list: Candidate[]) =>
                parallel(list, async (candidate) => {
                    const source = await unchanged(candidate);
                    if (!source) {
                        return;
                    }

                    const preview = previews.get(candidate.path)!;
                    try {
                        const scores = await freshEvaluation(
                            fileAssessmentRequest(input.query, candidate.path, preview),
                            [candidate]
                        );
                        assessments.set(candidate.path, {
                            labels: Object.keys(scores).filter(
                                (role) => role !== "priority" && scores[role]! > KEEP_THRESHOLD
                            ),
                            priority: scores.priority!,
                        });
                    } catch (error) {
                        if (!(error instanceof EvaluationFailure && error.kind === "source-invalid")) {
                            const failure = failureKind(error);
                            issue(failure.kind, 1, failure.message);
                        }
                    }
                });
            let ordered = admitted;
            if (budget) {
                // Assess first: `priority` picks the files worth a complete selection within the budget.
                const assessed = [...admitted]
                    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
                    .slice(0, BUDGET_ASSESSED_FILES);
                await prof.measureAsync("assess", () => assessFiles(assessed));
                ordered = await affordableForSelection(assessed, assessments, budget);
                if (admitted.length > ordered.length) {
                    warn("budget_locations_only", admitted.length - ordered.length);
                }

                await prof.measureAsync("select", () => selectEvidence(ordered));
            } else {
                // File assessment reads only the discovery preview, so it runs beside evidence selection.
                await Promise.all([
                    prof.measureAsync("select", () => selectEvidence(ordered)),
                    prof.measureAsync("assess", () => assessFiles(ordered)),
                ]);
            }

            await parallel(ordered, async (candidate) => {
                const file = files.get(candidate.path);
                if (!file || file.sourceOmitted) {
                    return;
                }

                const current = await unchanged(candidate);
                if (!current) {
                    return;
                }

                if (assessments.get(candidate.path)?.labels.includes("test")) {
                    file.presentationExcerpts = file.selectedPresentationExcerpts ?? file.presentationExcerpts;
                    file.presentationSelected = file.selected;
                }

                try {
                    const context = await localCallContext(current, file);
                    if (context && (await unchanged(candidate)) && files.get(candidate.path) === file) {
                        Object.assign(file, context);
                    }
                } catch (error) {
                    if (input.signal.aborted) {
                        throw error;
                    }

                    // Optional structural context never discards already selected evidence.
                    log.debug({ path: candidate.path, error }, "Grep local call context failed");
                    issue("local-call-context");
                }
            });
            // Selection replaces file records, so roles attach afterwards; invalidated files keep none.
            for (const [path, assessment] of assessments) {
                const file = files.get(path)!;
                if (!file.sourceOmitted) {
                    file.roles = assessment.labels;
                    file.priority = assessment.priority;
                }
            }

            const testInputs: Array<{ snapshot: Snapshot; file: FileEvidence }> = [];
            for (const candidate of ordered) {
                const file = files.get(candidate.path)!;
                if (file.sourceOmitted || !file.roles.includes("test")) {
                    continue;
                }

                const current = await unchanged(candidate);
                if (current) {
                    testInputs.push({ snapshot: current, file });
                }
            }

            try {
                const changes = await selectTestBodies(testInputs);
                let current = true;
                for (const item of testInputs) {
                    const candidate = candidates.get(item.snapshot.path)!;
                    if (!(await unchanged(candidate)) || files.get(item.snapshot.path) !== item.file) {
                        current = false;
                    }
                }

                if (current) {
                    for (const { file, ...presentation } of changes) {
                        Object.assign(file, presentation);
                    }
                }
            } catch (error) {
                if (input.signal.aborted) {
                    throw input.signal.reason;
                }

                const failure = failureKind(error);
                issue(error instanceof EvaluationFailure ? failure.kind : "test-body-selection", 1, failure.message);
            }

            if (issues.has("authentication") && !files.size) {
                throw new EvaluationFailure("authentication");
            }
        } catch (error) {
            if (
                !input.signal.aborted ||
                (error !== input.signal.reason && !(error instanceof Error && error.name === "AbortError"))
            ) {
                throw error;
            }

            issue("cancelled");
        }

        // Cancellation can land before the selection phase creates admitted-file records.
        for (const candidate of candidates.values()) {
            if (!files.has(candidate.path)) {
                files.set(candidate.path, emptyEvidence(candidate));
            }
        }

        const context = await prof.measureAsync("context", () =>
            repositoryContext({
                reader,
                files: sortedCandidates().map((candidate) => files.get(candidate.path)!),
                readCurrent: (path) => unchanged(candidates.get(path)!),
            })
        );
        // File assessment may outlive the bytes it classified, for every language.
        for (const candidate of candidates.values()) {
            await unchanged(candidate);
        }

        const returned = sortedCandidates().map((candidate) => files.get(candidate.path)!);
        const result: RetrievalResult = {
            root: reader.root,
            query: input.query,
            status: input.signal.aborted ? "interrupted" : issues.size ? "incomplete" : "complete",
            files: returned,
            repositoryContext: withCurrentTestCommands(context, returned),
            issues: [...issues].map(([kind, count]) => ({ kind, count })),
            // Budget warnings say what the budget left out; like cache warnings, they never flip the status.
            warnings: warnings.size
                ? [...(evaluator.cacheIssues ?? []), ...[...warnings].map(([kind, count]) => ({ kind, count }))]
                : evaluator.cacheIssues,
            providerFailure,
            counts: {
                requests: evaluator.requests,
                cacheHits: evaluator.cacheHits ?? 0,
                inspectedFiles: inspected.size,
                ...evaluator.spend,
            },
            ...(evaluator.provider ? { provider: evaluator.provider } : {}),
            ...(evaluator.model ? { model: evaluator.model } : {}),
        };
        log.info(
            {
                provider: evaluator.provider,
                model: evaluator.model,
                status: result.status,
                files: result.files.length,
                issues: result.issues,
                warnings: result.warnings,
                counts: result.counts,
                scores: result.files.map((file) => ({ path: file.path, score: file.score, priority: file.priority })),
            },
            "Jev grep retrieval finished"
        );
        return result;
    } finally {
        await reader.close();
    }
}
