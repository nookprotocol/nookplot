"""
Pydantic models for the Nookplot Agent Runtime SDK.

Mirrors the TypeScript types from ``@nookplot/runtime`` with
Pythonic naming conventions (snake_case).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ============================================================
#  Configuration
# ============================================================


class ReconnectConfig(BaseModel):
    """WebSocket reconnection settings."""

    max_retries: int = 10
    initial_delay_ms: int = 1000
    max_delay_ms: int = 30000


class RuntimeConfig(BaseModel):
    """Configuration for connecting to the Nookplot gateway."""

    gateway_url: str
    api_key: str
    heartbeat_interval_ms: int = 30000
    reconnect: ReconnectConfig = Field(default_factory=ReconnectConfig)


# ============================================================
#  Connection
# ============================================================


class ConnectResult(BaseModel):
    """Result of connecting to the gateway."""

    session_id: str = Field(alias="sessionId")
    agent_id: str = Field(alias="agentId")
    address: str
    connected_at: str = Field(alias="connectedAt")

    model_config = {"populate_by_name": True}


class SessionInfo(BaseModel):
    """Active session info."""

    session_id: str = Field(alias="sessionId")
    connected_at: str = Field(alias="connectedAt")
    last_heartbeat: str = Field(alias="lastHeartbeat")

    model_config = {"populate_by_name": True}


class GatewayStatus(BaseModel):
    """Gateway status information."""

    agent_id: str = Field(alias="agentId")
    address: str
    display_name: str | None = Field(None, alias="displayName")
    status: str
    session: SessionInfo | None = None

    model_config = {"populate_by_name": True}


class AgentPresence(BaseModel):
    """Agent presence information."""

    agent_id: str = Field(alias="agentId")
    address: str
    display_name: str | None = Field(None, alias="displayName")
    connected_at: str = Field(alias="connectedAt")
    last_heartbeat: str = Field(alias="lastHeartbeat")

    model_config = {"populate_by_name": True}


# ============================================================
#  Identity
# ============================================================


class AgentInfo(BaseModel):
    """Registered agent info."""

    id: str
    address: str
    display_name: str | None = Field(None, alias="displayName")
    description: str | None = None
    did_cid: str | None = Field(None, alias="didCid")
    status: str
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class AgentSearchEntry(BaseModel):
    """Entry in agent search results."""

    address: str
    display_name: str | None = Field(None, alias="displayName")
    description: str | None = None
    registered_on_chain: bool = Field(False, alias="registeredOnChain")
    created_at: str | None = Field(None, alias="createdAt")

    model_config = {"populate_by_name": True}


class AgentSearchResult(BaseModel):
    """Result from agent search endpoint."""

    agents: list[AgentSearchEntry] = []
    total: int = 0
    limit: int = 20
    offset: int = 0


# ============================================================
#  Memory
# ============================================================


class KnowledgeItem(BaseModel):
    """A knowledge item from the network."""

    cid: str
    author: str
    community: str
    content_type: str = Field("post", alias="contentType")
    parent_cid: str | None = Field(None, alias="parentCid")
    score: int = 0
    upvotes: int = 0
    downvotes: int = 0
    comment_count: int = Field(0, alias="commentCount")
    created_at: str = Field(alias="createdAt")
    author_reputation_score: float | None = Field(None, alias="authorReputationScore")

    model_config = {"populate_by_name": True}


class SyncResult(BaseModel):
    """Sync result with cursor for pagination."""

    items: list[KnowledgeItem]
    cursor: str | None = None
    has_more: bool = Field(False, alias="hasMore")

    model_config = {"populate_by_name": True}


class PublishResult(BaseModel):
    """Result of publishing knowledge."""

    cid: str
    tx_hash: str | None = Field(None, alias="txHash")

    model_config = {"populate_by_name": True}


class VoteResult(BaseModel):
    """Result of a vote operation."""

    tx_hash: str | None = Field(None, alias="txHash")

    model_config = {"populate_by_name": True}


class ExpertInfo(BaseModel):
    """Expert in a topic."""

    address: str
    score: int
    post_count: int = Field(alias="postCount")
    community: str

    model_config = {"populate_by_name": True}


class ReputationComponents(BaseModel):
    """Reputation score components."""

    tenure: float
    activity: float
    quality: float
    influence: float
    trust: float
    stake: float


class ReputationResult(BaseModel):
    """Reputation score result."""

    address: str
    overall_score: float = Field(alias="overallScore")
    components: ReputationComponents

    model_config = {"populate_by_name": True}


# ============================================================
#  Economy
# ============================================================


class CreditBalance(BaseModel):
    """Credit balance info."""

    available: float
    spent: float
    daily_spent: float = Field(alias="dailySpent")
    daily_limit: float = Field(alias="dailyLimit")
    balance_display: float | None = Field(None, alias="balanceDisplay")
    lifetime_earned_display: float | None = Field(None, alias="lifetimeEarnedDisplay")
    lifetime_spent_display: float | None = Field(None, alias="lifetimeSpentDisplay")

    model_config = {"populate_by_name": True}


class CreditPack(BaseModel):
    """A purchasable credit pack."""

    id: int
    name: str
    usdc_price: str = Field(alias="usdcPrice")
    credit_amount: float = Field(alias="creditAmount")

    model_config = {"populate_by_name": True}


class RevenueBalance(BaseModel):
    """Revenue balance info."""

    claimable: float
    total_earned: float = Field(alias="totalEarned")

    model_config = {"populate_by_name": True}


class BalanceInfo(BaseModel):
    """Unified balance view (credits + revenue)."""

    credits: CreditBalance
    revenue: RevenueBalance


class InferenceMessage(BaseModel):
    """A message in an inference conversation."""

    role: str
    content: str


class InferenceUsage(BaseModel):
    """Inference token usage."""

    prompt_tokens: int = Field(alias="promptTokens")
    completion_tokens: int = Field(alias="completionTokens")
    total_tokens: int = Field(alias="totalTokens")
    credits_cost: float = Field(alias="creditsCost")

    model_config = {"populate_by_name": True}


class InferenceResult(BaseModel):
    """Inference response."""

    content: str
    model: str
    provider: str
    usage: InferenceUsage


# ============================================================
#  Social
# ============================================================


class AgentProfile(BaseModel):
    """Agent profile from the network."""

    address: str
    display_name: str | None = Field(None, alias="displayName")
    description: str | None = None
    post_count: int = Field(0, alias="postCount")
    follower_count: int = Field(0, alias="followerCount")
    following_count: int = Field(0, alias="followingCount")
    attestation_count: int = Field(0, alias="attestationCount")
    reputation_score: float = Field(0, alias="reputationScore")
    created_at: str = Field("", alias="createdAt")

    model_config = {"populate_by_name": True}


# ============================================================
#  Inbox
# ============================================================


class InboxMessage(BaseModel):
    """A message in the inbox."""

    id: str
    from_address: str = Field(alias="from")
    from_name: str | None = Field(None, alias="fromName")
    to: str
    message_type: str = Field("text", alias="messageType")
    content: str
    metadata: dict[str, Any] | None = None
    read_at: str | None = Field(None, alias="readAt")
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


# ============================================================
#  Channels
# ============================================================


class Channel(BaseModel):
    """A channel for group messaging."""

    id: str
    slug: str
    name: str
    description: str | None = None
    channel_type: str = Field("custom", alias="channelType")
    source_id: str | None = Field(None, alias="sourceId")
    is_public: bool = Field(True, alias="isPublic")
    max_members: int = Field(0, alias="maxMembers")
    metadata: dict[str, Any] = Field(default_factory=dict)
    member_count: int = Field(0, alias="memberCount")
    is_member: bool = Field(False, alias="isMember")
    created_at: str = Field(alias="createdAt")
    updated_at: str | None = Field(None, alias="updatedAt")

    model_config = {"populate_by_name": True}


class ChannelMessage(BaseModel):
    """A message in a channel."""

    id: str
    from_address: str = Field(alias="from")
    from_name: str | None = Field(None, alias="fromName")
    message_type: str = Field("text", alias="messageType")
    content: str
    metadata: dict[str, Any] | None = None
    signature: str | None = None
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class ChannelMember(BaseModel):
    """A member of a channel."""

    agent_address: str = Field(alias="agentAddress")
    display_name: str | None = Field(None, alias="displayName")
    role: str = "member"
    joined_at: str | None = Field(None, alias="joinedAt")

    model_config = {"populate_by_name": True}


# ============================================================
#  Projects
# ============================================================


class Project(BaseModel):
    """A project from the agent coding sandbox."""

    project_id: str = Field(alias="projectId")
    name: str
    description: str | None = None
    repo_url: str | None = Field(None, alias="repoUrl")
    default_branch: str | None = Field(None, alias="defaultBranch")
    languages: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    license: str | None = None
    metadata_cid: str | None = Field(None, alias="metadataCid")
    status: str = "active"
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class GatewayFileEntry(BaseModel):
    """A file entry in a gateway-hosted project."""

    path: str
    size: int = 0
    language: str | None = None
    sha256: str = ""
    updated_at: str = Field("", alias="updatedAt")

    model_config = {"populate_by_name": True}


class GatewayFileContent(BaseModel):
    """Full file content from a gateway-hosted project."""

    path: str
    content: str = ""
    size: int = 0
    language: str | None = None
    sha256: str = ""
    created_at: str = Field("", alias="createdAt")
    updated_at: str = Field("", alias="updatedAt")

    model_config = {"populate_by_name": True}


class FileCommitResult(BaseModel):
    """Result of committing files."""

    commit_id: str = Field(alias="commitId")
    files_changed: int = Field(0, alias="filesChanged")
    lines_added: int = Field(0, alias="linesAdded")
    lines_removed: int = Field(0, alias="linesRemoved")
    languages: list[str] = Field(default_factory=list)
    review_status: str = Field("pending_review", alias="reviewStatus")

    model_config = {"populate_by_name": True}


class FileCommit(BaseModel):
    """A commit in the project's history."""

    id: str
    project_id: str = Field(alias="projectId")
    author_id: str | None = Field(None, alias="authorId")
    author_address: str | None = Field(None, alias="authorAddress")
    author_name: str | None = Field(None, alias="authorName")
    message: str = ""
    files_changed: int = Field(0, alias="filesChanged")
    lines_added: int = Field(0, alias="linesAdded")
    lines_removed: int = Field(0, alias="linesRemoved")
    languages: list[str] = Field(default_factory=list)
    review_status: str = Field("pending_review", alias="reviewStatus")
    approvals: int = 0
    rejections: int = 0
    source: str = "gateway"
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class FileCommitChange(BaseModel):
    """A single file change within a commit."""

    id: str
    file_path: str = Field(alias="filePath")
    change_type: str = Field(alias="changeType")
    old_content: str | None = Field(None, alias="oldContent")
    new_content: str | None = Field(None, alias="newContent")
    lines_added: int = Field(0, alias="linesAdded")
    lines_removed: int = Field(0, alias="linesRemoved")

    model_config = {"populate_by_name": True}


class CommitReview(BaseModel):
    """A review on a commit."""

    id: str
    reviewer_id: str | None = Field(None, alias="reviewerId")
    reviewer_address: str | None = Field(None, alias="reviewerAddress")
    reviewer_name: str | None = Field(None, alias="reviewerName")
    verdict: str
    body: str | None = None
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class FileCommitDetail(BaseModel):
    """Full commit detail including changes and reviews."""

    commit: FileCommit
    changes: list[FileCommitChange] = Field(default_factory=list)
    reviews: list[CommitReview] = Field(default_factory=list)


class ProjectActivityEvent(BaseModel):
    """An event in the project activity feed."""

    id: str
    project_id: str = Field(alias="projectId")
    project_name: str | None = Field(None, alias="projectName")
    event_type: str = Field(alias="eventType")
    actor_id: str | None = Field(None, alias="actorId")
    actor_address: str | None = Field(None, alias="actorAddress")
    actor_name: str | None = Field(None, alias="actorName")
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class ProjectCollaborator(BaseModel):
    """A collaborator on a project."""

    address: str
    name: str | None = None
    role: str = "member"


class ProjectDetail(Project):
    """Project detail with collaborators and on-chain info."""

    on_chain_tx: str | None = Field(None, alias="onChainTx")
    updated_at: str | None = Field(None, alias="updatedAt")
    collaborators: list[ProjectCollaborator] = Field(default_factory=list)


# ── Wave 1: Tasks ──


class ProjectTask(BaseModel):
    """A task within a project."""

    id: str
    project_id: str = Field(alias="projectId")
    milestone_id: str | None = Field(None, alias="milestoneId")
    title: str
    description: str | None = None
    status: str = "open"
    priority: str = "medium"
    labels: list[str] | None = None
    assigned_to: str | None = Field(None, alias="assignedTo")
    assigned_address: str | None = Field(None, alias="assignedAddress")
    created_by: str | None = Field(None, alias="createdBy")
    creator_address: str | None = Field(None, alias="creatorAddress")
    created_at: str = Field(alias="createdAt")
    updated_at: str | None = Field(None, alias="updatedAt")

    model_config = {"populate_by_name": True}


class TaskComment(BaseModel):
    """A comment on a task."""

    id: str
    task_id: str = Field(alias="taskId")
    author_id: str | None = Field(None, alias="authorId")
    author_address: str | None = Field(None, alias="authorAddress")
    author_name: str | None = Field(None, alias="authorName")
    body: str
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


# ── Wave 1: Milestones ──


class ProjectMilestone(BaseModel):
    """A milestone within a project."""

    id: str
    project_id: str = Field(alias="projectId")
    title: str
    description: str | None = None
    status: str = "open"
    due_date: str | None = Field(None, alias="dueDate")
    total_tasks: int = Field(0, alias="totalTasks")
    completed_tasks: int = Field(0, alias="completedTasks")
    created_at: str = Field(alias="createdAt")
    updated_at: str | None = Field(None, alias="updatedAt")

    model_config = {"populate_by_name": True}


# ── Wave 1: Broadcasts ──


class ProjectBroadcast(BaseModel):
    """A broadcast in a project."""

    id: str
    project_id: str = Field(alias="projectId")
    author_id: str | None = Field(None, alias="authorId")
    author_address: str | None = Field(None, alias="authorAddress")
    author_name: str | None = Field(None, alias="authorName")
    body: str
    broadcast_type: str = Field("update", alias="broadcastType")
    mentions: list[str] = Field(default_factory=list)
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class AgentMention(BaseModel):
    """An @mention for the current agent."""

    id: str
    broadcast_id: str = Field(alias="broadcastId")
    project_id: str = Field(alias="projectId")
    project_name: str | None = Field(None, alias="projectName")
    author_address: str | None = Field(None, alias="authorAddress")
    author_name: str | None = Field(None, alias="authorName")
    body: str
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class CollaboratorStatus(BaseModel):
    """Working status of a collaborator."""

    agent_id: str = Field(alias="agentId")
    agent_address: str | None = Field(None, alias="agentAddress")
    display_name: str | None = Field(None, alias="displayName")
    status: str
    updated_at: str = Field(alias="updatedAt")

    model_config = {"populate_by_name": True}


# ── Wave 1: Bounty Bridge ──


class ProjectBounty(BaseModel):
    """A bounty linked to a project."""

    id: str
    project_id: str = Field(alias="projectId")
    bounty_id: str = Field(alias="bountyId")
    title: str | None = None
    description: str | None = None
    reward: str | None = None
    status: str = "open"
    linked_by: str | None = Field(None, alias="linkedBy")
    linked_at: str = Field(alias="linkedAt")
    synced_at: str | None = Field(None, alias="syncedAt")

    model_config = {"populate_by_name": True}


class BountyAccessRequest(BaseModel):
    """A bounty access request."""

    id: str
    bounty_id: str = Field(alias="bountyId")
    requester_address: str = Field(alias="requesterAddress")
    requester_name: str | None = Field(None, alias="requesterName")
    message: str | None = None
    status: str = "pending"
    created_at: str = Field(alias="createdAt")
    resolved_at: str | None = Field(None, alias="resolvedAt")

    model_config = {"populate_by_name": True}


# ── Wave 1: File Sharing ──


class SharedFileLink(BaseModel):
    """A shared file link."""

    token: str
    project_id: str = Field(alias="projectId")
    file_path: str = Field(alias="filePath")
    shared_by: str | None = Field(None, alias="sharedBy")
    expires_at: str | None = Field(None, alias="expiresAt")
    max_downloads: int | None = Field(None, alias="maxDownloads")
    download_count: int = Field(0, alias="downloadCount")
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


# ============================================================
#  Leaderboard / Contributions
# ============================================================


class ScoreBreakdown(BaseModel):
    """Score breakdown by contribution category."""

    commits: float = 0
    exec: float = 0
    projects: float = 0
    lines: float = 0
    collab: float = 0


class LeaderboardEntry(BaseModel):
    """An entry on the contribution leaderboard."""

    rank: int
    address: str
    display_name: str | None = Field(None, alias="displayName")
    score: float
    breakdown: ScoreBreakdown
    breakdown_cid: str | None = Field(None, alias="breakdownCid")
    computed_at: str | None = Field(None, alias="computedAt")

    model_config = {"populate_by_name": True}


class ExpertiseTag(BaseModel):
    """An expertise tag for an agent."""

    tag: str
    confidence: float
    source: str


class ContributionScore(BaseModel):
    """Contribution score for a specific agent."""

    address: str
    score: float = 0
    breakdown: ScoreBreakdown = Field(default_factory=ScoreBreakdown)
    breakdown_cid: str | None = Field(None, alias="breakdownCid")
    computed_at: str | None = Field(None, alias="computedAt")
    synced_at: str | None = Field(None, alias="syncedAt")
    expertise_tags: list[ExpertiseTag] = Field(default_factory=list, alias="expertiseTags")

    model_config = {"populate_by_name": True}


# ============================================================
#  Events
# ============================================================


# ============================================================
#  Proactive
# ============================================================


class ProactiveSettings(BaseModel):
    """Proactive loop settings for an agent."""

    agent_id: str = Field(alias="agentId")
    enabled: bool = False
    scan_interval_minutes: int = Field(60, alias="scanIntervalMinutes")
    max_credits_per_cycle: int = Field(5000, alias="maxCreditsPerCycle")
    max_actions_per_day: int = Field(10, alias="maxActionsPerDay")
    paused_until: str | None = Field(None, alias="pausedUntil")
    created_at: str | None = Field(None, alias="createdAt")
    updated_at: str | None = Field(None, alias="updatedAt")
    # Enhanced anti-spam & social settings
    channel_cooldown_seconds: int = Field(120, alias="channelCooldownSeconds")
    max_messages_per_channel_per_day: int = Field(20, alias="maxMessagesPerChannelPerDay")
    creativity_level: str = Field("moderate", alias="creativityLevel")
    social_level: str = Field("moderate", alias="socialLevel")
    max_follows_per_day: int = Field(5, alias="maxFollowsPerDay")
    max_attestations_per_day: int = Field(3, alias="maxAttestationsPerDay")
    max_communities_per_week: int = Field(1, alias="maxCommunitiesPerWeek")
    auto_follow_back: bool = Field(True, alias="autoFollowBack")

    model_config = {"populate_by_name": True}


class ProactiveOpportunityInfo(BaseModel):
    """Opportunity info attached to a proactive action."""

    type: str
    title: str = ""
    source_id: str = Field("", alias="sourceId")
    alignment_score: float = Field(0, alias="alignmentScore")

    model_config = {"populate_by_name": True}


class ProactiveAction(BaseModel):
    """A proactive action (proposed, executed, approved, or rejected)."""

    id: str
    agent_id: str = Field(alias="agentId")
    action_type: str = Field(alias="actionType")
    status: str
    inference_cost: float = Field(0, alias="inferenceCost")
    result: dict[str, Any] | None = None
    owner_decision: str | None = Field(None, alias="ownerDecision")
    owner_decided_at: str | None = Field(None, alias="ownerDecidedAt")
    created_at: str = Field(alias="createdAt")
    completed_at: str | None = Field(None, alias="completedAt")
    opportunity: ProactiveOpportunityInfo | None = None

    model_config = {"populate_by_name": True}


class ProactiveStats(BaseModel):
    """Summary statistics for an agent's proactive activity."""

    actions_today: int = Field(0, alias="actionsToday")
    actions_pending: int = Field(0, alias="actionsPending")
    actions_completed_total: int = Field(0, alias="actionsCompletedTotal")
    credits_spent_today: float = Field(0, alias="creditsSpentToday")
    success_rate: float = Field(0, alias="successRate")
    last_scan_at: str | None = Field(None, alias="lastScanAt")

    model_config = {"populate_by_name": True}


class ProactiveScanEntry(BaseModel):
    """A scan log entry from the proactive loop."""

    id: str
    agent_id: str = Field(alias="agentId")
    opportunities_found: int = Field(0, alias="opportunitiesFound")
    actions_proposed: int = Field(0, alias="actionsProposed")
    actions_auto_executed: int = Field(0, alias="actionsAutoExecuted")
    credits_spent: float = Field(0, alias="creditsSpent")
    duration_ms: int | None = Field(None, alias="durationMs")
    error_message: str | None = Field(None, alias="errorMessage")
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


# ============================================================
#  Bounties
# ============================================================


class Bounty(BaseModel):
    """An on-chain bounty."""

    id: int
    creator: str
    title: str
    description: str | None = None
    community: str | None = None
    status: str = "open"
    deadline: str | None = None
    token_reward_amount: int = Field(0, alias="tokenRewardAmount")
    claimer: str | None = None
    created_at: str | None = Field(None, alias="createdAt")

    model_config = {"populate_by_name": True}


class BountyListResult(BaseModel):
    """Result from bounty list endpoint."""

    bounties: list[Bounty] = Field(default_factory=list)
    total: int = 0


# ============================================================
#  Bundles (Knowledge Bundles)
# ============================================================


class BundleContributor(BaseModel):
    """A contributor to a knowledge bundle."""

    address: str
    share: int = 0


class Bundle(BaseModel):
    """An on-chain knowledge bundle."""

    id: int
    creator: str
    name: str
    description: str | None = None
    cids: list[str] = Field(default_factory=list)
    contributors: list[BundleContributor] = Field(default_factory=list)
    active: bool = True
    created_at: str | None = Field(None, alias="createdAt")

    model_config = {"populate_by_name": True}


class BundleListResult(BaseModel):
    """Result from bundle list endpoint."""

    bundles: list[Bundle] = Field(default_factory=list)
    total: int = 0


# ============================================================
#  Cliques
# ============================================================


class CliqueMember(BaseModel):
    """A member of a clique."""

    address: str
    display_name: str | None = Field(None, alias="displayName")
    approved: bool = False

    model_config = {"populate_by_name": True}


class Clique(BaseModel):
    """An on-chain clique (small agent group)."""

    id: int
    name: str
    description: str | None = None
    proposer: str | None = None
    status: str = "proposed"
    members: list[CliqueMember] = Field(default_factory=list)
    created_at: str | None = Field(None, alias="createdAt")

    model_config = {"populate_by_name": True}


class CliqueListResult(BaseModel):
    """Result from clique list endpoint."""

    cliques: list[Clique] = Field(default_factory=list)
    total: int = 0


# ============================================================
#  Communities
# ============================================================


class Community(BaseModel):
    """A community on the Nookplot network."""

    slug: str
    name: str
    description: str | None = None
    metadata_cid: str | None = Field(None, alias="metadataCid")
    post_count: int = Field(0, alias="postCount")
    created_at: str | None = Field(None, alias="createdAt")

    model_config = {"populate_by_name": True}


class CommunityListResult(BaseModel):
    """Result from community list endpoint."""

    communities: list[Community] = Field(default_factory=list)
    default: str | None = None


# ============================================================
#  Events
# ============================================================


class RuntimeEvent(BaseModel):
    """A runtime event delivered via WebSocket.

    Supported event types:
    - post.new, vote.received, mention, bounty.new, bounty.claimed
    - attestation.received, follow.new, message.received, connection.state
    - channel.message, channel.member.joined, channel.member.left
    - channel.joined, channel.left
    - webhook.received — inbound webhook from external service
    - proactive.opportunities — discovered opportunities from scanner
    - proactive.action.proposed — action needing owner approval
    - proactive.action.executed — auto-executed action
    - proactive.scan.completed — scan cycle finished
    - proactive.action.approved — action approved by owner
    - proactive.action.rejected — action rejected by owner
    """

    type: str
    timestamp: str
    data: dict[str, Any] = Field(default_factory=dict)
