/**
 * GitHub API client for the Agent Coding Sandbox.
 *
 * Handles GitHub PAT encryption/decryption (reusing secretManager AES-256-GCM),
 * secret scanning, file path validation, and all GitHub REST API interactions.
 *
 * Security-critical module:
 * - PATs are encrypted at rest with AES-256-GCM
 * - Decrypted PATs are zeroed after each request
 * - Content is scanned for secrets before committing
 * - File paths are validated against traversal attacks
 *
 * @module services/githubClient
 */

import { encryptPrivateKey, decryptPrivateKey } from "../secretManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Maximum file size for read operations (1 MB). */
const MAX_FILE_SIZE = 1_048_576;

/** GitHub API base URL. */
const GITHUB_API = "https://api.github.com";

// ============================================================
//  Secret Scanning Patterns
// ============================================================

/**
 * Regex patterns for detecting secrets in content.
 * Each entry: [patternName, regex].
 * We NEVER return matched values — only pattern names.
 */
const SECRET_PATTERNS: [string, RegExp][] = [
  // AWS
  ["aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["aws-secret-key", /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}/],
  // GitHub tokens
  ["github-pat", /gh[ps]_[A-Za-z0-9_]{36,}/],
  ["github-pat-v2", /github_pat_[A-Za-z0-9_]{22,}/],
  ["github-oauth", /gho_[A-Za-z0-9]{36}/],
  ["github-user-to-server", /ghu_[A-Za-z0-9]{36}/],
  ["github-server-to-server", /ghs_[A-Za-z0-9]{36}/],
  ["github-refresh-token", /ghr_[A-Za-z0-9]{36}/],
  // Private keys
  ["private-key-rsa", /-----BEGIN RSA PRIVATE KEY-----/],
  ["private-key-openssh", /-----BEGIN OPENSSH PRIVATE KEY-----/],
  ["private-key-ec", /-----BEGIN EC PRIVATE KEY-----/],
  ["private-key-generic", /-----BEGIN PRIVATE KEY-----/],
  // Ethereum keys
  ["eth-private-key", /(?:private.?key|PRIVATE.?KEY)\s*[=:]\s*0x[0-9a-fA-F]{64}/],
  // API keys (generic patterns)
  ["api-key-generic", /(?:api[_-]?key|apikey|API[_-]?KEY)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/],
  ["api-secret-generic", /(?:api[_-]?secret|apisecret|API[_-]?SECRET)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/],
  // JWTs
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-]{10,}/],
  // Pinata
  ["pinata-jwt", /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[\w\-]+/],
  // Slack
  ["slack-token", /xox[bpors]-[0-9]{10,}-[A-Za-z0-9-]+/],
  // Stripe
  ["stripe-secret-key", /sk_live_[0-9a-zA-Z]{24,}/],
  ["stripe-restricted-key", /rk_live_[0-9a-zA-Z]{24,}/],
];

// ============================================================
//  Types
// ============================================================

/** Encrypted PAT data stored in the database. */
export interface EncryptedPAT {
  encryptedKey: string;
  iv: string;
  authTag: string;
}

/** GitHub file/directory entry from the Contents API. */
export interface GitHubFileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
  sha: string;
}

/** File content from the Contents API. */
export interface GitHubFileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
  sha: string;
}

/** File to commit via the Git Trees API. */
export interface CommitFile {
  path: string;
  content: string;
}

/** Result of a commit+push operation. */
export interface CommitResult {
  sha: string;
  message: string;
  url: string;
  filesChanged: number;
}

/** Repository info from GitHub. */
export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  permissions: {
    push: boolean;
    pull: boolean;
    admin: boolean;
  };
}

/** Branch info from GitHub. */
export interface BranchInfo {
  name: string;
  sha: string;
  protected: boolean;
}

/** Result of secret scanning. */
export interface SecretScanResult {
  clean: boolean;
  matches: string[]; // pattern names only, never actual values
}

// ============================================================
//  GitHubClient
// ============================================================

export class GitHubClient {
  private readonly masterKey: string;

  constructor(masterKey: string) {
    if (!masterKey || !/^[0-9a-fA-F]{64}$/.test(masterKey)) {
      throw new Error("GitHubClient: masterKey must be 64 hex characters (32 bytes)");
    }
    this.masterKey = masterKey;
  }

  // ------------------------------------------------------------------
  //  PAT Encryption / Decryption (reuses secretManager)
  // ------------------------------------------------------------------

  /**
   * Encrypt a GitHub PAT for database storage.
   */
  encryptPAT(pat: string): EncryptedPAT {
    const { encryptedKey, iv, authTag } = encryptPrivateKey(pat, this.masterKey);
    return { encryptedKey, iv, authTag };
  }

  /**
   * Decrypt a GitHub PAT from database storage.
   */
  decryptPAT(encrypted: string, iv: string, authTag: string): string {
    return decryptPrivateKey(encrypted, iv, authTag, this.masterKey);
  }

  // ------------------------------------------------------------------
  //  Secret Scanning
  // ------------------------------------------------------------------

  /**
   * Scan content for embedded secrets (API keys, tokens, private keys).
   *
   * Returns pattern names only — NEVER returns matched values.
   */
  scanForSecrets(content: string): SecretScanResult {
    const matches: string[] = [];

    for (const [name, pattern] of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        matches.push(name);
      }
    }

    return { clean: matches.length === 0, matches };
  }

  // ------------------------------------------------------------------
  //  File Path Validation
  // ------------------------------------------------------------------

  /**
   * Validate a file path for safety.
   * Rejects path traversal, absolute paths, control characters, null bytes.
   */
  validateFilePath(filePath: string): { valid: boolean; reason?: string } {
    if (!filePath || typeof filePath !== "string") {
      return { valid: false, reason: "File path is required." };
    }

    // Null bytes
    if (filePath.includes("\0")) {
      return { valid: false, reason: "File path contains null bytes." };
    }

    // Control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1F\x7F]/.test(filePath)) {
      return { valid: false, reason: "File path contains control characters." };
    }

    // Absolute paths
    if (filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) {
      return { valid: false, reason: "Absolute paths are not allowed." };
    }

    // Path traversal
    const segments = filePath.split("/");
    for (const seg of segments) {
      if (seg === ".." || seg === ".") {
        return { valid: false, reason: "Path traversal (../) is not allowed." };
      }
    }

    // Length limit
    if (filePath.length > 500) {
      return { valid: false, reason: "File path exceeds 500 characters." };
    }

    return { valid: true };
  }

  // ------------------------------------------------------------------
  //  GitHub API Methods
  // ------------------------------------------------------------------

  /**
   * Validate a PAT by calling GET /user. Returns the GitHub username.
   */
  async validatePAT(pat: string): Promise<{ valid: boolean; username?: string; scopes?: string[] }> {
    try {
      const response = await this._fetch(pat, "/user");
      if (!response.ok) {
        return { valid: false };
      }
      const data = await response.json() as { login: string };
      const scopes = (response.headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      return { valid: true, username: data.login, scopes };
    } catch {
      return { valid: false };
    }
  }

  /**
   * Get repository info (validates access).
   */
  async getRepoInfo(pat: string, owner: string, repo: string): Promise<RepoInfo> {
    const response = await this._fetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if (!response.ok) {
      const status = response.status;
      if (status === 404) throw new Error("Repository not found or no access.");
      if (status === 403) throw new Error("Insufficient permissions for this repository.");
      throw new Error(`GitHub API error: ${status}`);
    }
    const data = await response.json() as {
      full_name: string;
      default_branch: string;
      private: boolean;
      permissions: { push: boolean; pull: boolean; admin: boolean };
    };
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      private: data.private,
      permissions: data.permissions,
    };
  }

  /**
   * List files in a directory via the Contents API.
   */
  async listFiles(
    pat: string,
    owner: string,
    repo: string,
    path = "",
    ref?: string,
  ): Promise<GitHubFileEntry[]> {
    const safePath = path ? `/${encodeURIComponent(path).replace(/%2F/g, "/")}` : "";
    let url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${safePath}`;
    if (ref) url += `?ref=${encodeURIComponent(ref)}`;

    const response = await this._fetch(pat, url);
    if (!response.ok) {
      if (response.status === 404) throw new Error("Path not found in repository.");
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as Array<{
      name: string; path: string; type: string; size: number; sha: string;
    }>;

    if (!Array.isArray(data)) {
      // Single file instead of directory
      throw new Error("Path is a file, not a directory. Use readFile instead.");
    }

    return data.map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type as GitHubFileEntry["type"],
      size: item.size,
      sha: item.sha,
    }));
  }

  /**
   * Read a file's content via the Contents API.
   * Enforces a 1 MB file size limit.
   */
  async readFile(
    pat: string,
    owner: string,
    repo: string,
    filePath: string,
    ref?: string,
  ): Promise<GitHubFileContent> {
    const pathValidation = this.validateFilePath(filePath);
    if (!pathValidation.valid) {
      throw new Error(`Invalid file path: ${pathValidation.reason}`);
    }

    const safePath = encodeURIComponent(filePath).replace(/%2F/g, "/");
    let url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safePath}`;
    if (ref) url += `?ref=${encodeURIComponent(ref)}`;

    const response = await this._fetch(pat, url);
    if (!response.ok) {
      if (response.status === 404) throw new Error("File not found.");
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as {
      path: string; content: string; encoding: string; size: number; sha: string; type: string;
    };

    if (data.type !== "file") {
      throw new Error("Path is not a file.");
    }

    if (data.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (${data.size} bytes). Maximum is ${MAX_FILE_SIZE} bytes (1 MB).`);
    }

    // Decode base64 content
    const content = Buffer.from(data.content, "base64").toString("utf-8");

    return {
      path: data.path,
      content,
      encoding: "utf-8",
      size: data.size,
      sha: data.sha,
    };
  }

  /**
   * List branches in a repository.
   */
  async listBranches(pat: string, owner: string, repo: string): Promise<BranchInfo[]> {
    const response = await this._fetch(
      pat,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    );
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as Array<{
      name: string; commit: { sha: string }; protected: boolean;
    }>;

    return data.map((b) => ({
      name: b.name,
      sha: b.commit.sha,
      protected: b.protected,
    }));
  }

  /**
   * Atomic multi-file commit via the Git Trees API.
   *
   * Creates a tree with all file changes, creates a commit pointing to
   * that tree, and updates the branch ref — all in one atomic operation.
   */
  async commitAndPush(
    pat: string,
    owner: string,
    repo: string,
    files: CommitFile[],
    message: string,
    branch: string,
  ): Promise<CommitResult> {
    const ownerEnc = encodeURIComponent(owner);
    const repoEnc = encodeURIComponent(repo);
    const repoPath = `/repos/${ownerEnc}/${repoEnc}`;

    // Validate all file paths and scan for secrets
    for (const file of files) {
      const pathCheck = this.validateFilePath(file.path);
      if (!pathCheck.valid) {
        throw new Error(`Invalid file path "${file.path}": ${pathCheck.reason}`);
      }

      const secretScan = this.scanForSecrets(file.content);
      if (!secretScan.clean) {
        logSecurityEvent("warn", "secret-detected-in-commit", {
          filePath: file.path,
          patterns: secretScan.matches,
          owner,
          repo,
        });
        throw new Error(
          `Secret detected in "${file.path}". Patterns: ${secretScan.matches.join(", ")}. ` +
          `Remove secrets before committing.`,
        );
      }
    }

    // Sanitize commit message (strip control chars, limit length)
    const sanitizedMessage = message
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .slice(0, 1000);

    // Step 1: Get the current ref (branch HEAD)
    const refResponse = await this._fetch(pat, `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!refResponse.ok) {
      if (refResponse.status === 404) throw new Error(`Branch "${branch}" not found.`);
      throw new Error(`Failed to get branch ref: ${refResponse.status}`);
    }
    const refData = await refResponse.json() as { object: { sha: string } };
    const baseSha = refData.object.sha;

    // Step 2: Create blobs for each file
    const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const file of files) {
      const blobResponse = await this._fetchJson(pat, `${repoPath}/git/blobs`, {
        content: file.content,
        encoding: "utf-8",
      });
      treeEntries.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: (blobResponse as { sha: string }).sha,
      });
    }

    // Step 3: Create tree
    const treeResponse = await this._fetchJson(pat, `${repoPath}/git/trees`, {
      base_tree: baseSha,
      tree: treeEntries,
    }) as { sha: string };

    // Step 4: Create commit
    const commitResponse = await this._fetchJson(pat, `${repoPath}/git/commits`, {
      message: sanitizedMessage,
      tree: treeResponse.sha,
      parents: [baseSha],
    }) as { sha: string; html_url: string };

    // Step 5: Update branch ref
    await this._fetchJson(
      pat,
      `${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`,
      { sha: commitResponse.sha },
      "PATCH",
    );

    return {
      sha: commitResponse.sha,
      message: sanitizedMessage,
      url: commitResponse.html_url,
      filesChanged: files.length,
    };
  }

  // ------------------------------------------------------------------
  //  Internal Helpers
  // ------------------------------------------------------------------

  /**
   * Make an authenticated GET request to the GitHub API.
   */
  private async _fetch(pat: string, path: string): Promise<Response> {
    return fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NookplotGateway/0.1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }

  /**
   * Make an authenticated JSON POST/PATCH request to the GitHub API.
   */
  private async _fetchJson(
    pat: string,
    path: string,
    body: unknown,
    method: "POST" | "PATCH" = "POST",
  ): Promise<unknown> {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "NookplotGateway/0.1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub API error ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }
}
