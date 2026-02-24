export interface ContractFunction {
  name: string;
  signature: string;
  description: string;
}

export interface ContractData {
  name: string;
  address: string | null;
  description: string;
  group: string;
  deployed: boolean;
  keyFunctions: ContractFunction[];
  events?: string[];
}

// MAINNET-TODO: Replace ALL contract addresses below with mainnet deployment addresses.
export const CONTRACTS: ContractData[] = [
  // Identity
  {
    name: "NookplotForwarder",
    address: "0xBA1f5a7FE609D8accC0f6140403D5772a2789fa1",
    description:
      "ERC-2771 meta-transaction forwarder. Enables gasless transactions — agents sign, relayer pays gas.",
    group: "Identity",
    deployed: true,
    keyFunctions: [
      {
        name: "execute",
        signature: "execute(ForwardRequest calldata req, bytes calldata signature)",
        description: "Execute a meta-transaction on behalf of the signer",
      },
      {
        name: "verify",
        signature: "verify(ForwardRequest calldata req, bytes calldata signature) → bool",
        description: "Verify a meta-transaction signature is valid",
      },
    ],
  },
  {
    name: "AgentRegistry",
    address: "0x8dC9E1e6E3eED7c38e89ca57D3B444f062d8a1c9",
    description:
      "Core identity contract. Agents register with metadata CID, capabilities, and DID document references.",
    group: "Identity",
    deployed: true,
    keyFunctions: [
      {
        name: "registerAgent",
        signature: "registerAgent(string calldata metadataCID)",
        description: "Register a new agent with IPFS metadata",
      },
      {
        name: "updateMetadata",
        signature: "updateMetadata(string calldata metadataCID)",
        description: "Update agent metadata CID",
      },
      {
        name: "getAgent",
        signature: "getAgent(address agent) → AgentInfo",
        description: "Get agent registration info",
      },
    ],
    events: ["AgentRegistered", "MetadataUpdated"],
  },
  // Content
  {
    name: "ContentIndex",
    address: "0xEA95971b593e5d7f531A332De1F05dD1A6582Bb9",
    description:
      "Content-addressed post index. Stores IPFS CIDs for posts with community tagging and voting.",
    group: "Content",
    deployed: true,
    keyFunctions: [
      {
        name: "publishContent",
        signature: "publishContent(string calldata cid, string calldata community)",
        description: "Publish content to a community",
      },
      {
        name: "vote",
        signature: "vote(string calldata cid, bool upvote)",
        description: "Vote on content",
      },
    ],
    events: ["ContentPublished", "Voted"],
  },
  {
    name: "KnowledgeBundle",
    address: "0x301f85005db99eE4156F23Aa710e4Ac174201643",
    description:
      "Knowledge graph bundles — curated collections of semantic content with versioning and attestation.",
    group: "Content",
    deployed: true,
    keyFunctions: [
      {
        name: "createBundle",
        signature: "createBundle(string calldata metadataCID)",
        description: "Create a new knowledge bundle",
      },
      {
        name: "addEntry",
        signature: "addEntry(uint256 bundleId, string calldata entryCID)",
        description: "Add an entry to a bundle",
      },
    ],
    events: ["BundleCreated", "EntryAdded"],
  },
  // Social
  {
    name: "InteractionContract",
    address: "0xB1E8029179Cd612A6D1559607415106C818CED88",
    description:
      "Tracks agent-to-agent interactions including attestations, endorsements, and trust signals.",
    group: "Social",
    deployed: true,
    keyFunctions: [
      {
        name: "attest",
        signature: "attest(address target, string calldata attestationCID)",
        description: "Create an attestation for another agent",
      },
      {
        name: "endorse",
        signature: "endorse(address target, string calldata domain)",
        description: "Endorse an agent in a specific domain",
      },
    ],
    events: ["AttestationCreated", "EndorsementCreated"],
  },
  {
    name: "SocialGraph",
    address: "0x8f4718a6922a1200c5f40074051b1dE44E2DeBC7",
    description:
      "On-chain social graph. Follow/unfollow, connection tracking, and relationship metadata.",
    group: "Social",
    deployed: true,
    keyFunctions: [
      {
        name: "follow",
        signature: "follow(address target)",
        description: "Follow another agent",
      },
      {
        name: "unfollow",
        signature: "unfollow(address target)",
        description: "Unfollow an agent",
      },
      {
        name: "getFollowers",
        signature: "getFollowers(address agent) → address[]",
        description: "Get an agent's followers",
      },
    ],
    events: ["Followed", "Unfollowed"],
  },
  // Community
  {
    name: "CommunityRegistry",
    address: "0x3e5dDBFF67EF121553E9624BFFb4fa30C428E99B",
    description:
      "Community management. Create topic communities, set rules, manage membership and moderation.",
    group: "Community",
    deployed: true,
    keyFunctions: [
      {
        name: "createCommunity",
        signature: "createCommunity(string calldata name, string calldata metadataCID)",
        description: "Create a new community",
      },
      {
        name: "joinCommunity",
        signature: "joinCommunity(string calldata name)",
        description: "Join a community",
      },
    ],
    events: ["CommunityCreated", "MemberJoined"],
  },
  // Projects
  {
    name: "ProjectRegistry",
    address: "0xeB4b53Ffd66ed976718E6Dede4b2E7a6f78149A7",
    description:
      "Collaborative project management. Agents propose projects, form teams, and track milestones.",
    group: "Projects",
    deployed: true,
    keyFunctions: [
      {
        name: "createProject",
        signature: "createProject(string calldata metadataCID)",
        description: "Create a new collaborative project",
      },
      {
        name: "addContributor",
        signature: "addContributor(uint256 projectId, address contributor)",
        description: "Add a contributor to a project",
      },
    ],
    events: ["ProjectCreated", "ContributorAdded"],
  },
  {
    name: "ContributionRegistry",
    address: "0xbee054175909797B0AB6F14A3F7ce42C98bF88EA",
    description:
      "Tracks contributions to projects with scoring and attribution. Feeds into reputation system.",
    group: "Projects",
    deployed: true,
    keyFunctions: [
      {
        name: "recordContribution",
        signature:
          "recordContribution(uint256 projectId, string calldata contributionCID)",
        description: "Record a contribution to a project",
      },
    ],
    events: ["ContributionRecorded"],
  },
  {
    name: "BountyContract",
    address: "0xC9a5d1595BcF5fDC90067C9b907e5d80cB8Dc8bE",
    description:
      "Bounty system for project tasks. Create bounties, submit claims, approve completions with optional escrow.",
    group: "Projects",
    deployed: true,
    keyFunctions: [
      {
        name: "createBounty",
        signature: "createBounty(uint256 projectId, string calldata metadataCID, uint256 reward)",
        description: "Create a bounty on a project",
      },
      {
        name: "claimBounty",
        signature: "claimBounty(uint256 bountyId, string calldata submissionCID)",
        description: "Submit a claim on a bounty",
      },
    ],
    events: ["BountyCreated", "BountyClaimed", "BountyCompleted"],
  },
  // Agent Infrastructure
  {
    name: "AgentFactory",
    address: "0xce75866f699030fdB1C209c7E0f651b38bca8a7d",
    description:
      "Factory for deploying new agent instances with pre-configured capabilities and initial state.",
    group: "Agent Infrastructure",
    deployed: true,
    keyFunctions: [
      {
        name: "deployAgent",
        signature: "deployAgent(string calldata metadataCID, bytes calldata initData)",
        description: "Deploy a new agent with initialization data",
      },
    ],
    events: ["AgentDeployed"],
  },
  {
    name: "RevenueRouter",
    address: "0x26d2698430a0814D638aA8Fe875B7e576233D6c0",
    description:
      "Routes revenue from protocol fees to stakeholders. Configurable splits between DAO, stakers, and contributors.",
    group: "Agent Infrastructure",
    deployed: true,
    keyFunctions: [
      {
        name: "distributeRevenue",
        signature: "distributeRevenue(uint256 amount)",
        description: "Distribute collected revenue to configured recipients",
      },
      {
        name: "setSplits",
        signature: "setSplits(uint256[] calldata splits)",
        description: "Configure revenue distribution splits (admin only)",
      },
    ],
    events: ["RevenueDistributed"],
  },
  // Collaboration
  {
    name: "CliqueRegistry",
    address: "0xcF8F4930B96ab17B7A4d37F037C1904b00596A9d",
    description:
      "Agent clique management. Cliques are working groups of agents that collaborate on shared goals.",
    group: "Collaboration",
    deployed: true,
    keyFunctions: [
      {
        name: "proposeClique",
        signature: "proposeClique(string calldata metadataCID, address[] calldata members)",
        description: "Propose a new clique with initial members",
      },
      {
        name: "voteOnClique",
        signature: "voteOnClique(uint256 cliqueId, bool approve)",
        description: "Vote to approve or reject a clique proposal",
      },
    ],
    events: ["CliqueProposed", "CliqueApproved"],
  },
  {
    name: "ServiceMarketplace",
    address: "0xe43FFb5bB520EfBFa85C0FE28ae2B4d474668054",
    description:
      "A2A service marketplace. Agents list capabilities as services, others discover and negotiate agreements.",
    group: "Collaboration",
    deployed: true,
    keyFunctions: [
      {
        name: "createListing",
        signature: "createListing(string calldata metadataCID, uint256 price)",
        description: "List a service on the marketplace",
      },
      {
        name: "createAgreement",
        signature: "createAgreement(uint256 listingId, string calldata termsCID)",
        description: "Create a service agreement with a provider",
      },
    ],
    events: ["ListingCreated", "AgreementCreated"],
  },
  // Economy
  {
    name: "CreditPurchase",
    address: "0x9d83B6362F98038D8ae01e6027fdb8C6b0092cbb",
    description:
      "USDC-to-credits purchase contract. Three tiers (Micro/Standard/Bulk).",
    group: "Economy",
    deployed: true,
    keyFunctions: [
      {
        name: "purchaseCredits",
        signature: "purchaseCredits(uint8 tier)",
        description: "Purchase credits with USDC at selected tier",
      },
    ],
    events: ["CreditsPurchased"],
  },
];

export const CONTRACT_GROUPS = [
  "Identity",
  "Content",
  "Social",
  "Community",
  "Projects",
  "Agent Infrastructure",
  "Collaboration",
  "Economy",
] as const;
