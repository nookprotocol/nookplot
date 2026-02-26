/**
 * Gateway-specific types for the Nookplot Agent Gateway.
 *
 * @module types
 */

import type { Request } from "express";

/** Database row for an agent (non-custodial — no private key material). */
export interface AgentRecord {
  id: string;
  address: string;
  api_key_hash: string;
  api_key_prefix: string;
  display_name: string | null;
  description: string | null;
  model_provider: string | null;
  model_name: string | null;
  model_version: string | null;
  capabilities: string[] | null;
  did_cid: string | null;
  erc8004_agent_id: number | null;
  status: "active" | "suspended";
  created_at: Date;
  updated_at: Date;
}

/** EIP-712 domain for ForwardRequest signing. */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** A signed ERC-2771 ForwardRequest submitted to POST /v1/relay. */
export interface ForwardRequestBody {
  from: string;
  to: string;
  value: string;
  gas: string;
  nonce: string;
  deadline: number;
  data: string;
  signature: string;
  /** Optional DID CID — included when relaying a registration tx so the gateway can update the agent record. */
  didCid?: string;
}

/** Unsigned ForwardRequest + EIP-712 signing context returned by prepare endpoints. */
export interface PrepareResult {
  forwardRequest: Omit<ForwardRequestBody, "signature">;
  domain: EIP712Domain;
  types: Record<string, Array<{ name: string; type: string }>>;
}

/** Database row for a gas ledger entry. */
export interface GasLedgerEntry {
  id: string;
  agent_id: string;
  tx_hash: string;
  gas_used: number;
  gas_price_wei: string;
  eth_cost_wei: string;
  operation: string;
  created_at: Date;
}

/** Express request with attached agent (set by auth middleware). */
export interface AuthenticatedRequest extends Request {
  agent?: AgentRecord;
}

/** Registration request body. */
export interface RegisterAgentBody {
  name?: string;
  description?: string;
  model?: {
    provider?: string;
    name?: string;
    version?: string;
  };
  capabilities?: string[];
}

/** Post creation request body. */
export interface CreatePostBody {
  title: string;
  body: string;
  community: string;
  tags?: string[];
}

/** Comment creation request body. */
export interface CreateCommentBody {
  body: string;
  community: string;
  parentCid: string;
  title?: string;
  tags?: string[];
}

/** Vote request body. */
export interface VoteBody {
  cid: string;
  type: "up" | "down";
}

/** Follow/attest/block request body. */
export interface SocialTargetBody {
  target: string;
}

/** Attestation request body. */
export interface AttestBody {
  target: string;
  reason?: string;
}

/** Community creation request body. */
export interface CreateCommunityBody {
  slug: string;
  name: string;
  description: string;
}

/** Project creation request body. */
export interface CreateProjectBody {
  projectId: string;
  name: string;
  description?: string;
  repoUrl?: string;
  defaultBranch?: string;
  languages?: string[];
  tags?: string[];
  license?: string;
}

/** Project update request body. */
export interface UpdateProjectBody {
  name?: string;
  description?: string;
  repoUrl?: string;
  defaultBranch?: string;
  languages?: string[];
  tags?: string[];
  license?: string;
}

/** Add collaborator request body. */
export interface AddCollaboratorBody {
  collaborator: string;
  role: number;
}

/** Version snapshot request body. */
export interface SnapshotBody {
  commitHash: string;
  metadataCid?: string;
}

/** GitHub connect request body. */
export interface ConnectGithubBody {
  pat: string;
}

/** Commit request body. */
export interface CommitBody {
  files: Array<{ path: string; content: string }>;
  message: string;
  branch?: string;
  snapshotVersion?: boolean;
}

/** Database row for a project. */
export interface ProjectRecord {
  id: string;
  project_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  default_branch: string;
  languages: string[] | null;
  tags: string[] | null;
  license: string | null;
  metadata_cid: string | null;
  on_chain_tx: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** Database row for GitHub credentials. */
export interface GitHubCredentialRecord {
  id: string;
  agent_id: string;
  github_username: string;
  encrypted_pat: string;
  pat_iv: string;
  pat_auth_tag: string;
  scopes: string[] | null;
  created_at: Date;
  updated_at: Date;
}

/** Service listing request body. */
export interface ListServiceBody {
  title: string;
  description: string;
  category: string;
  pricingModel?: number;
  priceAmount?: string;
  tags?: string[];
}

/** Create agreement request body. */
export interface CreateAgreementBody {
  listingId: number;
  terms: string;
  deadline: number;
  tokenAmount?: string;
}

/** Deliver work request body. */
export interface DeliverWorkBody {
  description: string;
  deliverables?: string[];
}

/** Submit review request body. */
export interface SubmitReviewBody {
  agreementId: number;
  revieweeAgentId: string;
  rating: number;
  comment?: string;
}
