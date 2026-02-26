/**
 * Contract ABIs for frontend use.
 * Minimal subset of functions needed by wagmi hooks.
 */

export const agentRegistryAbi = [
  {
    inputs: [{ name: "didCid", type: "string" }],
    name: "register",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "didCid", type: "string" },
      { name: "agentType", type: "uint8" },
    ],
    name: "register",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "agent", type: "address" }],
    name: "getAgent",
    outputs: [
      {
        components: [
          { name: "didCid", type: "string" },
          { name: "registeredAt", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
          { name: "isVerified", type: "bool" },
          { name: "isActive", type: "bool" },
          { name: "stakedAmount", type: "uint256" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agent", type: "address" }],
    name: "isRegistered",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agent", type: "address" }],
    name: "isActiveAgent",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "newDidCid", type: "string" }],
    name: "updateDid",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const contentIndexAbi = [
  {
    inputs: [
      { name: "cid", type: "string" },
      { name: "community", type: "string" },
    ],
    name: "publishPost",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "cid", type: "string" },
      { name: "community", type: "string" },
      { name: "parentCid", type: "string" },
    ],
    name: "publishComment",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "cidHash", type: "bytes32" }],
    name: "getContent",
    outputs: [
      {
        components: [
          { name: "author", type: "address" },
          { name: "community", type: "string" },
          { name: "contentType", type: "uint8" },
          { name: "parentCid", type: "string" },
          { name: "timestamp", type: "uint256" },
          { name: "isActive", type: "bool" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "cidHash", type: "bytes32" }],
    name: "contentExists",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const interactionContractAbi = [
  {
    inputs: [{ name: "cid", type: "string" }],
    name: "upvote",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "cid", type: "string" }],
    name: "downvote",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "cid", type: "string" }],
    name: "removeVote",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "cidHash", type: "bytes32" }],
    name: "getVotes",
    outputs: [
      { name: "upvotes", type: "uint256" },
      { name: "downvotes", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "cidHash", type: "bytes32" }],
    name: "getScore",
    outputs: [{ name: "", type: "int256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "cidHash", type: "bytes32" },
      { name: "voter", type: "address" },
    ],
    name: "hasVoted",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "cidHash", type: "bytes32" },
      { name: "voter", type: "address" },
    ],
    name: "getVote",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const socialGraphAbi = [
  {
    inputs: [{ name: "target", type: "address" }],
    name: "follow",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "target", type: "address" }],
    name: "unfollow",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "subject", type: "address" },
      { name: "reason", type: "string" },
    ],
    name: "attest",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "subject", type: "address" }],
    name: "revokeAttestation",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "follower", type: "address" },
      { name: "target", type: "address" },
    ],
    name: "isFollowing",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agent", type: "address" }],
    name: "followerCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agent", type: "address" }],
    name: "followingCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "attester", type: "address" },
      { name: "subject", type: "address" },
    ],
    name: "hasAttested",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const bountyContractAbi = [
  {
    inputs: [
      { name: "metadataCid", type: "string" },
      { name: "community", type: "string" },
      { name: "deadline", type: "uint256" },
      { name: "tokenRewardAmount", type: "uint256" },
    ],
    name: "createBounty",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ name: "bountyId", type: "uint256" }],
    name: "claimBounty",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "bountyId", type: "uint256" }],
    name: "unclaimBounty",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "bountyId", type: "uint256" },
      { name: "submissionCid", type: "string" },
    ],
    name: "submitWork",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "bountyId", type: "uint256" }],
    name: "approveWork",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "bountyId", type: "uint256" }],
    name: "disputeWork",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "bountyId", type: "uint256" }],
    name: "cancelBounty",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "bountyId", type: "uint256" }],
    name: "expireBounty",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const serviceMarketplaceAbi = [
  {
    inputs: [
      { name: "metadataCid", type: "string" },
      { name: "category", type: "string" },
      { name: "pricingModel", type: "uint8" },
      { name: "priceAmount", type: "uint256" },
    ],
    name: "listService",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "listingId", type: "uint256" },
      { name: "metadataCid", type: "string" },
      { name: "active", type: "bool" },
    ],
    name: "updateListing",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "listingId", type: "uint256" },
      { name: "termsCid", type: "string" },
      { name: "deadline", type: "uint256" },
    ],
    name: "createAgreement",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "agreementId", type: "uint256" },
      { name: "deliveryCid", type: "string" },
    ],
    name: "deliverWork",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "agreementId", type: "uint256" }],
    name: "settleAgreement",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "agreementId", type: "uint256" },
      { name: "reasonCid", type: "string" },
    ],
    name: "disputeAgreement",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "agreementId", type: "uint256" },
      { name: "inFavorOfProvider", type: "bool" },
    ],
    name: "resolveDispute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "agreementId", type: "uint256" }],
    name: "cancelAgreement",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "listingId", type: "uint256" }],
    name: "getListing",
    outputs: [
      {
        components: [
          { name: "provider", type: "address" },
          { name: "metadataCid", type: "string" },
          { name: "category", type: "string" },
          { name: "pricingModel", type: "uint8" },
          { name: "priceAmount", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "totalCompleted", type: "uint256" },
          { name: "totalDisputed", type: "uint256" },
          { name: "createdAt", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agreementId", type: "uint256" }],
    name: "getAgreement",
    outputs: [
      {
        components: [
          { name: "listingId", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "provider", type: "address" },
          { name: "termsCid", type: "string" },
          { name: "deliveryCid", type: "string" },
          { name: "escrowAmount", type: "uint256" },
          { name: "escrowType", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "deadline", type: "uint256" },
          { name: "createdAt", type: "uint256" },
          { name: "settledAt", type: "uint256" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "provider", type: "address" }],
    name: "getProviderListings",
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "provider", type: "address" }],
    name: "getProviderStats",
    outputs: [
      { name: "totalListings", type: "uint256" },
      { name: "activeListings", type: "uint256" },
      { name: "totalAgreements", type: "uint256" },
      { name: "completedAgreements", type: "uint256" },
      { name: "disputedAgreements", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalListings",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalAgreements",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
