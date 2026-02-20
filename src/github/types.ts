// GitHub Tool Types

export interface GitHubUrl {
    owner: string;
    repo: string;
    type: "issue" | "pr" | "comment";
    number: number;
    commentId?: number;
}

export interface RepoRecord {
    id: number;
    owner: string;
    name: string;
}

export interface IssueRecord {
    id: number;
    repo_id: number;
    number: number;
    type: "issue" | "pr";
    title: string;
    body: string;
    state: string;
    author: string;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    last_fetched: string;
    last_comment_cursor: string | null;
}

export interface CommentRecord {
    id: string;
    issue_id: number;
    author: string;
    body: string;
    created_at: string;
    updated_at: string;
    reaction_count: number;
    reactions_json: string;
    is_bot: number;
}

export interface TimelineEventRecord {
    id: string;
    issue_id: number;
    event_type: string;
    actor: string;
    created_at: string;
    data_json: string;
}

/**
 * Parsed GitHub file URL
 */
export interface GitHubFileUrl {
    owner: string;
    repo: string;
    path: string;
    ref: string;
    lineStart?: number;
    lineEnd?: number;
}

export interface FetchMetadataRecord {
    id: number;
    issue_id: number;
    last_full_fetch: string | null;
    last_incremental_fetch: string | null;
    total_comments: number;
    last_comment_date: string | null;
}

// API Response types

export interface GitHubIssue {
    id: number;
    node_id: string;
    number: number;
    title: string;
    body: string | null;
    state: string;
    user: GitHubUser | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    labels: GitHubLabel[];
    assignees: GitHubUser[];
    milestone: GitHubMilestone | null;
    comments: number;
    pull_request?: { url: string };
    reactions?: GitHubReactions;
}

export interface GitHubPullRequest extends GitHubIssue {
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { ref: string; sha: string; repo: { full_name: string } | null };
    merged: boolean;
    merged_at: string | null;
    merged_by: GitHubUser | null;
    draft: boolean;
    mergeable: boolean | null;
    mergeable_state: string;
    additions: number;
    deletions: number;
    changed_files: number;
}

export interface GitHubUser {
    login: string;
    id: number;
    type: string;
}

export interface GitHubLabel {
    name: string;
    color: string;
    description: string | null;
}

export interface GitHubMilestone {
    number: number;
    title: string;
    state: string;
}

export interface GitHubComment {
    id: number;
    node_id: string;
    body: string;
    user: GitHubUser | null;
    created_at: string;
    updated_at: string;
    reactions?: GitHubReactions;
    html_url: string;
}

export interface GitHubReviewComment extends GitHubComment {
    path: string;
    diff_hunk: string;
    position: number | null;
    original_position: number | null;
    commit_id: string;
    line: number | null;
    side: string;
    in_reply_to_id?: number;
}

export interface GitHubReactions {
    total_count: number;
    "+1": number;
    "-1": number;
    laugh: number;
    hooray: number;
    confused: number;
    heart: number;
    rocket: number;
    eyes: number;
}

export interface GitHubTimelineEvent {
    id: number;
    node_id: string;
    event: string;
    actor: GitHubUser | null;
    created_at: string;
    commit_id?: string;
    commit_url?: string;
    label?: GitHubLabel;
    assignee?: GitHubUser;
    assigner?: GitHubUser;
    milestone?: GitHubMilestone;
    rename?: { from: string; to: string };
    source?: { type: string; issue: { number: number; title: string; state: string } };
}

// Command options

export interface IssueCommandOptions {
    repo?: string;
    comments?: boolean;
    limit?: number;
    all?: boolean;
    first?: number;
    last?: number;
    since?: string;
    after?: string;
    before?: string;
    minReactions?: number;
    minReactionsPositive?: number;
    minReactionsNegative?: number;
    minCommentReactions?: number;
    minCommentReactionsPositive?: number;
    minCommentReactionsNegative?: number;
    author?: string;
    noBots?: boolean;
    includeEvents?: boolean;
    resolveRefs?: boolean;
    noResolveRefs?: boolean;
    full?: boolean;
    refresh?: boolean;
    saveLocally?: boolean;
    format?: "ai" | "md" | "json";
    output?: string;
    stats?: boolean;
    noIndex?: boolean;
    verbose?: boolean;
}

export interface PRCommandOptions extends IssueCommandOptions {
    reviewComments?: boolean;
    reviews?: boolean;
    diff?: boolean;
    commits?: boolean;
    checks?: boolean;
    verbose?: boolean;
}

export interface SearchCommandOptions {
    type?: "issue" | "pr" | "all" | "repo";
    repo?: string;
    state?: "open" | "closed" | "all";
    sort?: string;
    limit?: number;
    format?: "ai" | "md" | "json";
    output?: string;
    verbose?: boolean;
    advanced?: boolean;
    legacy?: boolean;
    minReactions?: number;
    minCommentReactions?: number;
    language?: string;
    minStars?: number;
}

// Output data structures

export interface IssueData {
    owner: string;
    repo: string;
    issue: GitHubIssue;
    comments: CommentData[];
    events: TimelineEventData[];
    stats?: CommentStats;
    linkedIssues?: LinkedIssue[];
    fetchedAt: string;
    cacheCursor?: string;
}

export interface PRData extends IssueData {
    pr: GitHubPullRequest;
    reviewComments?: ReviewCommentData[];
    reviewThreads?: ParsedReviewThread[];
    reviewThreadStats?: ReviewThreadStats;
    commits?: CommitData[];
    checks?: CheckData[];
    diff?: string;
}

export interface CommentData {
    id: number;
    nodeId: string;
    author: string;
    body: string;
    createdAt: string;
    updatedAt: string;
    reactions: GitHubReactions;
    isBot: boolean;
    htmlUrl: string;
    replyTo?: number;
    quotedText?: string;
}

export interface ReviewCommentData extends CommentData {
    path: string;
    diffHunk: string;
    line: number | null;
    side: string;
}

export interface TimelineEventData {
    id: string;
    event: string;
    actor: string;
    createdAt: string;
    details: string;
}

export interface CommitData {
    sha: string;
    message: string;
    author: string;
    date: string;
}

export interface CheckData {
    name: string;
    status: string;
    conclusion: string | null;
}

export interface CommentStats {
    total: number;
    shown: number;
    uniqueAuthors: number;
    authorBreakdown: { author: string; count: number }[];
    totalReactions: number;
    reactionBreakdown: Record<string, number>;
    botComments: number;
    dateRange: { start: string; end: string };
}

export interface LinkedIssue {
    number: number;
    title: string;
    state: string;
    linkType: "fixes" | "closes" | "related";
}

// Review Thread types (GraphQL-based)

export interface ReviewThread {
    id: string;
    isResolved: boolean;
    path: string;
    line: number | null;
    startLine: number | null;
    comments: ReviewThreadComment[];
}

export interface ReviewThreadComment {
    id: string;
    author: string;
    body: string;
    createdAt: string;
    diffHunk: string | null;
}

export interface ParsedReviewThread {
    threadId: string;
    threadNumber: number;
    status: "resolved" | "unresolved";
    severity: "high" | "medium" | "low";
    file: string;
    line: number | null;
    startLine: number | null;
    author: string;
    title: string;
    issue: string;
    diffHunk: string | null;
    suggestedCode: string | null;
    firstCommentId: string;
    replies: { author: string; body: string; id: string }[];
}

export interface ReviewThreadStats {
    total: number;
    resolved: number;
    unresolved: number;
    high: number;
    medium: number;
    low: number;
}

export interface ReviewData {
    owner: string;
    repo: string;
    prNumber: number;
    title: string;
    state: string;
    threads: ParsedReviewThread[];
    stats: ReviewThreadStats;
}

export interface ReviewCommandOptions {
    repo?: string;
    unresolvedOnly?: boolean;
    groupByFile?: boolean;
    md?: boolean;
    json?: boolean;
    respond?: string;
    threadId?: string;
    resolveThread?: boolean;
    resolve?: boolean;
    verbose?: boolean;
}

export interface RepoSearchResult {
    name: string;
    description: string | null;
    language: string | null;
    stars: number;
    forks: number;
    openIssues: number;
    topics: string[];
    archived: boolean;
    url: string;
    pushedAt: string;
    createdAt: string;
    license: string | null;
}

// Search results

export interface SearchResult {
    type: "issue" | "pr";
    number: number;
    title: string;
    state: string;
    author: string;
    createdAt: string;
    updatedAt: string;
    comments: number;
    reactions: number;
    repo: string;
    url: string;
    source?: "advanced" | "legacy" | "both";
}

// ============================================
// Notification Types
// ============================================

export type NotificationReason =
    | "approval_requested"
    | "assign"
    | "author"
    | "ci_activity"
    | "comment"
    | "invitation"
    | "manual"
    | "member_feature_requested"
    | "mention"
    | "review_requested"
    | "security_alert"
    | "security_advisory_credit"
    | "state_change"
    | "subscribed"
    | "team_mention";

export type NotificationSubjectType = "Issue" | "PullRequest" | "Release" | "Discussion" | "CheckSuite" | "Commit";

export interface GitHubNotification {
    id: string;
    unread: boolean;
    reason: NotificationReason;
    updated_at: string;
    last_read_at: string | null;
    subject: {
        title: string;
        url: string | null;
        latest_comment_url: string | null;
        type: NotificationSubjectType;
    };
    repository: {
        id: number;
        full_name: string;
        html_url: string;
        owner: { login: string };
        name: string;
    };
    url: string;
    subscription_url: string;
}

export interface NotificationItem {
    id: string;
    title: string;
    repo: string;
    reason: NotificationReason;
    type: NotificationSubjectType;
    unread: boolean;
    updatedAt: string;
    webUrl: string;
    number: number | null;
}

export interface NotificationsCommandOptions {
    reason?: string;
    repo?: string;
    titleMatch?: string;
    since?: string;
    author?: string;
    state?: "read" | "unread" | "all";
    participating?: boolean;
    type?: string;
    open?: boolean;
    markRead?: boolean;
    markDone?: boolean;
    limit?: number;
    format?: "ai" | "md" | "json";
    output?: string;
    verbose?: boolean;
}

// ============================================
// Activity Types
// ============================================

export interface GitHubEvent {
    id: string;
    type: string;
    actor: { login: string; display_login: string };
    repo: { name: string };
    payload: Record<string, unknown>;
    created_at: string;
    public: boolean;
}

export interface ActivityItem {
    id: string;
    type: string;
    actor: string;
    repo: string;
    summary: string;
    createdAt: string;
    url: string | null;
}

export interface ActivityCommandOptions {
    user?: string;
    received?: boolean;
    repo?: string;
    type?: string;
    since?: string;
    limit?: number;
    format?: "ai" | "md" | "json";
    output?: string;
    verbose?: boolean;
}
