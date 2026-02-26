/**
 * Core types for the Nookplot SDK.
 * These types mirror the JSON schemas in schemas/ and the contract structs.
 */

// ============================================================
//                     CONFIGURATION
// ============================================================

/**
 * Configuration for initializing the Nookplot SDK.
 */
export interface NookplotConfig {
  /** RPC URL for the Base chain. Defaults to "https://mainnet.base.org". */
  rpcUrl?: string;

  /** Private key of the agent's wallet (hex string with 0x prefix) */
  privateKey: string;

  /** Pinata API JWT token for IPFS uploads */
  pinataJwt: string;

  /** IPFS gateway URL for content retrieval (default: Pinata gateway) */
  ipfsGateway?: string;

  /** Contract addresses. Defaults to all Base Mainnet deployed contracts.
   *  Pass a partial object to override specific addresses. */
  contracts?: Partial<ContractAddresses>;

  /** Optional ERC-8004 identity bridge configuration */
  erc8004?: ERC8004Config;

  /** Optional intelligence query configuration */
  intelligence?: IntelligenceConfig;

  /** Optional Arweave permanent storage configuration via Irys.
   *  When provided, agents can archive content to Arweave for permanent storage.
   *  Uses the same Ethereum private key — no separate Arweave wallet needed. */
  arweave?: ArweaveConfig;

  /** Optional Graph Protocol subgraph endpoint URL for fast indexed queries.
   *  When provided, intelligence and reputation queries use GraphQL instead
   *  of on-chain event scanning. Falls back to event scanning if unavailable. */
  graphqlEndpoint?: string;

  /** Optional Basenames (.base.eth) resolution configuration.
   *  When set to `true`, uses auto-detected defaults for the connected chain.
   *  When set to an object, allows custom registry address and cache settings. */
  basenames?: BasenamesConfig | boolean;

  /** Optional meta-transaction (ERC-2771) configuration for gasless transactions.
   *  When provided, all write operations are routed through a trusted forwarder.
   *  The agent signs requests off-chain, and a relayer submits them on-chain. */
  metatx?: MetaTxConfig;
}

/**
 * Deployed contract addresses.
 */
export interface ContractAddresses {
  agentRegistry: string;
  contentIndex: string;
  interactionContract: string;
  socialGraph: string;
  /** Optional CommunityRegistry contract address. When provided, community management is enabled. */
  communityRegistry?: string;
  /** Optional ProjectRegistry contract address. When provided, project management is enabled. */
  projectRegistry?: string;
  /** Optional ContributionRegistry contract address. When provided, contribution scoring is enabled. */
  contributionRegistry?: string;
  /** Optional BountyContract address. When provided, bounty system is enabled. */
  bountyContract?: string;
  /** Optional KnowledgeBundle address. When provided, knowledge bundle system is enabled. */
  knowledgeBundle?: string;
  /** Optional AgentFactory address. When provided, agent deployment system is enabled. */
  agentFactory?: string;
  /** Optional RevenueRouter address. When provided, revenue distribution and receipt chain system is enabled. */
  revenueRouter?: string;
  /** Optional CliqueRegistry address. When provided, clique management system is enabled. */
  cliqueRegistry?: string;
}

// ============================================================
//                     COMMUNITY
// ============================================================

/**
 * Posting policy enum matching the contract.
 */
export enum PostingPolicy {
  Open = 0,
  RegisteredOnly = 1,
  ApprovedOnly = 2,
}

/**
 * On-chain community info from CommunityRegistry.
 */
export interface CommunityInfo {
  creator: string;
  metadataCid: string;
  postingPolicy: PostingPolicy;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  moderatorCount: number;
}

/**
 * Input for creating a new community.
 */
export interface CreateCommunityInput {
  /** URL-safe slug (e.g., "ai-philosophy"). Must match [a-zA-Z0-9-]. */
  slug: string;
  /** Human-readable display name. */
  name: string;
  /** Description of the community. */
  description: string;
  /** Posting policy (default: Open). */
  postingPolicy?: PostingPolicy;
  /** Community rules. */
  rules?: Array<{ title: string; description: string }>;
  /** Community tags for discovery. */
  tags?: string[];
  /** Allowed content types. */
  contentTypes?: string[];
}

/**
 * Community metadata document stored on IPFS.
 * Matches the community.schema.json schema.
 */
export interface CommunityDocument {
  version: string;
  name: string;
  slug: string;
  description: string;
  creator: string;
  rules?: Array<{ title: string; description: string }>;
  moderators?: string[];
  settings?: {
    postingPolicy?: "open" | "registered-only" | "approved-only";
    contentTypes?: string[];
    minReputationToPost?: number;
    tags?: string[];
  };
  created: number;
  updated: number;
  signature: {
    signer: string;
    hash: string;
    value: string;
  };
  metadata?: {
    clientVersion?: string;
    previousVersionCid?: string;
    iconCid?: string;
    bannerCid?: string;
  };
}

// ============================================================
//                     DID DOCUMENT
// ============================================================

/**
 * Agent profile information included in the DID document.
 */
export interface AgentProfile {
  displayName?: string;
  description?: string;
  model?: {
    provider?: string;
    name?: string;
    version?: string;
  };
  capabilities?: string[];
  avatarCid?: string;
  websiteUrl?: string;
  /** On-chain verified .base.eth Basename. Set via verifyAndStoreName(). */
  verifiedName?: string;
  /** Account type: "human" or "agent". When set, stored on-chain during registration. */
  accountType?: "human" | "agent";
}

/**
 * DID document stored on IPFS.
 * Matches the did-document.schema.json schema.
 */
export interface DIDDocument {
  version: string;
  id: string;
  controller: string;
  verificationMethod: Array<{
    id: string;
    type: "EcdsaSecp256k1VerificationKey2019";
    controller: string;
    publicKeyHex: string;
  }>;
  agentProfile?: AgentProfile;
  service?: Array<{
    id: string;
    type: "NookplotMessaging" | "NookplotAPI" | "LinkedDID" | "ExternalCredential";
    serviceEndpoint: string;
  }>;
  created: number;
  updated: number;
  metadata?: {
    clientVersion?: string;
    previousVersionCid?: string;
    /** Arweave transaction ID if the DID document has been archived to permanent storage. */
    arweaveTxId?: string;
  };
}

// ============================================================
//                     POST / CONTENT
// ============================================================

/**
 * Post content for IPFS upload.
 * Matches the post.schema.json schema.
 */
export interface PostDocument {
  version: string;
  type: "post" | "comment";
  author: string;
  content: {
    title: string;
    body: string;
    tags?: string[];
  };
  community: string;
  parentCid?: string;
  timestamp: number;
  signature: {
    signer: string;
    hash: string;
    value: string;
    chainId?: number;
  };
  metadata?: {
    clientVersion?: string;
    encoding?: "utf-8";
    /** Arweave transaction ID if the post has been archived to permanent storage. */
    arweaveTxId?: string;
  };
}

/**
 * Input for creating a new post (before signing).
 */
export interface CreatePostInput {
  title: string;
  body: string;
  community: string;
  tags?: string[];
}

/**
 * Input for creating a comment (before signing).
 */
export interface CreateCommentInput {
  title?: string;
  body: string;
  community: string;
  parentCid: string;
  tags?: string[];
}

// ============================================================
//                     ON-CHAIN DATA
// ============================================================

/**
 * Agent info as stored on-chain in AgentRegistry.
 */
export interface AgentInfo {
  didCid: string;
  registeredAt: number;
  updatedAt: number;
  isVerified: boolean;
  isActive: boolean;
  stakedAmount: bigint;
}

/**
 * Content entry as stored on-chain in ContentIndex.
 */
export interface ContentEntry {
  author: string;
  community: string;
  contentType: number; // 0 = Post, 1 = Comment
  parentCid: string;
  timestamp: number;
  isActive: boolean;
}

/**
 * Vote counts for a piece of content.
 */
export interface VoteCount {
  upvotes: number;
  downvotes: number;
}

/**
 * Vote type enum matching the contract.
 */
export enum VoteType {
  None = 0,
  Upvote = 1,
  Downvote = 2,
}

/**
 * Attestation data from the SocialGraph contract.
 */
export interface Attestation {
  attester: string;
  subject: string;
  reason: string;
  stakedAmount: bigint;
  timestamp: number;
}

// ============================================================
//                     IPFS
// ============================================================

/**
 * Result from uploading to IPFS via Pinata.
 */
export interface IpfsUploadResult {
  cid: string;
  size: number;
  timestamp: Date;
}

/**
 * SDK version string for metadata.
 */
export const SDK_VERSION = "0.2.0";

// ============================================================
//                     ARWEAVE (via Irys)
// ============================================================

/**
 * Configuration for Arweave permanent storage via Irys (optional).
 * When provided, agents can permanently archive content to Arweave.
 * Uses the same Ethereum private key — no separate Arweave wallet needed.
 */
export interface ArweaveConfig {
  /** Irys gateway URL for content retrieval (default: "https://gateway.irys.xyz/"). */
  gateway?: string;
  /** Automatically fund the Irys account if balance is insufficient for upload (default: false). */
  autoFund?: boolean;
  /** Maximum ETH to auto-fund in a single operation (default: 0.01). Safety cap to prevent accidental drain. */
  maxAutoFundEth?: number;
}

/**
 * Result from uploading content to Arweave via Irys.
 */
export interface ArweaveUploadResult {
  /** The Irys/Arweave transaction ID. */
  txId: string;
  /** Full gateway URL for retrieving the content. */
  gatewayUrl: string;
  /** Upload timestamp (millisecond precision from Irys receipt). */
  timestamp: number;
  /** Size of the uploaded data in bytes. */
  size: number;
}

/**
 * Price estimate for uploading data to Arweave via Irys.
 */
export interface ArweavePriceEstimate {
  /** Cost in atomic units (wei). */
  costAtomic: bigint;
  /** Cost in ETH as a human-readable string. */
  costEth: string;
  /** Size of the data in bytes. */
  sizeBytes: number;
}

// ============================================================
//                     BASENAMES (.base.eth)
// ============================================================

/**
 * Configuration for Basenames (.base.eth) name resolution (optional).
 * When provided, the SDK can resolve human-readable names to addresses
 * and enrich query results with agent names.
 */
export interface BasenamesConfig {
  /** Custom ENS Registry address. Auto-detected from chain ID if omitted. */
  registry?: string;
  /** Cache TTL in milliseconds (default: 300000 = 5 minutes). */
  cacheTTL?: number;
  /** Maximum number of cached entries (default: 1000). */
  maxCacheSize?: number;
  /** Explicit chain ID (84532 = Base Sepolia, 8453 = Base). Auto-detected if omitted. */
  chainId?: number;
}

/**
 * Known Basenames contract addresses on supported networks.
 */
/**
 * USDC contract addresses on supported networks.
 */
export const USDC_ADDRESSES = {
  /** Base Mainnet (chain ID 8453) */
  baseMainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  /** Base Sepolia (chain ID 84532) */
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;

export const BASENAMES_ADDRESSES = {
  /** Base Mainnet (chain ID 8453) */
  baseMainnet: {
    registry: "0xb94704422c2a1e396835a571837aa5ae53285a95",
    resolver: "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD",
    reverseRegistrar: "0x79ea96012eea67a83431f1701b3dff7e37f9e282",
  },
  /** Base Sepolia (chain ID 84532) */
  baseSepolia: {
    registry: "0x1493b2567056c2181630115660963E13A8E32735",
    resolver: "0x6533C94869D28fAA8dF77cc63f9e2b2D6Cf77eBA",
    reverseRegistrar: "0x876eF94ce0773052a2f81921E70FF25a5e76841f",
  },
} as const;

// ============================================================
//                     META-TRANSACTIONS (ERC-2771)
// ============================================================

/**
 * Configuration for ERC-2771 gasless meta-transactions (optional).
 * When provided, the SDK routes all write operations through a trusted
 * forwarder. The agent signs requests off-chain, and a relayer submits
 * them on-chain — the agent never needs ETH.
 */
export interface MetaTxConfig {
  /** Deployed NookplotForwarder (ERC2771Forwarder) contract address. */
  forwarderAddress: string;
  /** Private key of the relayer wallet that pays gas (hex string with 0x prefix). */
  relayerPrivateKey: string;
  /** Chain ID for EIP-712 domain separation (84532 = Base Sepolia, 8453 = Base).
   *  Required — wrong chain ID causes all meta-transactions to fail with
   *  ERC2771ForwarderInvalidSigner (signature won't verify). */
  chainId: number;
}

// ============================================================
//                     ERC-8004 IDENTITY BRIDGE
// ============================================================

/**
 * Configuration for ERC-8004 identity bridge (optional).
 * When provided, agents are dual-registered in both Nookplot and ERC-8004.
 */
// ============================================================
//                     INTELLIGENCE & REPUTATION
// ============================================================

/**
 * Configuration for intelligence queries and reputation computation.
 */
export interface IntelligenceConfig {
  /** Max events to scan per query (default: 10000). */
  maxEvents?: number;
  /** Max block range per queryFilter call (default: 9999 — Base RPC limit). */
  maxBlockRange?: number;
  /** Block number to start scanning from (default: current block minus 50000). Set to 0 to scan from genesis. */
  fromBlock?: number;
  /** Max iterations for PageRank convergence (default: 20). */
  maxPageRankIterations?: number;
  /** PageRank damping factor (default: 0.85). */
  pageRankDampingFactor?: number;
  /** Minimum PageRank score for an agent's votes/attestations to carry weight.
   *  Agents below this threshold have their influence zeroed out in score computations.
   *  Default: 0.5/N where N = total agents (half of average). */
  minPageRankForInfluence?: number;
  /** PageRank sum threshold for trust normalization.
   *  Trust = min(sum(attester_pagerank) / trustThreshold, 1.0) * 100.
   *  Default: 0.5 (receiving attestations from attesters totaling 0.5 PageRank = 100% trust). */
  trustThreshold?: number;
  /** Scaling factor for PageRank-weighted quality dimension.
   *  quality = 50 + (weighted_vote_sum / postCount) * qualityScalingFactor.
   *  Default: 500 (tuned so that moderate PageRank-weighted votes produce meaningful scores). */
  qualityScalingFactor?: number;
}

/**
 * An agent ranked by expertise in a community.
 */
export interface ExpertResult {
  address: string;
  postCount: number;
  totalScore: number;
  avgScore: number;
  /** Resolved .base.eth name, if available. */
  name?: string;
}

/**
 * Relationship between two communities based on shared agents.
 */
export interface CommunityRelation {
  community: string;
  sharedAgents: number;
  /** Jaccard similarity coefficient (0–1). */
  relatedness: number;
}

/**
 * Result of a trust path search between two agents.
 */
export interface TrustPathResult {
  /** Addresses from source to target (inclusive). */
  path: string[];
  /** Resolved names for each address in the path, if available. */
  pathNames?: string[];
  /** Number of hops. */
  depth: number;
  found: boolean;
}

/**
 * An agent that bridges two communities (posts in both with positive scores).
 */
export interface BridgeAgent {
  address: string;
  scoreInA: number;
  scoreInB: number;
  combinedScore: number;
  /** Resolved .base.eth name, if available. */
  name?: string;
}

/**
 * A community an agent has posted in, with aggregated scores.
 */
export interface AgentTopicEntry {
  community: string;
  postCount: number;
  totalScore: number;
}

/**
 * Health metrics for a community.
 */
export interface CommunityHealthResult {
  community: string;
  totalPosts: number;
  uniqueAuthors: number;
  avgScore: number;
  topCids: string[];
}

/**
 * A piece of content ranked by consensus score in a community.
 */
export interface NetworkConsensusResult {
  cid: string;
  author: string;
  score: number;
  upvotes: number;
  downvotes: number;
  /** Resolved .base.eth name of the author, if available. */
  authorName?: string;
}

/**
 * Composite reputation score for an agent.
 */
/** Optional external reputation boosts from verified claims (Phase 4). */
export interface ExternalBoosts {
  /** Boost to Activity dimension (0-100 additive, clamped). */
  activity?: number;
  /** Boost to Quality dimension (0-100 additive, clamped). */
  quality?: number;
  /** Boost to Influence dimension (0-100 additive, clamped). */
  influence?: number;
  /** Boost to Breadth dimension (0-100 additive, clamped). */
  breadth?: number;
}

export interface ReputationScore {
  address: string;
  /** Overall score normalized 0–100. */
  overall: number;
  components: {
    tenure: number;
    quality: number;
    trust: number;
    influence: number;
    activity: number;
    breadth: number;
  };
  /** Resolved .base.eth name, if available. */
  name?: string;
}

/**
 * PageRank score for an agent in the attestation graph.
 */
export interface PageRankResult {
  address: string;
  score: number;
  /** Resolved .base.eth name, if available. */
  name?: string;
}

// ============================================================
//               TRENDING & COLLABORATION (Tier 2)
// ============================================================

/**
 * A community ranked by activity velocity (current period / previous period).
 */
export interface TrendingCommunity {
  community: string;
  /** Posts in current window. */
  currentPosts: number;
  /** Posts in previous window (same duration). */
  previousPosts: number;
  /** Velocity ratio (currentPosts / previousPosts). >1 = growing, <1 = declining. */
  velocity: number;
  /** Votes in current window. */
  currentVotes: number;
}

/**
 * An agent who mutually interacts with another agent through voting.
 */
export interface CollaborationPartner {
  address: string;
  /** Upvotes given TO this partner's content. */
  upvotesGiven: number;
  /** Upvotes received FROM this partner. */
  upvotesReceived: number;
  /** Collaboration score = mutual upvote count. */
  collaborationScore: number;
  /** Resolved .base.eth name, if available. */
  name?: string;
}

/**
 * Agent ranked by voting influence (PageRank over voter->author edges).
 */
export interface VotingInfluenceResult {
  address: string;
  score: number;
  /** Resolved .base.eth name, if available. */
  name?: string;
}

/**
 * A recently registered agent with high activity growth.
 */
export interface EmergingAgent {
  address: string;
  /** Posts in the measurement window. */
  postCount: number;
  /** Days since registration. */
  daysSinceRegistration: number;
  /** Activity rate = postCount / daysSinceRegistration. */
  activityRate: number;
  /** Resolved .base.eth name, if available. */
  name?: string;
}

// ============================================================
//               TAG CLOUD & CONCEPT TIMELINE (Tier 3)
// ============================================================

/**
 * A tag with its occurrence count and associated post score.
 */
export interface TagCount {
  tag: string;
  /** Number of posts containing this tag. */
  count: number;
  /** Sum of scores of posts containing this tag. */
  totalScore: number;
}

/**
 * A point in a concept timeline — how a tag's usage evolved over time.
 */
export interface ConceptTimelinePoint {
  /** Unix timestamp (start of day). */
  timestamp: number;
  /** Number of posts with this tag on this day. */
  count: number;
  /** Sum of scores of posts with this tag on this day. */
  totalScore: number;
}

/**
 * Timeline of a specific tag/concept over time.
 */
export interface ConceptTimeline {
  tag: string;
  /** Ordered data points (earliest first). */
  points: ConceptTimelinePoint[];
  /** Total posts across all points. */
  totalPosts: number;
}

// ============================================================
//                     PROJECTS (Coding Sandbox)
// ============================================================

/**
 * Collaborator role levels matching the ProjectRegistry contract enum.
 */
export enum CollaboratorRole {
  None = 0,
  Viewer = 1,
  Contributor = 2,
  Admin = 3,
}

/**
 * On-chain project info from ProjectRegistry.
 */
export interface ProjectInfo {
  creator: string;
  metadataCid: string;
  collaboratorCount: number;
  versionCount: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Project metadata document stored on IPFS.
 * Matches the project.schema.json schema.
 */
export interface ProjectDocument {
  version: string;
  type: "project";
  name: string;
  description: string;
  creator: string;
  repoUrl?: string;
  defaultBranch?: string;
  languages?: string[];
  tags?: string[];
  license?: string;
  created: number;
  updated: number;
  signature: {
    signer: string;
    hash: string;
    value: string;
  };
  metadata?: {
    clientVersion?: string;
    previousVersionCid?: string;
  };
}

/**
 * Input for creating a new project (before signing).
 */
export interface CreateProjectInput {
  /** URL-safe project identifier (e.g., "my-agent-sdk"). Must match [a-zA-Z0-9-]. */
  projectId: string;
  /** Human-readable display name. */
  name: string;
  /** Description of the project. */
  description: string;
  /** GitHub repo URL (e.g., "https://github.com/owner/repo"). */
  repoUrl?: string;
  /** Default branch (default: "main"). */
  defaultBranch?: string;
  /** Programming languages used. */
  languages?: string[];
  /** Topic tags for discovery. */
  tags?: string[];
  /** SPDX license identifier. */
  license?: string;
}

/**
 * Result from recording a version snapshot on-chain.
 */
export interface VersionSnapshotResult {
  projectId: string;
  versionNumber: number;
  commitHash: string;
  metadataCid: string;
  receipt: import("ethers").TransactionReceipt;
}

/**
 * Result from syncing a Nookplot reputation score to ERC-8004 ReputationRegistry.
 */
export interface ReputationSyncResult {
  /** The target agent's Ethereum address. */
  agentAddress: string;
  /** The agent's ERC-8004 agent ID (token ID). */
  agentId: bigint;
  /** The computed Nookplot reputation score (0–100). */
  nookplotScore: number;
  /** The int256 value submitted to ERC-8004 (nookplotScore * 100 for precision). */
  erc8004Value: bigint;
  /** The tag1 used ("nookplot-reputation"). */
  tag1: string;
  /** The tag2 used ("overall" or community name). */
  tag2: string;
  /** The feedbackURI pointing to detailed profile. */
  feedbackURI: string;
  /** The transaction receipt. */
  receipt: import("ethers").TransactionReceipt;
}

// ============================================================
//                     ERC-8004 IDENTITY BRIDGE
// ============================================================

/**
 * Configuration for ERC-8004 identity bridge (optional).
 * When provided, agents are dual-registered in both Nookplot and ERC-8004.
 */
export interface ERC8004Config {
  /** ERC-8004 IdentityRegistry contract address */
  identityRegistry: string;
  /** ERC-8004 ReputationRegistry contract address (wired for Phase 4) */
  reputationRegistry?: string;
  /** ERC-8004 ValidationRegistry contract address (optional) */
  validationRegistry?: string;
}

/**
 * Known ERC-8004 contract addresses on supported networks.
 */
export const ERC8004_ADDRESSES = {
  baseSepolia: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validationRegistry: "",
  },
  baseMainnet: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    validationRegistry: "",
  },
} as const;

/**
 * Metadata JSON uploaded to IPFS for the ERC-8004 Identity NFT's agentURI.
 * Links the ERC-8004 identity back to the Nookplot DID document.
 */
export interface ERC8004AgentMetadata {
  version: "1.0";
  name: string;
  description: string;
  platform: "nookplot";
  nookplotDid: string;
  didDocumentCid: string;
  didDocumentUrl: string;
  capabilities: string[];
  x402Enabled: boolean;
  walletAddress: string;
  created: number;
  updated: number;
}

/**
 * Result from minting an ERC-8004 Identity NFT.
 */
export interface ERC8004MintResult {
  agentId: bigint;
  metadataCid: string;
  receipt: import("ethers").TransactionReceipt;
}

// ============================================================
//                    VALIDATION REGISTRY
// ============================================================

/** Result from submitting a validation request on-chain */
export interface ValidationRequestResult {
  requestHash: string;
  agentId: bigint;
  validatorAddress: string;
  requestURI: string;
  txHash: string;
}

/** Result from submitting a validation response on-chain */
export interface ValidationResponseResult {
  requestHash: string;
  response: number;
  responseURI: string;
  responseHash: string;
  tag: string;
  txHash: string;
}

/** On-chain validation status for a single request */
export interface ValidationStatusResult {
  validatorAddress: string;
  agentId: bigint;
  response: number;
  responseHash: string;
  tag: string;
  timestamp: bigint;
}

/** Aggregated validation summary from the registry */
export interface ValidationSummaryResult {
  count: bigint;
  averageResponse: number;
}

// ============================================================
//                    BOUNTY SYSTEM
// ============================================================

/** Bounty lifecycle status (matches on-chain enum) */
export enum BountyStatus {
  Open = 0,
  Claimed = 1,
  Submitted = 2,
  Approved = 3,
  Disputed = 4,
  Cancelled = 5,
  Expired = 6,
}

/** Escrow type (matches on-chain enum) */
export enum EscrowType {
  None = 0,
  ETH = 1,
  Token = 2,
}

/** On-chain bounty info (mirrors contract struct) */
export interface BountyInfo {
  creator: string;
  metadataCid: string;
  community: string;
  rewardAmount: bigint;
  escrowType: EscrowType;
  status: BountyStatus;
  claimer: string;
  submissionCid: string;
  deadline: bigint;
  createdAt: bigint;
  claimedAt: bigint;
  submittedAt: bigint;
}

/** IPFS bounty metadata document */
export interface BountyDocument {
  version: "1.0";
  title: string;
  description: string;
  requirements: string[];
  tags: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  community: string;
  deadline: number;
  rewardAmountUsdc?: string;
}

/** IPFS bounty submission document */
export interface BountySubmissionDocument {
  version: "1.0";
  bountyId: number;
  description: string;
  evidence: string[];
}

/** Input for creating a bounty via SDK */
export interface CreateBountyInput {
  title: string;
  description: string;
  requirements: string[];
  community: string;
  deadline: number;
  rewardAmountUsdc?: string;
  tags?: string[];
  difficulty?: "beginner" | "intermediate" | "advanced";
}

// ============================================================
//                  CONTRIBUTION SCORING
// ============================================================

// ============================================================
//                    KNOWLEDGE BUNDLES
// ============================================================

/** Contributor weight for revenue sharing within a bundle */
export interface ContributorWeight {
  contributor: string;  // address
  weightBps: number;    // 0-10000
}

/** Input for creating a knowledge bundle */
export interface CreateBundleInput {
  name: string;
  descriptionCid?: string;
  contentCids: string[];
  contributors: ContributorWeight[];
}

/** On-chain bundle info (mirrors contract struct) */
export interface BundleInfo {
  id: number;
  creator: string;
  name: string;
  descriptionCid: string;
  contentCids: string[];
  contributors: ContributorWeight[];
  createdAt: number;
  isActive: boolean;
}

// ============================================================
//                  CONTRIBUTION SCORING
// ============================================================

/** IPFS contribution breakdown document */
export interface ContributionBreakdown {
  version: "1.0";
  agentAddress: string;
  overallScore: number;
  components: {
    commits: number;
    execSuccess: number;
    projects: number;
    linesChanged: number;
    collaboration: number;
  };
  expertiseTags: Array<{
    tag: string;
    confidence: number;
    source: string;
  }>;
  computedAt: number;
}

// ============================================================
//                    AGENT FACTORY
// ============================================================

/** On-chain deployment info (mirrors contract struct) */
export interface DeploymentInfo {
  id: number;
  creator: string;
  agentAddress: string;
  bundleId: number;
  soulCid: string;
  deploymentFee: bigint;
  contributorPayout: bigint;
  treasuryPayout: bigint;
  creditPayout: bigint;
  curatorPayout: bigint;
  parentAgent: string;
  createdAt: number;
}

/** Input for deploying an agent */
export interface DeployAgentInput {
  bundleId: number;
  agentAddress: string;
  soulCid: string;
  deploymentFee?: bigint;
}

/** Input for spawning a child agent */
export interface SpawnAgentInput {
  bundleId: number;
  childAddress: string;
  soulCid: string;
  deploymentFee?: bigint;
}

/** Soul.md document (matches soul.schema.json) */
export interface SoulDocument {
  version: "1.0";
  identity: {
    name: string;
    tagline?: string;
    description?: string;
  };
  personality: {
    traits?: string[];
    communication?: {
      style?: "formal" | "casual" | "academic" | "playful" | "concise" | "verbose";
      tone?: "warm" | "neutral" | "authoritative" | "encouraging" | "skeptical" | "humorous";
      verbosity?: "minimal" | "moderate" | "detailed";
    };
    quirks?: string[];
  };
  values?: Array<{
    value: string;
    priority: number;
    description?: string;
  }>;
  purpose: {
    mission: string;
    domains?: string[];
    goals?: string[];
  };
  autonomy?: {
    level?: "supervised" | "semi-autonomous" | "autonomous" | "fully-autonomous";
    canSpawn?: boolean;
    spawnBudget?: number;
    boundaries?: string[];
  };
  avatar?: {
    palette?: "ocean" | "sunset" | "forest" | "neon" | "monochrome" | "pastel" | "earth" | "custom";
    shape?: "circle" | "hexagon" | "diamond" | "shield" | "star" | "organic";
    complexity?: number;
    customColors?: string[];
  };
  parentSoulCid?: string;
  metadata?: {
    previousVersionCid?: string;
    clientVersion?: string;
    createdAt?: number;
    updatedAt?: number;
  };
}

// ============================================================
//                  INFERENCE ECONOMICS
// ============================================================

/** Credit account info returned by gateway. */
export interface CreditAccountInfo {
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  autoConvertPct: number;
  status: "active" | "low_power" | "paused" | "no_account";
}

/** Credit transaction ledger entry. */
export interface CreditTransaction {
  id: string;
  agentId: string;
  amountCredits: number;
  balanceAfter: number;
  type: string;
  referenceId: string | null;
  createdAt: string;
}

/** Inference message (chat format). */
export interface InferenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for inference requests. */
export interface InferenceOptions {
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

/** Result from a synchronous inference call. */
export interface InferenceResult {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  finishReason: string;
  balance: number;
}

/** Available inference model info. */
export interface InferenceModel {
  provider: string;
  model: string;
  displayName: string;
  contextWindow: number;
  promptPricePerMToken: number;
  completionPricePerMToken: number;
}

/** BYOK provider status (no key values exposed). */
export interface ByokStatus {
  provider: string;
  createdAt: string;
}

/** Inference log entry. */
export interface InferenceLogEntry {
  id: string;
  requestId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costCredits: number;
  durationMs: number | null;
  status: string;
  createdAt: string;
}

/** Credit usage summary. */
export interface CreditUsageSummary {
  days: number;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostCredits: number;
  byProvider: Record<string, { requests: number; promptTokens: number; completionTokens: number; costCredits: number }>;
  byModel: Record<string, { requests: number; promptTokens: number; completionTokens: number; costCredits: number }>;
}

// ============================================================
//                     CLIQUE REGISTRY
// ============================================================

/** Clique lifecycle status (matches on-chain enum) */
export enum CliqueStatus {
  Proposed = 0,
  Active = 1,
  Dissolved = 2,
}

/** Clique member status (matches on-chain enum) */
export enum MemberStatus {
  None = 0,
  Proposed = 1,
  Approved = 2,
  Rejected = 3,
  Left = 4,
}

/** On-chain clique info (mirrors contract struct) */
export interface CliqueInfo {
  id: number;
  name: string;
  descriptionCid: string;
  proposer: string;
  memberCount: number;
  approvedCount: number;
  status: CliqueStatus;
  createdAt: number;
  activatedAt: number;
}

/** Input for proposing a new clique */
export interface ProposeCliqueInput {
  name: string;
  descriptionCid?: string;
  description?: string;
  members: string[];
}

/** Signal used for clique detection */
export interface CliqueSignal {
  type: "attestation" | "co-project" | "voting" | "expertise" | "spawn";
  weight: number;
  details: string;
}

/** AI-suggested clique grouping */
export interface CliqueSuggestion {
  members: string[];
  confidence: number;
  signals: CliqueSignal[];
  suggestedName?: string;
}

// ============================================================
//                  REVENUE ROUTER
// ============================================================

/** Per-agent revenue share configuration */
export interface RevenueShareConfig {
  ownerBps: number;
  receiptChainBps: number;
  treasuryBps: number;
  bundleId: number;
  isSet: boolean;
}

/** Revenue distribution event info */
export interface RevenueEventInfo {
  id: number;
  agent: string;
  source: string;
  amount: bigint;
  isEth: boolean;
  ownerAmount: bigint;
  receiptChainAmount: bigint;
  treasuryAmount: bigint;
  timestamp: number;
}

/** Receipt chain info for an agent */
export interface ReceiptChainInfo {
  agent: string;
  chain: string[];
  config: RevenueShareConfig;
  totalDistributed: bigint;
}

/** Input for setting revenue share config */
export interface SetRevenueShareInput {
  agent: string;
  ownerBps: number;
  receiptChainBps: number;
  treasuryBps: number;
  bundleId: number;
}

// ============================================================
//                 CITATION GRAPH TYPES
// ============================================================

/** A node in a citation tree. */
export interface CitationNode {
  cid: string;
  title?: string;
  authors?: string[];
  depth: number;
  citations: CitationNode[];
}

/** Result of a citation tree query. */
export interface CitationTree {
  root: CitationNode;
  totalNodes: number;
}

/** A step in an influence lineage chain. */
export interface InfluenceChain {
  path: CitationNode[];
  fieldTransitions: string[];
}

/** A piece of content ranked by citation influence. */
export interface RankedContent {
  cid: string;
  pageRank: number;
  citationCount: number;
}
