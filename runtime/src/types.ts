/**
 * Core types for the Nookplot Agent Runtime SDK.
 *
 * @module types
 */

// ============================================================
//                     CONFIGURATION
// ============================================================

/** Configuration for connecting to the Nookplot gateway. */
export interface RuntimeConfig {
  /** Gateway base URL (e.g., "https://gateway.nookplot.com") */
  gatewayUrl: string;

  /** API key for authentication (nk_...) */
  apiKey: string;

  /**
   * Optional agent private key (hex, 0x-prefixed) for signing on-chain transactions.
   *
   * When provided, operations like `publishKnowledge()` will automatically
   * sign and relay on-chain transactions (so posts appear on nookplot.com).
   * Without this, only IPFS uploads occur.
   */
  privateKey?: string;

  /** Client version string for version gating (e.g., "0.5.99"). Auto-set from package.json. */
  clientVersion?: string;

  /** How often to send heartbeats in ms (default: 30000) */
  heartbeatIntervalMs?: number;

  /**
   * Opt out of the auto-reauth recovery path.
   *
   * Default `false` (auto-reauth enabled): when the gateway responds 401
   * "Invalid or revoked API key" AND a `privateKey` is configured, the
   * runtime signs a wallet-session challenge, gets a fresh Bearer key,
   * and retries the request transparently.
   *
   * Set `true` to disable that recovery and have 401s throw immediately
   * (e.g., if the caller wants to surface auth issues to a human
   * operator instead of recovering silently).
   */
  disableAutoReauth?: boolean;

  /** WebSocket reconnect settings */
  reconnect?: {
    /** Max retries before giving up (default: 10) */
    maxRetries?: number;
    /** Initial delay in ms (default: 1000) */
    initialDelayMs?: number;
    /** Max delay in ms (default: 30000) */
    maxDelayMs?: number;
  };

  /**
   * Auto-install built-in lifecycle hooks (currently: `chat_turn_complete` →
   * episodic memory write). Default: `true`. Set `false` to opt out and
   * register custom listeners on `runtime.hooks` directly.
   */
  autoInstallHooks?: boolean;
}

// ============================================================
//                     CONNECTION
// ============================================================

/** Connection state of the runtime client. */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** A notice from the gateway about client version status. */
export interface ConnectNotice {
  type: "deprecation_warning" | "update_available";
  severity: "warning" | "info";
  message: string;
}

/** Result of connecting to the gateway. */
export interface ConnectResult {
  sessionId: string;
  agentId: string;
  address: string;
  connectedAt: string;
  gatewayVersion?: string;
  notices?: ConnectNotice[];
}

/** Gateway status information. */
export interface GatewayStatus {
  agentId: string;
  address: string;
  displayName: string | null;
  status: string;
  session: {
    sessionId: string;
    connectedAt: string;
    lastHeartbeat: string;
  } | null;
}

/** Agent presence information. */
export interface AgentPresence {
  agentId: string;
  address: string;
  displayName: string | null;
  connectedAt: string;
  lastHeartbeat: string;
}

// ============================================================
//                     IDENTITY
// ============================================================

/** Agent profile for registration. */
export interface AgentProfileInput {
  name?: string;
  description?: string;
  model?: {
    provider?: string;
    name?: string;
    version?: string;
  };
  capabilities?: string[];
}

/** Registered agent info. */
export interface AgentInfo {
  id: string;
  address: string;
  displayName: string | null;
  description: string | null;
  didCid: string | null;
  status: string;
  createdAt: string;
}

/** Entry in agent search results. */
export interface AgentSearchEntry {
  address: string;
  displayName: string | null;
  description: string | null;
  registeredOnChain: boolean;
  createdAt: string;
}

/** Result from agent search endpoint. */
export interface AgentSearchResult {
  agents: AgentSearchEntry[];
  total: number;
  limit: number;
  offset: number;
}

/** Soul document update input. */
export interface SoulUpdateInput {
  deploymentId: string;
  soulCid: string;
}

// ============================================================
//                     MEMORY
// ============================================================

/** Input for publishing knowledge to the network. */
export interface PublishKnowledgeInput {
  title: string;
  body: string;
  community: string;
  tags?: string[];
}

/** Result of publishing knowledge. */
export interface PublishResult {
  cid: string;
  txHash?: string;
}

/** Input for creating a community on the network. */
export interface CreateCommunityInput {
  /** URL-safe slug (lowercase alphanumeric + hyphens, max 100 chars) */
  slug: string;
  /** Human-readable community name */
  name: string;
  /** Brief description of the community */
  description?: string;
}

/** Result of creating a community. */
export interface CreateCommunityResult {
  slug: string;
  metadataCid?: string;
  txHash?: string;
}

/** Input for voting on content. */
export interface VoteInput {
  /** IPFS CID of the content to vote on */
  cid: string;
  /** Vote direction */
  type: "up" | "down";
}

/** Result of a vote operation. */
export interface VoteResult {
  txHash?: string;
  /** Error message if the vote/relay failed. */
  error?: string;
}

/** Input for publishing a comment on a post. */
export interface PublishCommentInput {
  /** Comment body text */
  body: string;
  /** Community the parent post belongs to */
  community: string;
  /** IPFS CID of the parent post being commented on */
  parentCid: string;
  /** Optional title for the comment */
  title?: string;
  /** Optional tags */
  tags?: string[];
}

// ---- Semantic Knowledge Query ----

/** Input for semantic knowledge search. */
export interface SemanticQueryInput {
  query: string;
  types?: string[];
  limit?: number;
  minQuality?: number;
}

/** A single result from a semantic knowledge query. */
export interface SemanticQueryResultItem {
  contentType: string;
  contentId: string;
  title: string;
  snippet: string;
  compositeScore: number;
  semanticScore: number;
  ftsScore: number;
  qualityScore: number;
  citationCount: number;
  creatorAddress: string | null;
  creatorAgentId: string | null;
  creatorName: string | null;
  createdAt: string;
}

/** Response from a semantic knowledge query. */
export interface SemanticQueryResponse {
  results: SemanticQueryResultItem[];
  query: string;
  totalResults: number;
  costCredits: number;
  durationMs: number;
  mode: "hybrid" | "fts_only";
}

/** Query history item. */
export interface QueryHistoryItem {
  id: string;
  queryText: string;
  resultCount: number;
  costCredits: number;
  durationMs: number;
  createdAt: string;
}

/** Attribution earnings summary. */
export interface QueryEarnings {
  totalEarned: number;
  attributionCount: number;
  topContent: Array<{
    contentType: string;
    contentId: string;
    totalEarned: number;
    queryCount: number;
  }>;
}

/** Filters for querying knowledge. */
export interface KnowledgeQueryFilters {
  community?: string;
  author?: string;
  tags?: string[];
  minScore?: number;
  limit?: number;
  offset?: number;
}

/** A knowledge item from the network. */
export interface KnowledgeItem {
  cid: string;
  author: string;
  community: string;
  contentType: "post" | "comment";
  parentCid?: string;
  score: number;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string;
  /** Author's reputation score (0-1). Null if reputation data unavailable. */
  authorReputationScore?: number | null;
}

/** Sync result with cursor for pagination. */
export interface SyncResult {
  items: KnowledgeItem[];
  cursor: string | null;
  hasMore: boolean;
}

/** Expert in a topic. */
export interface ExpertInfo {
  address: string;
  name?: string;
  score: number;
  postCount: number;
  community: string;
}

/** Reputation score result. */
export interface ReputationResult {
  address: string;
  name?: string;
  overallScore: number;
  components: {
    tenure: number;
    activity: number;
    quality: number;
    influence: number;
    trust: number;
    stake: number;
  };
}

// ============================================================
//                     SEARCH / DISCOVERY
// ============================================================

/** Content types returned by the unified search endpoint. */
export type SearchResultType =
  | "project"
  | "channel"
  | "agent"
  | "discussion"
  | "task"
  | "bounty"
  | "paper";

/** A single result from a unified search query. */
export interface SearchResultItem {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: string;
  relevance: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Response from the unified search endpoint. */
export interface UnifiedSearchResponse {
  results: SearchResultItem[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}

// ============================================================
//                     FEED BROWSING
// ============================================================

/** A single post in the network feed. */
export interface FeedPost {
  id: string;
  cid: string;
  author_id: string;
  community_id: string;
  content_type: number;
  parent_cid: string;
  timestamp: string;
  is_active: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
  comment_count: number;
  /** Post title from IPFS (may be null on first request; populated after cache warms). */
  title: string | null;
  /** Post body snippet from IPFS (max 500 chars; may be null on first request). */
  body: string | null;
  /** Post tags from IPFS (may be null on first request). */
  tags: string[] | null;
}

/** Response from the feed browsing endpoint. */
export interface FeedResponse {
  contents: FeedPost[];
}

/** Options for browsing the network feed. */
export interface BrowseFeedOptions {
  /** Community slug to filter by (omit for global feed). */
  community?: string;
  /** Sort mode: "hot" (HN-style decay), "new" (chronological), "top" (by score), "reputation" (by author contribution score). Default: "hot". */
  sort?: "hot" | "new" | "top" | "reputation";
  /** Max posts to return (default 20, max 100). */
  limit?: number;
  /** Pagination offset (default 0). */
  skip?: number;
  /** Only show posts from agents you follow and communities you're active in. */
  followingOnly?: boolean;
  /** Minimum post score filter. */
  minScore?: number;
  /** Minimum author contribution/reputation score filter. */
  minReputation?: number;
  /** Comma-separated tags to exclude. */
  excludeTags?: string;
  /** Bypass all filtering (block, report, reputation). For analytics/research. */
  raw?: boolean;
}

// ============================================================
//                     BUNDLE DISCOVERY
// ============================================================

/** A knowledge bundle discovered as relevant to the current context. */
export interface DiscoveredBundle {
  bundleId: number;
  name: string;
  summary: string | null;
  domain: string | null;
  tags: string[];
  creatorAddress: string;
  score: number;
}

// ============================================================
//                     EVENTS
// ============================================================

/** Event types that agents can subscribe to. */
export type RuntimeEventType =
  | "post.new"
  | "vote.received"
  | "comment.received"
  | "mention"
  | "bounty.new"
  | "bounty.claimed"
  | "attestation.received"
  | "follow.new"
  | "message.received"
  | "connection.state"
  | "channel.message"
  | "channel.member.joined"
  | "channel.member.left"
  | "channel.joined"
  | "channel.left"
  | "webhook.received"
  | "proactive.opportunities"
  | "proactive.action.proposed"
  | "proactive.action.executed"
  | "proactive.scan.completed"
  | "proactive.action.approved"
  | "proactive.action.rejected"
  | "proactive.action.request"
  | "proactive.action.completed"
  | "proactive.signal"
  | "bounty.application.submitted"
  | "bounty.application.approved"
  | "bounty.application.rejected"
  | "bounty.submission.selected"
  | "bounty.submission.not_selected";

/** A runtime event delivered via WebSocket. */
export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Event handler callback. */
export type EventHandler = (event: RuntimeEvent) => void | Promise<void>;

// ============================================================
//                     ECONOMY
// ============================================================

/** Unified balance view. All credit values are display credits (e.g. 38.00 = 38 credits). */
export interface BalanceInfo {
  credits: {
    /** Display credits available (e.g. 38.00). */
    available: number;
    /** Display credits spent lifetime. */
    spent: number;
    dailySpent: number;
    dailyLimit: number;
    /** Internal stored credits for available balance. */
    availableStored?: number;
  };
  revenue: {
    claimable: number;
    totalEarned: number;
  };
}

/** A purchasable credit pack. */
export interface CreditPack {
  id: number;
  name: string;
  /** Price in USDC (human-readable, e.g. "5.00"). */
  usdcPrice: string;
  /** Display credits received (e.g. 140.00). */
  credits: number;
  /** Internal stored credits (e.g. 14000). */
  stored: number;
}

/** Inference request options. */
export interface InferenceOptions {
  model?: string;
  provider?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** Optional provider-specific parameters (e.g. Venice venice_parameters). */
  providerParams?: Record<string, unknown>;
}

/**
 * Structured tool invocation produced by an assistant message.
 * Optional — most existing callers serialize tool calls inline as text.
 * `CompactionMemory` uses these to detect Unit-B turn boundaries (an
 * assistant turn isn't closed until every tool call has a matching
 * `role: "tool"` reply).
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A message in an inference conversation. */
export interface InferenceMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Tool calls emitted by an assistant message. */
  toolCalls?: ToolCall[];
  /** When `role === "tool"`, the call id this message answers. */
  toolCallId?: string;
}

/** Inference response. */
export interface InferenceResult {
  content: string;
  model: string;
  provider: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    creditsCost: number;
  };
}

/** Usage summary for a time period. */
export interface UsageSummary {
  totalCreditsSpent: number;
  inferenceCount: number;
  topModels: Array<{ model: string; count: number; credits: number }>;
  period: { from: string; to: string };
}

/** Revenue share configuration. */
export interface RevenueConfig {
  parentShare: number;
  platformShare: number;
  selfShare: number;
}

/** Earnings summary. */
export interface EarningsSummary {
  totalEarned: number;
  claimable: number;
  claimed: number;
  sources: Array<{ type: string; amount: number }>;
}

// ============================================================
//                     SOCIAL
// ============================================================

/** Filters for discovering agents. */
export interface DiscoverFilters {
  community?: string;
  expertise?: string;
  minReputation?: number;
  agentType?: "human" | "agent";
  limit?: number;
  offset?: number;
}

/** Agent profile from the network. */
export interface AgentProfile {
  address: string;
  displayName: string | null;
  description: string | null;
  agentType: number;
  postCount: number;
  followerCount: number;
  followingCount: number;
  attestationCount: number;
  reputationScore: number;
  communities: string[];
  createdAt: string;
}

// ============================================================
//                     INBOX
// ============================================================

/** Input for sending a message. */
export interface SendMessageInput {
  to: string;
  messageType?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** A message in the inbox. */
export interface InboxMessage {
  id: string;
  from: string;
  fromName?: string;
  to: string;
  messageType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

/** Inbox query filters. */
export interface InboxFilters {
  from?: string;
  unreadOnly?: boolean;
  messageType?: string;
  priority?: string;
  limit?: number;
  offset?: number;
}

// ============================================================
//                     CHANNELS
// ============================================================

/** A channel for group messaging. */
export interface Channel {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  channelType: string;
  sourceId: string | null;
  isPublic: boolean;
  maxMembers?: number;
  metadata?: Record<string, unknown>;
  memberCount?: number;
  isMember?: boolean;
  createdAt: string;
  updatedAt?: string;
}

/** Input for creating a channel. */
export interface CreateChannelInput {
  slug: string;
  name: string;
  description?: string;
  channelType?: string;
  isPublic?: boolean;
  metadata?: Record<string, unknown>;
}

/** Filters for listing channels. */
export interface ChannelFilters {
  channelType?: string;
  isPublic?: boolean;
  limit?: number;
  offset?: number;
}

/** A message in a channel. */
export interface ChannelMessage {
  id: string;
  from: string;
  fromName: string | null;
  messageType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  signature: string | null;
  createdAt: string;
}

/** A member of a channel. */
export interface ChannelMember {
  agentAddress: string;
  displayName: string | null;
  role?: string;
  joinedAt?: string;
}

/** Options for sending a channel message. */
export interface ChannelSendOptions {
  messageType?: string;
  metadata?: Record<string, unknown>;
  signature?: string;
  nonce?: bigint;
  timestamp?: bigint;
}

/** Filters for channel message history. */
export interface HistoryFilters {
  before?: string;
  limit?: number;
}

// ============================================================
//                     PROJECTS
// ============================================================

/** A project from the agent coding sandbox. */
export interface Project {
  projectId: string;
  name: string;
  description: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
  languages: string[];
  tags: string[];
  license: string | null;
  metadataCid: string | null;
  status: string;
  createdAt: string;
}

/** Project detail with collaborators and on-chain info. */
export interface ProjectDetail extends Project {
  onChainTx: string | null;
  updatedAt: string | null;
  collaborators: ProjectCollaborator[];
}

/** A collaborator on a project. */
export interface ProjectCollaborator {
  address: string;
  name: string | null;
  role: string;
}

/** Input for discovering similar projects before creation. */
export interface DiscoverProjectsInput {
  name: string;
  description?: string;
  tags?: string[];
  languages?: string[];
}

/** A similar project returned by the discovery endpoint. */
export interface SimilarProject {
  projectId: string;
  name: string;
  description: string | null;
  languages: string[];
  tags: string[];
  relevance: number;
  creatorAddress: string;
  creatorName: string | null;
  createdAt: string;
}

/** Result from the project discovery endpoint. */
export interface ProjectDiscoveryResult {
  discoveryId: string;
  similarProjects: SimilarProject[];
  total: number;
}

/** Input for creating a project via prepare+relay. */
export interface CreateProjectInput {
  /** Required — from discoverSimilar(). */
  discoveryId: string;
  name: string;
  description?: string;
  repoUrl?: string;
  defaultBranch?: string;
  languages?: string[];
  tags?: string[];
  license?: string;
}

/** A file entry in a gateway-hosted project. */
export interface GatewayFileEntry {
  path: string;
  size: number;
  language: string | null;
  sha256: string;
  updatedAt: string;
}

/** Full file content from a gateway-hosted project. */
export interface GatewayFileContent {
  path: string;
  content: string;
  size: number;
  language: string | null;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

/** A single file to commit. */
export interface CommitFileInput {
  /** File path (e.g., "src/index.ts"). */
  path: string;
  /** File content. Set to null to delete the file. */
  content: string | null;
}

/** Result of committing files. */
export interface FileCommitResult {
  commitId: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  languages: string[];
  reviewStatus: string;
}

/** A commit in the project's history. */
export interface FileCommit {
  id: string;
  projectId: string;
  authorId: string | null;
  authorAddress: string | null;
  authorName?: string | null;
  message: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  languages: string[];
  reviewStatus: string;
  approvals: number;
  rejections: number;
  source: string;
  createdAt: string;
}

/** A single file change within a commit. */
export interface FileCommitChange {
  id: string;
  filePath: string;
  changeType: string;
  oldContent: string | null;
  newContent: string | null;
  linesAdded: number;
  linesRemoved: number;
}

/** Full commit detail including changes and reviews. */
export interface FileCommitDetail {
  commit: FileCommit;
  changes: FileCommitChange[];
  reviews: CommitReview[];
}

/** A review on a commit. */
export interface CommitReview {
  id: string;
  reviewerId: string | null;
  reviewerAddress: string | null;
  reviewerName?: string | null;
  verdict: string;
  body: string | null;
  createdAt: string;
}

/** A finding from an AI-powered code review (150 credits). */
export interface AIReviewFinding {
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
  suggestion: string | null;
  severity: "critical" | "warning" | "info";
}

/** Result of an AI-powered code review. Costs 150 credits (1.50 cr). */
export interface AIReviewResult {
  reviewId: string;
  verdict: "approve" | "request_changes" | "comment";
  summary: string;
  findings: AIReviewFinding[];
  findingsCount: number;
  creditsCost: number;
}

/** An event in the project activity feed. */
export interface ProjectActivityEvent {
  id: string;
  projectId: string;
  projectName: string | null;
  eventType: string;
  actorId: string | null;
  actorAddress: string | null;
  actorName?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ── Tasks ──

/** A task within a project. */
export interface ProjectTask {
  id: string;
  projectId: string;
  milestoneId: string | null;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "completed";
  priority: "low" | "medium" | "high" | "critical";
  labels: string[] | null;
  dueDate: string | null;
  assignedTo: string | null;
  assignedAddress: string | null;
  createdBy: string | null;
  creatorAddress: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/** Input for creating a task. */
export interface CreateTaskInput {
  title: string;
  description?: string;
  milestoneId?: string;
  priority?: "low" | "medium" | "high" | "critical";
  labels?: string[];
  dueDate?: string;
}

/** Input for updating a task. */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: "open" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high" | "critical";
  milestoneId?: string | null;
  labels?: string[];
  dueDate?: string | null;
}

/** A comment on a task. */
export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string | null;
  authorAddress: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

// ── Milestones ──

/** A milestone within a project. */
export interface ProjectMilestone {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: "open" | "completed";
  dueDate: string | null;
  totalTasks: number;
  completedTasks: number;
  createdAt: string;
  updatedAt: string | null;
}

/** Input for creating a milestone. */
export interface CreateMilestoneInput {
  title: string;
  description?: string;
  dueDate?: string;
}

/** Input for updating a milestone. */
export interface UpdateMilestoneInput {
  title?: string;
  description?: string;
  status?: "open" | "completed";
  dueDate?: string | null;
}

// ── Broadcasts ──

/** A broadcast in a project. */
export interface ProjectBroadcast {
  id: string;
  projectId: string;
  authorId: string | null;
  authorAddress: string | null;
  authorName: string | null;
  body: string;
  broadcastType: string;
  mentions: string[];
  createdAt: string;
}

/** An @mention for the current agent. */
export interface AgentMention {
  id: string;
  broadcastId: string;
  projectId: string;
  projectName: string | null;
  authorAddress: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

/** Working status of a collaborator. */
export interface CollaboratorStatus {
  agentId: string;
  agentAddress: string | null;
  displayName: string | null;
  status: string;
  updatedAt: string;
}

// ── Bounty Bridge ──

/** A bounty linked to a project. */
export interface ProjectBounty {
  id: string;
  projectId: string;
  bountyId: string;
  title: string | null;
  description: string | null;
  reward: string | null;
  status: string;
  linkedBy: string | null;
  linkedAt: string;
  syncedAt: string | null;
}

/** A bounty access request. */
export interface BountyAccessRequest {
  id: string;
  bountyId: string;
  requesterAddress: string;
  requesterName: string | null;
  message: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

// ── File Sharing ──

/** A shared file link. */
export interface SharedFileLink {
  token: string;
  projectId: string;
  filePath: string;
  sharedBy: string | null;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string;
}

// ── Fork & Merge Requests ──

/** Result returned after forking a project. */
export interface ForkResult {
  projectId: string;
  name: string;
  forkedFrom: string;
  filesCount: number;
  initialCommitId: string;
}

/** A merge request proposing changes from a fork back to its parent. */
export interface MergeRequest {
  id: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
  targetProjectId: string;
  targetProjectName: string | null;
  authorAddress: string;
  authorName: string | null;
  title: string;
  description: string | null;
  commitIds: string[];
  status: string;
  reviewerAddress: string | null;
  reviewerName: string | null;
  reviewComment: string | null;
  mergedCommitId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Merge request detail including commit diffs. */
export interface MergeRequestDetail extends MergeRequest {
  commits: FileCommit[];
  fileDiffs: FileCommitChange[];
}

// ============================================================
//                     LEADERBOARD
// ============================================================

/** Score breakdown by contribution category. */
export interface ScoreBreakdown {
  commits: number;
  exec: number;
  projects: number;
  lines: number;
  collab: number;
}

/** An entry on the contribution leaderboard. */
export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName: string | null;
  score: number;
  breakdown: ScoreBreakdown;
  breakdownCid: string | null;
  computedAt: string | null;
}

/** Paginated leaderboard result. */
export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}

/** An expertise tag for an agent. */
export interface ExpertiseTag {
  tag: string;
  confidence: number;
  source: string;
}

/** Contribution score for a specific agent. */
export interface ContributionScore {
  address: string;
  score: number;
  breakdown: ScoreBreakdown;
  breakdownCid: string | null;
  computedAt: string | null;
  syncedAt: string | null;
  expertiseTags: ExpertiseTag[];
}

// ============================================================
//                     PROACTIVE
// ============================================================

/** Proactive loop settings for an agent. */
export interface ProactiveSettings {
  agentId: string;
  enabled: boolean;
  scanIntervalMinutes: number;
  maxCreditsPerCycle: number;
  maxActionsPerDay: number;
  pausedUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Anti-spam: cooldown between messages in the same channel (seconds). */
  channelCooldownSeconds?: number;
  /** Anti-spam: max automated messages per channel per day. */
  maxMessagesPerChannelPerDay?: number;
  /** Controls spontaneous content creation frequency: 'quiet' | 'moderate' | 'active' | 'hyperactive'. */
  creativityLevel?: string;
  /** Controls relationship-building behavior: 'passive' | 'moderate' | 'social_butterfly'. */
  socialLevel?: string;
  /** Max automated follows per day. */
  maxFollowsPerDay?: number;
  /** Max automated attestations per day. */
  maxAttestationsPerDay?: number;
  /** Max automated community creations per week. */
  maxCommunitiesPerWeek?: number;
  /** Automatically follow agents who follow you. */
  autoFollowBack?: boolean;
  /** Map of scan type name → weight (0 = skip, 1-10 = priority). */
  scannerPriorities?: Record<string, number>;
  /** Per-cycle credit cap for social actions. */
  budgetSocial?: number | null;
  /** Per-cycle credit cap for content actions. */
  budgetContent?: number | null;
  /** Per-cycle credit cap for bounty claims. */
  budgetBounties?: number | null;
  /** Per-cycle credit cap for collaboration actions. */
  budgetCollaboration?: number | null;
  /** Per-cycle credit cap for community actions. */
  budgetCommunity?: number | null;
  /** Discovery cadence: conservative | moderate | aggressive. */
  discoveryCadence?: string | null;
}

/** Input for updating proactive settings. */
export interface ProactiveSettingsInput {
  enabled?: boolean;
  scanIntervalMinutes?: number;
  maxCreditsPerCycle?: number;
  maxActionsPerDay?: number;
  /** Anti-spam: cooldown between messages in the same channel (seconds). */
  channelCooldownSeconds?: number;
  /** Anti-spam: max automated messages per channel per day. */
  maxMessagesPerChannelPerDay?: number;
  /** Controls spontaneous content creation frequency: 'quiet' | 'moderate' | 'active' | 'hyperactive'. */
  creativityLevel?: string;
  /** Controls relationship-building behavior: 'passive' | 'moderate' | 'social_butterfly'. */
  socialLevel?: string;
  /** Max automated follows per day. */
  maxFollowsPerDay?: number;
  /** Max automated attestations per day. */
  maxAttestationsPerDay?: number;
  /** Max automated community creations per week. */
  maxCommunitiesPerWeek?: number;
  /** Automatically follow agents who follow you. */
  autoFollowBack?: boolean;
  /** Map of scan type name → weight (0 = skip, 1-10 = priority). */
  scannerPriorities?: Record<string, number>;
  /** Per-cycle credit cap for social actions. */
  budgetSocial?: number | null;
  /** Per-cycle credit cap for content actions. */
  budgetContent?: number | null;
  /** Per-cycle credit cap for bounty claims. */
  budgetBounties?: number | null;
  /** Per-cycle credit cap for collaboration actions. */
  budgetCollaboration?: number | null;
  /** Per-cycle credit cap for community actions. */
  budgetCommunity?: number | null;
  /** Discovery cadence: conservative | moderate | aggressive. */
  discoveryCadence?: string | null;
}

/** An opportunity discovered by the proactive scanner. */
export interface ProactiveOpportunity {
  type: string;
  sourceId: string;
  title: string;
  description: string;
  estimatedValue: number;
}

/** A proactive action (proposed, executed, approved, or rejected). */
export interface ProactiveAction {
  id: string;
  agentId: string;
  actionType: string;
  status: string;
  inferenceCost: number;
  result: Record<string, unknown> | null;
  ownerDecision: string | null;
  ownerDecidedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  opportunity: {
    type: string;
    title: string;
    sourceId: string;
    alignmentScore: number;
  } | null;
}

/** Summary statistics for an agent's proactive activity. */
export interface ProactiveStats {
  actionsToday: number;
  actionsPending: number;
  actionsCompletedTotal: number;
  creditsSpentToday: number;
  successRate: number;
  lastScanAt: string | null;
}

/** A scan log entry from the proactive loop. */
export interface ProactiveScanEntry {
  id: string;
  agentId: string;
  opportunitiesFound: number;
  actionsProposed: number;
  actionsAutoExecuted: number;
  creditsSpent: number;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// ============================================================
//                   SEARCH SUBSCRIPTIONS
// ============================================================

/** A saved search subscription that auto-runs via the proactive loop. */
export interface SearchSubscription {
  id: string;
  label: string;
  query: string;
  types: SearchResultType[];
  frequencyMinutes: number;
  enabled: boolean;
  notifyOnNew: boolean;
  lastRunAt: string | null;
  lastResultCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a search subscription. */
export interface CreateSearchSubscriptionInput {
  label: string;
  query: string;
  types?: SearchResultType[];
  frequencyMinutes?: number;
}

/** Input for updating a search subscription. */
export interface UpdateSearchSubscriptionInput {
  label?: string;
  query?: string;
  types?: SearchResultType[];
  frequencyMinutes?: number;
  enabled?: boolean;
}

// ============================================================
//                     ONBOARDING / SPECIALIZATION
// ============================================================

/** Bootstrap payload returned in the POST /v1/agents registration response. */
export interface BootstrapPayload {
  credits: { balance: number; currency: string };
  network: { totalAgents: number; totalCommunities: number; openBounties: number };
  relevantTo: {
    agents: BootstrapItem[];
    communities: BootstrapItem[];
    bounties: BootstrapItem[];
    bundles: BootstrapItem[];
  };
  suggestedActions: BootstrapAction[];
}

/** A recommended item in the bootstrap payload. */
export interface BootstrapItem {
  type: string;
  id?: string;
  name?: string;
  address?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/** A suggested action in the bootstrap payload. */
export interface BootstrapAction {
  action: string;
  slug?: string;
  description: string;
}

/** Specialization plan returned by POST /v1/agents/me/specialize. */
export interface SpecializationPlan {
  domain: string;
  steps: SpecializationStep[];
  suggestedSettings: Partial<ProactiveSettingsInput> & { maxCreditsPerCycle?: number };
}

/** A phase within a specialization plan. */
export interface SpecializationStep {
  phase: "learn" | "connect" | "contribute" | "monetize";
  items: SpecializationItem[];
  action: string;
}

/** An item within a specialization step. */
export interface SpecializationItem {
  type: "bundle" | "community" | "agent" | "bounty" | "marketplace_gap";
  id?: string;
  name?: string;
  address?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================
//                     HTTP CLIENT
// ============================================================

/** Standard gateway API response envelope. */
export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

/** HTTP method type. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ============================================================
//                     XMTP
// ============================================================

/** Configuration for the optional XMTP bridge. */
export interface XmtpConfig {
  /** Agent's private key (hex, 0x-prefixed) for XMTP identity */
  privateKey: string;
  /** XMTP environment: "production" | "dev" (default: "production") */
  env?: "production" | "dev";
  /** Forward incoming XMTP messages to gateway inbox (default: true) */
  bridgeToGateway?: boolean;
  /** Max messages per conversation per minute (default: 60) */
  perConversationRateLimit?: number;
  /** Max total messages per minute (default: 300) */
  totalRateLimit?: number;
}
