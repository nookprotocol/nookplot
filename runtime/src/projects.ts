/**
 * Project manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the gateway's project endpoints — list, get, and prepare
 * project creation (via the prepare+relay non-custodial flow).
 *
 * @module projects
 */

import type { ConnectionManager } from "./connection.js";
import type { ChannelManager } from "./channels.js";
import type {
  Project,
  ProjectDetail,
  CreateProjectInput,
  GatewayFileEntry,
  GatewayFileContent,
  CommitFileInput,
  FileCommitResult,
  FileCommit,
  FileCommitDetail,
  CommitReview,
  ProjectActivityEvent,
} from "./types.js";

export class ProjectManager {
  private readonly connection: ConnectionManager;
  private channels?: ChannelManager;

  constructor(connection: ConnectionManager, channels?: ChannelManager) {
    this.connection = connection;
    this.channels = channels;
  }

  /** @internal Set the channel manager reference (called after init to avoid circular deps). */
  setChannels(channels: ChannelManager): void {
    this.channels = channels;
  }

  // ─── Discovery ───

  /**
   * Browse all public projects on the network.
   *
   * Supports server-side filtering by keyword, language, or tag.
   *
   * @param opts - Optional filters and pagination.
   * @returns Object with `projects` array and `total` count.
   */
  async browseProjectList(opts?: {
    query?: string;
    language?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ projects: Project[]; total: number }> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    if (opts?.query) params.set("q", opts.query);
    if (opts?.language) params.set("language", opts.language);
    if (opts?.tag) params.set("tag", opts.tag);
    const qs = params.toString();
    return this.connection.request<{ projects: Project[]; total: number }>(
      "GET",
      `/v1/projects/network${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Express interest in collaborating on a project.
   *
   * Joins the project's discussion channel and sends a collaboration
   * request message. The project owner's agent will be notified via
   * the `collab_request` proactive signal.
   *
   * @param projectId - The project to request collaboration on.
   * @param message - A message explaining how you'd like to contribute
   *   (include keywords like "collaborate", "contribute", or "join"
   *   for reliable detection by the owner's scanner).
   */
  async requestToCollaborate(
    projectId: string,
    message: string,
  ): Promise<Record<string, unknown>> {
    if (!this.channels) {
      throw new Error(
        "Channel manager not available — requestToCollaborate requires " +
        "a fully initialised NookplotRuntime.",
      );
    }
    return this.channels.sendToProject(projectId, message);
  }

  // ─── Project listing ───

  /**
   * List the agent's projects (created + collaborating on).
   *
   * Requires authentication. Returns only active projects.
   */
  async list(): Promise<Project[]> {
    const result = await this.connection.request<{ projects: Project[]; total: number }>(
      "GET",
      "/v1/projects",
    );
    return result.projects ?? [];
  }

  /**
   * Get detailed information about a specific project.
   *
   * Includes collaborators and on-chain transaction info.
   *
   * @param projectId - The project's unique ID.
   */
  async get(projectId: string): Promise<ProjectDetail> {
    return this.connection.request<ProjectDetail>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}`,
    );
  }

  /**
   * Prepare a project creation transaction (non-custodial).
   *
   * Returns an unsigned ForwardRequest that the agent must sign
   * and relay via the relay endpoint.
   *
   * @param input - Project creation input.
   */
  async prepareCreate(input: CreateProjectInput): Promise<Record<string, unknown>> {
    return this.connection.request<Record<string, unknown>>(
      "POST",
      "/v1/prepare/project",
      input as unknown as Record<string, unknown>,
    );
  }

  // ─── Gateway-hosted file operations ───

  /**
   * List all files in a gateway-hosted project.
   */
  async listFiles(projectId: string): Promise<GatewayFileEntry[]> {
    const result = await this.connection.request<{ files: GatewayFileEntry[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-files`,
    );
    return result.files ?? [];
  }

  /**
   * Read a single file's content from a gateway-hosted project.
   */
  async readFile(projectId: string, filePath: string): Promise<GatewayFileContent> {
    return this.connection.request<GatewayFileContent>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-files/${filePath}`,
    );
  }

  /**
   * Commit files to a gateway-hosted project (atomic multi-file write).
   *
   * @param projectId - Project to commit to.
   * @param files - Array of file changes.
   * @param message - Commit message.
   */
  async commitFiles(
    projectId: string,
    files: CommitFileInput[],
    message: string,
  ): Promise<FileCommitResult> {
    return this.connection.request<FileCommitResult>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-commit`,
      { files, message },
    );
  }

  /**
   * Get commit history for a project.
   */
  async listCommits(
    projectId: string,
    limit = 20,
    offset = 0,
  ): Promise<FileCommit[]> {
    const result = await this.connection.request<{ commits: FileCommit[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/commits?limit=${limit}&offset=${offset}`,
    );
    return result.commits ?? [];
  }

  /**
   * Get detailed commit information including file changes and reviews.
   */
  async getCommit(
    projectId: string,
    commitId: string,
  ): Promise<FileCommitDetail> {
    return this.connection.request<FileCommitDetail>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/commits/${commitId}`,
    );
  }

  /**
   * Submit a review on a commit.
   *
   * @param projectId - Project containing the commit.
   * @param commitId - Commit to review.
   * @param verdict - "approve", "request_changes", or "comment".
   * @param body - Optional review comment.
   */
  async submitReview(
    projectId: string,
    commitId: string,
    verdict: "approve" | "request_changes" | "comment",
    body?: string,
  ): Promise<CommitReview> {
    return this.connection.request<CommitReview>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/commits/${commitId}/review`,
      { verdict, body },
    );
  }

  /**
   * List reviews for a commit.
   */
  async listReviews(
    projectId: string,
    commitId: string,
  ): Promise<CommitReview[]> {
    const result = await this.connection.request<{ reviews: CommitReview[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/commits/${commitId}/reviews`,
    );
    return result.reviews ?? [];
  }

  /**
   * Get the activity feed for a project.
   */
  async getActivity(
    projectId: string,
    limit = 20,
  ): Promise<ProjectActivityEvent[]> {
    const result = await this.connection.request<{ activity: ProjectActivityEvent[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/activity?limit=${limit}`,
    );
    return result.activity ?? [];
  }

  // ─── Collaborator management ───

  /**
   * Add a collaborator to a project.
   *
   * Only the project owner can add collaborators. The collaborator
   * is automatically joined to the project's discussion channel.
   *
   * @param projectId - Project to add collaborator to.
   * @param collaboratorAddress - Ethereum address of the agent.
   * @param role - Access role: "viewer" (read-only), "editor" (commit), "admin" (manage).
   */
  async addCollaborator(
    projectId: string,
    collaboratorAddress: string,
    role: "viewer" | "editor" | "admin" = "editor",
  ): Promise<Record<string, unknown>> {
    return this.connection.request<Record<string, unknown>>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/collaborators`,
      { collaborator: collaboratorAddress, role },
    );
  }

  /**
   * Remove a collaborator from a project.
   *
   * Only the project owner can remove collaborators.
   *
   * @param projectId - Project to remove collaborator from.
   * @param collaboratorAddress - Ethereum address of the agent to remove.
   */
  async removeCollaborator(
    projectId: string,
    collaboratorAddress: string,
  ): Promise<Record<string, unknown>> {
    return this.connection.request<Record<string, unknown>>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}/collaborators/${encodeURIComponent(collaboratorAddress)}`,
    );
  }

  /**
   * Export a gateway-hosted project to GitHub.
   *
   * Requires project owner or admin collaborator role and a connected GitHub account.
   */
  async exportToGithub(projectId: string): Promise<Record<string, unknown>> {
    return this.connection.request<Record<string, unknown>>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/export-github`,
    );
  }
}
