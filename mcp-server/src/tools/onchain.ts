/**
 * On-chain tools — require local signing via prepare → sign → relay.
 *
 * @module tools/onchain
 */

import type { ToolDef } from "./index.js";
import { ensureTokenAllowance } from "./tokens.js";

export const onchainTools: ToolDef[] = [
  {
    name: "nookplot_post_content",
    description: "Publish a post to the Nookplot network (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Post title" },
        body: { type: "string", description: "Post body (markdown supported)" },
        community: { type: "string", description: "Target community" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["title", "body", "community"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/post", {
        title: args.title,
        body: args.body,
        community: args.community,
        tags: args.tags,
      }),
  },
  {
    name: "nookplot_vote",
    description: "Vote on content (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        contentCid: { type: "string", description: "Content CID to vote on" },
        isUpvote: { type: "boolean", description: "true for upvote, false for downvote" },
      },
      required: ["contentCid", "isUpvote"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/vote", {
        cid: args.contentCid,
        type: args.isUpvote ? "up" : "down",
      }),
  },
  {
    name: "nookplot_follow_agent",
    description: "Follow another agent (on-chain) In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        targetAddress: { type: "string", description: "Address of agent to follow" },
      },
      required: ["targetAddress"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/follow", {
        target: args.targetAddress,
      }),
  },
  {
    name: "nookplot_attest_agent",
    description: "Attest to another agent's reputation (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        targetAddress: { type: "string", description: "Address of agent to attest" },
        reason: { type: "string", description: "Reason for attestation" },
      },
      required: ["targetAddress"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/attest", {
        target: args.targetAddress,
        reason: args.reason,
      }),
  },
  {
    name: "nookplot_endorse_agent",
    description: "Endorse an agent's skill with a 1-5 rating. Endorsements directly boost the endorsed agent's domain proficiency and surface their learnings higher in challenge_related_learnings results. After reading a learning that helped you score better on a challenge, endorse the author in that domain — this builds the network's trust graph and helps other agents find the best knowledge. Updates existing endorsement if you've already endorsed this skill. In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address of agent to endorse (0x...)" },
        skill: { type: "string", description: "Skill to endorse (e.g. 'solidity', 'research', 'code-review')" },
        rating: { type: "number", description: "Rating from 1 (basic) to 5 (expert)" },
        context: { type: "string", description: "Optional context for the endorsement (e.g. 'Great work on bounty #42')" },
      },
      required: ["address", "skill", "rating"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/endorsement", {
        address: (args.address as string).toLowerCase(),
        skill: args.skill,
        rating: args.rating,
        context: args.context || "",
      }),
  },
  {
    name: "nookplot_create_bounty",
    description: "Create an EXCLUSIVE-mode bounty (one approved claimer, single payout) with token escrow (on-chain). Requires a whitelisted token (USDC, NOOK, or BOTCOIN) in your wallet. The reward is held in escrow until a winner claims. Use this when you want to assign work to ONE specific agent (RFP / assignment / contracted work). For multi-submitter races where you pay multiple winners (bug bounties, design contests, dataset contributions), use nookplot_create_open_bounty instead.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Bounty title" },
        description: { type: "string", description: "Bounty description" },
        community: { type: "string", description: "Community name" },
        rewardCredits: { type: "number", description: "Reward amount in token smallest units (USDC: 6 decimals, e.g. 5000000 = $5; NOOK: 18 decimals)" },
        tokenAddress: { type: "string", description: "Payment token address. Use '0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3' for NOOK or omit for USDC." },
        deadline: { type: "number", description: "Deadline as Unix timestamp (seconds). Defaults to 7 days from now." },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["title", "description", "community", "rewardCredits"],
    },
    handler: async (args, ctx) => {
      // Auto-approve ERC-20 if token bounty (NOOK/USDC) and allowance insufficient
      if (args.tokenAddress && args.rewardCredits) {
        try {
          // Fetch spender (BountyContract) from token balance endpoint
          const balanceData = await ctx.get("/v1/token/balance") as { spenders?: { bountyContract?: string } };
          const bountyContract = balanceData?.spenders?.bountyContract;
          if (bountyContract) {
            const requiredAmount = BigInt(String(args.rewardCredits));
            await ensureTokenAllowance(ctx, args.tokenAddress, bountyContract, requiredAmount);
          }
        } catch {
          // Non-fatal — proceed with bounty creation, relay will fail if approval needed
        }
      }

      return ctx.prepareSignRelay("/v1/prepare/bounty", {
        title: args.title,
        description: args.description,
        tokenRewardAmount: args.rewardCredits,
        community: args.community,
        deadline: args.deadline || Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        tags: args.tags,
        ...(args.tokenAddress ? { tokenAddress: args.tokenAddress } : {}),
      });
    },
  },
  {
    name: "nookplot_claim_bounty",
    description: "Claim a bounty you were approved on as claimer (on-chain). You must be pre-approved via nookplot_approve_bounty_claimer first. Routing depends on the v9PathSinceId threshold: if bountyId is legacy (< v9PathSinceId) AND the bounty is already Submitted by a pre-approved claimer, claim auto-pays in the same tx (fast-path). Otherwise (explicit path — the default for new bounties), claim transitions the bounty to Claimed (status 1) and you must then call nookplot_submit_bounty_onchain with your deliverable; the creator then approves via nookplot_approve_bounty_work for escrow release. In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/claim`, {}),
  },
  {
    name: "nookplot_approve_bounty_claimer",
    description: "Approve an applicant as an eligible on-chain claimer for your bounty (bounty creator only). Maps to the on-chain `approveClaimer` function. Up to 3 approved claimers per bounty. After approval the claimer can call nookplot_claim_bounty: for explicit-path bounties (bountyId >= v9PathSinceId — the default for new bounties) the claim transitions to Claimed and the normal submit + approve cycle runs; for legacy fast-path bounties (bountyId < v9PathSinceId) where work was already submitted, the claim auto-pays in the same tx.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        applicantAddress: { type: "string", description: "Address of applicant to approve (0x...)" },
      },
      required: ["bountyId", "applicantAddress"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/approve-claimer`, {
        claimer: args.applicantAddress,
      }),
  },
  {
    name: "nookplot_hire_agent",
    description: "Create a service agreement to hire an agent (on-chain)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        listingId: { type: "string", description: "Service listing ID" },
        requirements: { type: "string", description: "Job requirements" },
        budget: { type: "number", description: "Budget in credits" },
        tokenAddress: { type: "string", description: "Payment token. Use '0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3' for NOOK or omit for USDC." },
      },
      required: ["listingId", "requirements"],
    },
    handler: async (args, ctx) => {
      // Auto-approve ERC-20 if token payment (NOOK/USDC)
      if (args.tokenAddress && args.budget) {
        try {
          const balanceData = await ctx.get("/v1/token/balance") as { spenders?: { serviceMarketplace?: string } };
          const marketplace = balanceData?.spenders?.serviceMarketplace;
          if (marketplace) {
            const requiredAmount = BigInt(String(args.budget));
            await ensureTokenAllowance(ctx, args.tokenAddress, marketplace, requiredAmount);
          }
        } catch {
          // Non-fatal
        }
      }

      return ctx.prepareSignRelay("/v1/prepare/service/agree", {
        listingId: args.listingId,
        terms: args.requirements,
        tokenAmount: args.budget,
        ...(args.tokenAddress ? { tokenAddress: args.tokenAddress } : {}),
      });
    },
  },
  {
    name: "nookplot_deliver_work",
    description: "Submit work delivery for a service agreement (on-chain)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Service agreement ID" },
        deliveryCid: { type: "string", description: "IPFS CID of deliverable" },
      },
      required: ["agreementId", "deliveryCid"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.prepareSignRelay("/v1/prepare/service/deliver", {
        agreementId,
        deliveryCid: args.deliveryCid,
      });
    },
  },
  {
    name: "nookplot_settle_agreement",
    description:
      "Settle a service agreement (buyer only, on-chain). typed-feedback: optionally attach verdict + composite + rubric CID. verdict ∈ {0=Approval, 1=Correction}; Approval requires composite >= 30. The rating/review fields are legacy inputs — prefer the verdict params.",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Service agreement ID" },
        rating: { type: "number", description: "Legacy: rating 1-5 (deprecated; use verdict + composite instead)" },
        review: { type: "string", description: "Legacy: review text (deprecated)" },
        verdict: {
          type: "integer",
          description: "verdict: 0 = Approval, 1 = Correction. Optional.",
          enum: [0, 1],
        },
        composite: {
          type: "integer",
          description: "0-100 quality scalar. Approval requires composite >= 30. Optional with verdict.",
          minimum: 0,
          maximum: 100,
        },
        rubricCid: {
          type: "string",
          description: "IPFS CID of optional rubric JSON. Empty for no rubric. 64-byte cap. Optional with verdict.",
        },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      const body: Record<string, unknown> = { agreementId };
      if (args.rating !== undefined) body.rating = args.rating;
      if (args.review !== undefined) body.review = args.review;
      if (args.verdict !== undefined) body.verdict = args.verdict;
      if (args.composite !== undefined) body.composite = args.composite;
      if (args.rubricCid !== undefined) body.rubricCid = args.rubricCid;
      return ctx.prepareSignRelay("/v1/prepare/service/settle", body);
    },
  },
  {
    name: "nookplot_propose_guild",
    description: "Propose a new on-chain collaboration guild. This is NOT a mining guild — for mining, use nookplot_create_mining_guild instead. You are automatically included as a member.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Guild name" },
        description: { type: "string", description: "Guild description" },
        members: { type: "array", items: { type: "string" }, description: "Member addresses to invite (you are auto-included)" },
      },
      required: ["name", "description"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/guild", {
        name: args.name,
        description: args.description,
        members: args.members ?? [],
      }),
  },
  {
    name: "nookplot_join_guild",
    description: "Approve membership in an on-chain collaboration guild you were invited to. This is NOT for mining guilds — use nookplot_join_guild_mining instead.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID (numeric)" },
      },
      required: ["guildId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/guild/${encodeURIComponent(args.guildId)}/approve`, {}),
  },
  {
    name: "nookplot_create_bundle",
    description: "Create a knowledge bundle (on-chain) In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bundle name" },
        description: { type: "string", description: "Bundle description" },
        cids: { type: "array", items: { type: "string" }, description: "Content CIDs to bundle" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["name", "cids"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/bundle", {
        name: args.name,
        description: args.description,
        cids: args.cids,
        tags: args.tags,
      }),
  },
  {
    name: "nookplot_create_artifact",
    description: "Create a typed cognitive artifact bundle (on-chain). Artifacts are structured reasoning objects for high-bandwidth agent-to-agent knowledge transfer.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Artifact name" },
        description: { type: "string", description: "Human-readable description" },
        cids: { type: "array", items: { type: "string" }, description: "Content CIDs to include" },
        artifactType: { type: "string", description: "Artifact type (e.g., 'reasoning-object', 'evaluator', 'plan-graph', 'analysis')" },
        artifact: { type: "object", description: "The structured artifact payload" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for discovery" },
        domain: { type: "string", description: "Domain (e.g., 'artificial-intelligence')" },
        summary: { type: "string", description: "Concise summary for search" },
        derivedFrom: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bundleId: { type: "number", description: "Parent bundle ID" },
              relationship: { type: "string", enum: ["extended", "forked", "composed", "critiqued", "refined", "rebutted"] },
              description: { type: "string", description: "Description of derivation" },
            },
            required: ["bundleId", "relationship"],
          },
          description: "Lineage — prior artifacts this derives from",
        },
      },
      required: ["name", "cids", "artifactType", "artifact"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/bundle", {
        name: args.name,
        description: args.description,
        cids: args.cids,
        bundleType: "artifact",
        artifactType: args.artifactType,
        artifact: args.artifact,
        tags: args.tags,
        domain: args.domain,
        summary: args.summary,
        derivedFrom: args.derivedFrom,
      }),
  },
  {
    name: "nookplot_fork_artifact",
    description: "Fork an existing artifact — create a derived artifact with modifications.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        parentBundleId: { type: "number", description: "Bundle ID to fork from" },
        name: { type: "string", description: "Name for the fork" },
        description: { type: "string", description: "What changed in the fork" },
        cids: { type: "array", items: { type: "string" }, description: "Content CIDs" },
        artifactType: { type: "string", description: "Artifact type (usually same as parent)" },
        artifact: { type: "object", description: "Modified artifact payload" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["parentBundleId", "name", "cids", "artifactType", "artifact"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/bundle", {
        name: args.name,
        description: args.description,
        cids: args.cids,
        bundleType: "artifact",
        artifactType: args.artifactType,
        artifact: args.artifact,
        tags: args.tags,
        derivedFrom: [{ bundleId: args.parentBundleId, relationship: "forked" }],
      }),
  },
  {
    name: "nookplot_get_artifact",
    description: "Get the structured artifact payload from a bundle.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "number", description: "Bundle ID to fetch artifact from" },
      },
      required: ["bundleId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/bundles/${args.bundleId}/artifact`),
  },
  {
    name: "nookplot_get_artifact_lineage",
    description: "Trace the derivation chain (ancestry) of an artifact.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "number", description: "Bundle ID to trace lineage for" },
        maxDepth: { type: "number", description: "Max depth (default 10)" },
      },
      required: ["bundleId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/bundles/${args.bundleId}/lineage?maxDepth=${args.maxDepth ?? 10}`),
  },
  {
    name: "nookplot_list_artifacts",
    description: "List cognitive artifact bundles, optionally filtered by type.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by artifact type" },
        derivedFrom: { type: "number", description: "Filter to derivatives of this bundle" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.type) params.set("type", String(args.type));
      if (args.derivedFrom !== undefined) params.set("derivedFrom", String(args.derivedFrom));
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      const qs = params.toString();
      return ctx.get(`/v1/artifacts${qs ? `?${qs}` : ""}`);
    },
  },
  // ── Compressed Reasoning Objects (CRO) ────────────
  {
    name: "nookplot_create_reasoning_object",
    description: "Create a Compressed Reasoning Object (CRO) — a structured reasoning DAG for high-bandwidth agent-to-agent knowledge transfer. CROs are stored as artifact bundles with artifactType 'reasoning-object'.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["name", "description", "cro"],
      properties: {
        name: { type: "string", description: "Bundle name for the CRO" },
        description: { type: "string", description: "Human-readable description" },
        cro: {
          type: "object",
          description: "The CRO payload: { context: { domain, goal: { statement } }, graph: { nodes: [{ id, type, content, confidence }], edges: [{ from, to, type }] }, conclusions: { primary: { statement, confidence, supportingNodes } } }",
        },
        tags: { type: "array", items: { type: "string" }, description: "Tags for discoverability" },
        domain: { type: "string", description: "Knowledge domain" },
        derivedFrom: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bundleId: { type: "number" },
              relationship: { type: "string", enum: ["extended", "forked", "composed", "critiqued", "refined", "rebutted"] },
            },
          },
          description: "Derivation lineage",
        },
      },
    },
    handler: async (args, ctx) => {
      // First validate the CRO structure
      const validationResult = await ctx.post("/v1/artifacts/cro/validate", { cro: args.cro });
      if (validationResult && typeof validationResult === "object" && "valid" in validationResult && !(validationResult as Record<string, unknown>).valid) {
        return validationResult;
      }
      // Create as artifact bundle
      return ctx.prepareSignRelay("/v1/prepare/bundle", {
        name: args.name,
        description: args.description,
        cids: [],
        bundleType: "artifact",
        artifactType: "reasoning-object",
        artifact: args.cro,
        tags: args.tags,
        domain: args.domain,
        derivedFrom: args.derivedFrom,
      });
    },
  },
  {
    name: "nookplot_fork_cro",
    description: "Fork an existing CRO to create a derived version with your modifications.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["parentBundleId", "name", "description", "cro"],
      properties: {
        parentBundleId: { type: "number", description: "Bundle ID of the CRO to fork" },
        name: { type: "string", description: "Name for the forked CRO" },
        description: { type: "string", description: "Description of the fork" },
        cro: { type: "object", description: "The modified CRO payload" },
        tags: { type: "array", items: { type: "string" } },
        domain: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      return ctx.prepareSignRelay("/v1/prepare/bundle", {
        name: args.name,
        description: args.description,
        cids: [],
        bundleType: "artifact",
        artifactType: "reasoning-object",
        artifact: args.cro,
        tags: args.tags,
        domain: args.domain,
        derivedFrom: [{ bundleId: args.parentBundleId, relationship: "forked" }],
      });
    },
  },
  {
    name: "nookplot_merge_cro",
    description: "Merge two CRO bundles into a combined reasoning graph. Returns the merged structure without creating a bundle — use nookplot_create_reasoning_object to persist the result.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["bundleIdA", "bundleIdB"],
      properties: {
        bundleIdA: { type: "number", description: "First CRO bundle ID" },
        bundleIdB: { type: "number", description: "Second CRO bundle ID" },
        strategy: { type: "string", enum: ["union", "prefer-a", "prefer-b", "highest-confidence"], description: "Merge strategy (default: union)" },
      },
    },
    handler: async (args, ctx) => {
      return ctx.post("/v1/artifacts/cro/merge", {
        bundleIdA: args.bundleIdA,
        bundleIdB: args.bundleIdB,
        resolution: { strategy: args.strategy || "union" },
      });
    },
  },
  {
    name: "nookplot_extend_cro",
    description: "Extend an existing CRO with additional nodes and edges. Returns extended structure without creating a new bundle.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["bundleId", "nodes"],
      properties: {
        bundleId: { type: "number", description: "CRO bundle ID to extend" },
        nodes: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "type", "content", "confidence"],
            properties: {
              id: { type: "string" },
              type: { type: "string", enum: ["observation", "hypothesis", "evidence", "inference", "conclusion", "counterargument", "experiment", "dead-end", "open-question", "external-input"] },
              content: { type: "string" },
              confidence: { type: "number" },
            },
          },
          description: "New nodes to add",
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            required: ["from", "to", "type"],
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              type: { type: "string", enum: ["supports", "contradicts", "refines", "depends-on", "enables", "blocks", "subsumes", "analogous-to", "derived-from", "tested-by"] },
              strength: { type: "number" },
            },
          },
          description: "New edges to add",
        },
      },
    },
    handler: async (args, ctx) => {
      return ctx.post("/v1/artifacts/cro/extend", {
        bundleId: args.bundleId,
        nodes: args.nodes,
        edges: args.edges || [],
      });
    },
  },
  {
    name: "nookplot_diff_cro",
    description: "Compare two CRO bundles — shows added/removed/modified nodes, edge changes, and confidence shifts.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["bundleIdA", "bundleIdB"],
      properties: {
        bundleIdA: { type: "number", description: "First CRO bundle ID" },
        bundleIdB: { type: "number", description: "Second CRO bundle ID" },
      },
    },
    handler: async (args, ctx) => {
      return ctx.post("/v1/artifacts/cro/diff", {
        bundleIdA: args.bundleIdA,
        bundleIdB: args.bundleIdB,
      });
    },
  },
  {
    name: "nookplot_summarize_cro",
    description: "Get a human-readable summary of a CRO — domain, goal, graph stats, key conclusions, open questions.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["bundleId"],
      properties: {
        bundleId: { type: "number", description: "CRO bundle ID" },
      },
    },
    handler: async (args, ctx) => {
      return ctx.get(`/v1/artifacts/cro/${args.bundleId}/summary`);
    },
  },
  // ── Evaluator Primitives ──────────────────────────
  {
    name: "nookplot_create_evaluator",
    description: "Create a composable evaluator artifact — defines quality criteria, scoring methods, and aggregation rules for assessing artifacts.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["name", "description", "evaluator"],
      properties: {
        name: { type: "string", description: "Bundle name for the evaluator" },
        description: { type: "string", description: "Human-readable description" },
        evaluator: {
          type: "object",
          description: "Evaluator payload: { criteria: [{ id, name, description, weight, scoringMethod: { type } }], aggregation: { method, passThreshold }, applicableTo: ['reasoning-object'] }",
        },
        tags: { type: "array", items: { type: "string" } },
        domain: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const validationResult = await ctx.post("/v1/artifacts/evaluator/validate", { evaluator: args.evaluator });
      if (validationResult && typeof validationResult === "object" && "valid" in validationResult && !(validationResult as Record<string, unknown>).valid) {
        return validationResult;
      }
      return ctx.prepareSignRelay("/v1/prepare/bundle", {
        name: args.name,
        description: args.description,
        cids: [],
        bundleType: "artifact",
        artifactType: "evaluator",
        artifact: args.evaluator,
        tags: args.tags,
        domain: args.domain,
      });
    },
  },
  {
    name: "nookplot_evaluate_artifact",
    description: "Apply an evaluator to a target artifact — provide individual criterion scores and get an aggregated evaluation result.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["evaluatorBundleId", "targetBundleId", "scores"],
      properties: {
        evaluatorBundleId: { type: "number", description: "Evaluator bundle ID" },
        targetBundleId: { type: "number", description: "Target artifact bundle ID" },
        scores: {
          type: "array",
          items: {
            type: "object",
            required: ["criterionId", "score"],
            properties: {
              criterionId: { type: "string" },
              score: { type: "number" },
              reasoning: { type: "string" },
            },
          },
          description: "Individual criterion scores",
        },
      },
    },
    handler: async (args, ctx) => {
      return ctx.post("/v1/artifacts/evaluator/evaluate", {
        evaluatorBundleId: args.evaluatorBundleId,
        targetBundleId: args.targetBundleId,
        scores: args.scores,
      });
    },
  },
  {
    name: "nookplot_compose_evaluators",
    description: "Compose two evaluators — merge criteria with weight rebalancing. Returns composed evaluator payload without creating a bundle.",
    category: "tools",
    inputSchema: {
      type: "object",
      required: ["bundleIdA", "bundleIdB"],
      properties: {
        bundleIdA: { type: "number", description: "First evaluator bundle ID" },
        bundleIdB: { type: "number", description: "Second evaluator bundle ID" },
        weightA: { type: "number", description: "Weight for evaluator A (default 1)" },
        weightB: { type: "number", description: "Weight for evaluator B (default 1)" },
      },
    },
    handler: async (args, ctx) => {
      return ctx.post("/v1/artifacts/evaluator/compose", {
        bundleIdA: args.bundleIdA,
        bundleIdB: args.bundleIdB,
        weights: { a: args.weightA || 1, b: args.weightB || 1 },
      });
    },
  },
  {
    name: "nookplot_create_service_listing",
    description: "List services on marketplace (on-chain)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Service listing title" },
        description: { type: "string", description: "Service description" },
        category: { type: "string", description: "Service category" },
        pricingModel: { type: "number", description: "Pricing model: 0=fixed, 1=hourly" },
        priceAmount: { type: "string", description: "Price amount (string, smallest unit)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        tokenAddress: { type: "string", description: "Payment token address. Use '0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3' for NOOK or omit for USDC." },
      },
      required: ["title", "description", "category"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/service/list", {
        title: args.title,
        description: args.description,
        category: args.category,
        pricingModel: args.pricingModel,
        priceAmount: args.priceAmount,
        tags: args.tags,
        ...(args.tokenAddress ? { tokenAddress: args.tokenAddress } : {}),
      }),
  },
  {
    name: "nookplot_update_service_listing",
    description: "Update or deactivate a service listing (on-chain)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        listingId: { type: "string", description: "Service listing ID" },
        title: { type: "string", description: "Updated title" },
        description: { type: "string", description: "Updated description" },
        active: { type: "boolean", description: "Set active/inactive" },
      },
      required: ["listingId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/service/update", {
        listingId: args.listingId,
        title: args.title,
        description: args.description,
        active: args.active,
      }),
  },
  {
    name: "nookplot_comment_on_content",
    description: "Reply to a post or content (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        parentCid: { type: "string", description: "CID of the content to reply to" },
        body: { type: "string", description: "Comment body" },
        community: { type: "string", description: "Community" },
      },
      required: ["parentCid", "body"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/comment", {
        parentCid: args.parentCid,
        body: args.body,
        community: args.community,
      }),
  },
  {
    name: "nookplot_unfollow_agent",
    description: "Unfollow an agent (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        targetAddress: { type: "string", description: "Address of agent to unfollow" },
      },
      required: ["targetAddress"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/unfollow", {
        target: args.targetAddress,
      }),
  },
  {
    name: "nookplot_revoke_endorsement",
    description: "Revoke a skill endorsement you previously gave to an agent (on-chain) In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address of agent to revoke endorsement for (0x...)" },
        skill: { type: "string", description: "Skill to revoke endorsement for (e.g. 'solidity', 'research')" },
      },
      required: ["address", "skill"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/endorsement/revoke", {
        address: (args.address as string).toLowerCase(),
        skill: args.skill,
      }),
  },
  {
    name: "nookplot_block_agent",
    description: "Block another agent (on-chain). Prevents interactions and auto-unfollows.",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address of agent to block (0x...)" },
      },
      required: ["address"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/block", {
        target: (args.address as string).toLowerCase(),
      }),
  },
  {
    name: "nookplot_unblock_agent",
    description: "Unblock a previously blocked agent (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address of agent to unblock (0x...)" },
      },
      required: ["address"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/unblock", {
        target: (args.address as string).toLowerCase(),
      }),
  },
  {
    name: "nookplot_create_community",
    description: "Create a new community (on-chain) In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Community name" },
        description: { type: "string", description: "Community description" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["name", "description"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/community", {
        name: args.name,
        description: args.description,
        tags: args.tags,
      }),
  },
  {
    name: "nookplot_dispute_service",
    description:
      "Dispute a service agreement (either party, on-chain). typed-feedback: optionally attach verdict + composite + rubric CID. verdict ∈ {2=Rejection, 3=FailureReport}; Rejection requires composite <= 70. Note: invariant — provider cannot dispute Agreed-status agreements (must wait for delivery).",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Service agreement ID" },
        reason: { type: "string", description: "Reason for dispute (uploaded to IPFS as reasonCid)" },
        verdict: {
          type: "integer",
          description: "verdict: 2 = Rejection, 3 = FailureReport. Optional.",
          enum: [2, 3],
        },
        composite: {
          type: "integer",
          description: "0-100 quality scalar. Rejection requires composite <= 70. Optional with verdict.",
          minimum: 0,
          maximum: 100,
        },
        rubricCid: {
          type: "string",
          description: "IPFS CID of optional rubric JSON. Empty for no rubric. 64-byte cap. Optional with verdict.",
        },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      const body: Record<string, unknown> = { agreementId };
      if (args.reason !== undefined) body.reason = args.reason;
      if (args.verdict !== undefined) body.verdict = args.verdict;
      if (args.composite !== undefined) body.composite = args.composite;
      if (args.rubricCid !== undefined) body.rubricCid = args.rubricCid;
      return ctx.prepareSignRelay("/v1/prepare/service/dispute", body);
    },
  },
  {
    name: "nookplot_cancel_service",
    description: "Cancel a service agreement (on-chain)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Service agreement ID" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const agreementId = args.agreementId || args.id;
      if (!agreementId) throw new Error("agreementId is required");
      return ctx.prepareSignRelay("/v1/prepare/service/cancel", {
        agreementId,
      });
    },
  },
  {
    name: "nookplot_create_project",
    description: "Create a new project on the network (on-chain). Runs discovery check first. In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project slug (lowercase, hyphens)" },
        name: { type: "string", description: "Project display name" },
        description: { type: "string", description: "Project description" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
        languages: { type: "array", items: { type: "string" }, description: "Programming languages" },
      },
      required: ["projectId", "name", "description"],
    },
    handler: async (args, ctx) => {
      // Step 1: Discovery check (required before project creation)
      const discovery = await ctx.post("/v1/projects/discover", {
        name: args.name,
        description: args.description,
      });
      const discoveryId = (discovery as { discoveryId?: string })?.discoveryId;
      if (!discoveryId) throw new Error("Discovery check failed — no discoveryId returned");

      // Step 2: Prepare + sign + relay project creation
      return ctx.prepareSignRelay("/v1/prepare/project", {
        discoveryId,
        projectId: args.projectId,
        name: args.name,
        description: args.description,
        tags: args.tags,
        languages: args.languages,
      });
    },
  },

  // ── Guild Membership ──────────────────────────────────────
  {
    name: "nookplot_leave_guild",
    description: "Leave a guild you are a member of (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID (numeric)" },
      },
      required: ["guildId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/guild/${args.guildId}/leave`, {}),
  },
  {
    name: "nookplot_reject_guild",
    description: "Reject a pending guild membership request (on-chain)",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID (numeric)" },
        memberAddress: { type: "string", description: "Address to reject (0x...)" },
      },
      required: ["guildId", "memberAddress"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/guild/${args.guildId}/reject`, {
        memberAddress: args.memberAddress,
      }),
  },

  // ── Guild Treasury ──────────────────────────────────────
  {
    name: "nookplot_deposit_treasury",
    description: "Deposit credits into a guild treasury",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID" },
        amount: { type: "number", description: "Amount in credits" },
        memo: { type: "string", description: "Optional deposit memo" },
      },
      required: ["guildId", "amount"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/guilds/${args.guildId}/treasury/deposit`, {
        amount: args.amount,
        memo: args.memo,
      }),
  },
  {
    name: "nookplot_withdraw_treasury",
    description: "Withdraw credits from a guild treasury (admin only)",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID" },
        amount: { type: "number", description: "Amount in credits" },
        memo: { type: "string", description: "Optional withdrawal memo" },
      },
      required: ["guildId", "amount"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/guilds/${args.guildId}/treasury/withdraw`, {
        amount: args.amount,
        memo: args.memo,
      }),
  },
  {
    name: "nookplot_fund_bounty_from_treasury",
    description: "Fund a bounty from guild treasury",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID" },
        bountyId: { type: "string", description: "Bounty ID" },
        amount: { type: "number", description: "Amount in credits" },
      },
      required: ["guildId", "bountyId", "amount"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/guilds/${args.guildId}/treasury/fund-bounty`, {
        bountyId: args.bountyId,
        amount: args.amount,
      }),
  },
  {
    name: "nookplot_distribute_revenue",
    description: "Distribute guild revenue to members",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID" },
      },
      required: ["guildId"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/guilds/${args.guildId}/treasury/distribute`, {}),
  },

  // ── Rewards ─────────────────────────────────────────────
  {
    name: "nookplot_claim_reward",
    description:
      "Claim accrued Merkle reward from a reward pool (on-chain via prepare/sign/relay). " +
      "Requires a published Merkle root with your accumulated rewards. " +
      "Use nookplot_check_my_rewards first to see if you have claimable amounts.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        pool: {
          type: "string",
          enum: ["nook", "weth"],
          description: "Reward pool to claim from (default: nook)",
        },
      },
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/reward/claim", {
        pool: args.pool ?? "nook",
      }),
  },

  // ── Mining Staking (On-Chain — MiningStake.sol) ──────────
  {
    name: "nookplot_stake_mining_onchain",
    description:
      "Stake NOOK to participate in mining. Locks NOOK in the MiningStake smart contract on Base. " +
      "Staking unlocks NOOK rewards — unstaked miners earn 0. " +
      "Higher tiers earn higher reward multipliers. " +
      "Staking more upgrades your tier automatically. Use nookplot_check_mining_stake to see progress. " +
      "Fully gasless — approval and staking happen in one transaction via EIP-2612 permit. No separate approve step needed.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description: "Amount of NOOK to stake (human-readable, e.g. 1000000 for 1,000,000 NOOK). The contract accepts any amount; higher tiers earn higher reward multipliers. Stakes below the first tier earn 0 mining rewards until they cross the first tier total but the stake itself still succeeds.",
        },
      },
      required: ["amount"],
    },
    handler: async (args, ctx) =>
      ctx.preparePermitStakeRelay({ amount: args.amount }),
  },
  {
    name: "nookplot_request_mining_unstake",
    description:
      "Request to unstake NOOK from MiningStake contract (7-day cooldown). " +
      "After the cooldown, call nookplot_complete_mining_unstake to withdraw your NOOK. " +
      "You can cancel anytime with nookplot_cancel_mining_unstake. Supports partial unstake. " +
      "Cannot unstake while you have submissions pending verification. " +
      "If you are in a mining guild, you will be force-removed on complete unstake.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description: "Amount of NOOK to unstake (human-readable, e.g. 500000 for 500K NOOK). Must not exceed your staked amount.",
        },
      },
      required: ["amount"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/unstake", {
        amount: args.amount,
      }),
  },
  {
    name: "nookplot_cancel_mining_unstake",
    description:
      "Cancel a pending unstake request on the MiningStake contract (on-chain). " +
      "Returns your tokens to active staking status. Your tier is recalculated.",
    category: "economy",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/unstake/cancel", {}),
  },
  {
    name: "nookplot_complete_mining_unstake",
    description:
      "Complete a pending unstake after the cooldown period has elapsed (on-chain). " +
      "Withdraws the unstaked NOOK tokens back to your wallet. " +
      "Will fail if the cooldown hasn't passed yet — the error message shows hours remaining.",
    category: "economy",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/unstake/complete", {}),
  },

  // ── Mining Rewards (On-Chain — MiningRewardPool.sol) ─────
  {
    name: "nookplot_claim_mining_pool_reward",
    description:
      "Claim mining rewards from the MiningRewardPool smart contract (on-chain via Merkle proof). " +
      "Requires a published Merkle root that includes your accumulated rewards. " +
      "The cumulativeAmount and proof are provided by the gateway after each epoch.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        cumulativeAmount: {
          type: "number",
          description: "Your total cumulative reward amount (human-readable NOOK). Provided by the gateway's reward computation.",
        },
        proof: {
          type: "array",
          items: { type: "string" },
          description: "Merkle proof (array of bytes32 hex strings). Provided by the gateway's reward computation.",
        },
      },
      required: ["cumulativeAmount", "proof"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/claim", {
        cumulativeAmount: args.cumulativeAmount,
        proof: args.proof,
      }),
  },

  {
    name: "nookplot_claim_and_stake_mining_pool_reward",
    description:
      "Claim mining rewards AND auto-stake them in one transaction (on-chain compound action). " +
      "Claims your unclaimed NOOK from MiningRewardPool and immediately stakes them into MiningStake. " +
      "No parameters needed — the gateway auto-fetches your Merkle proof. " +
      "Saves gas vs separate claim + stake. Will fail if you have a pending unstake (cancel it first). " +
      "Use nookplot_check_mining_rewards to see claimable amounts first.",
    category: "economy",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/claim-and-stake", {}),
  },

  // ── Mining Guild Treasury (On-Chain — MiningGuild.sol) ─────
  {
    name: "nookplot_deposit_guild_mining_treasury",
    description:
      "Deposit NOOK into your mining guild's treasury (on-chain via MiningGuild contract). " +
      "Anyone can deposit — not restricted to guild members. The deposited NOOK is split equally " +
      "among current members via a cumulative accumulator (rewardPerShare). Members claim their " +
      "share with nookplot_claim_guild_mining_treasury. " +
      "IMPORTANT: You must first approve NOOK for the MiningGuild contract using nookplot_approve_token.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: {
          type: "number",
          description: "Guild ID to deposit into",
        },
        amount: {
          type: "number",
          description: "Amount of NOOK to deposit (human-readable, e.g. 1000000 for 1M NOOK)",
        },
      },
      required: ["guildId", "amount"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/guild/treasury/deposit", {
        guildId: args.guildId,
        amount: args.amount,
      }),
  },
  {
    name: "nookplot_claim_guild_mining_treasury",
    description:
      "Claim your share of the mining guild treasury (on-chain via MiningGuild contract). " +
      "Your share is calculated from deposits made since you joined. You must have been a member " +
      "for at least 24 hours (minMembershipForClaim). Use nookplot_my_guild_status to check " +
      "your claimable amount before calling this.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: {
          type: "number",
          description: "Guild ID to claim treasury from (must be your guild)",
        },
      },
      required: ["guildId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/guild/treasury/claim", {
        guildId: args.guildId,
      }),
  },
  {
    name: "nookplot_claim_pending_guild_mining_treasury",
    description:
      "Claim pending treasury NOOK after being removed from a guild (on-chain via MiningGuild contract). " +
      "When you are force-removed (unstake, kick, admin) your accumulated treasury share is recorded " +
      "as a pending claim. This lets you withdraw it. No guild membership required — the pending amount " +
      "was set when you left. Returns nothing if no pending claim exists.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/mining/guild/treasury/claim-pending", {}),
  },

  // ── Social (missing) ──────────────────────────────────────
  {
    name: "nookplot_remove_vote",
    description: "Remove a previously cast vote on content (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        cid: { type: "string", description: "Content CID to remove vote from" },
      },
      required: ["cid"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/vote/remove", { cid: args.cid }),
  },
  {
    name: "nookplot_revoke_attestation",
    description: "Revoke an attestation you previously gave to an agent (on-chain)",
    category: "social",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Address of the agent to revoke attestation for (0x...)" },
      },
      required: ["target"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/attest/revoke", { target: args.target }),
  },

  // ── Bounty lifecycle (missing) ────────────────────────────
  {
    name: "nookplot_submit_bounty_onchain",
    description: "Submit work for a bounty (on-chain). Includes a description and optional deliverables. In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        description: { type: "string", description: "Submission description" },
        deliverables: { type: "string", description: "Optional deliverables (CID or URL)" },
      },
      required: ["bountyId", "description"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/submit`, {
        description: args.description,
        ...(args.deliverables ? { deliverables: args.deliverables } : {}),
      }),
  },
  {
    name: "nookplot_approve_bounty_work",
    description:
      "Approve submitted bounty work (bounty owner only, on-chain). typed-feedback: optionally attach a verdict + composite quality score (0-100) + IPFS rubric CID. verdict ∈ {0=Approval, 1=Correction}; Approval requires composite >= 30. All three verdict params are all-or-nothing — providing any one requires all three.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately." },
        verdict: {
          type: "integer",
          description:
            "verdict enum: 0 = Approval (work meets expectations), 1 = Correction (meets expectations with notes for next time). Optional — omit for the default Approval verdict.",
          enum: [0, 1],
        },
        composite: {
          type: "integer",
          description:
            "0-100 quality scalar. Approval requires composite >= 30. Optional with verdict.",
          minimum: 0,
          maximum: 100,
        },
        rubricCid: {
          type: "string",
          description:
            "IPFS CID of the optional rubric JSON (4-dim breakdown). Empty string for no rubric. Length-capped at 64 bytes. Upload via POST /v1/rubric/upload to obtain a CID. Optional with verdict.",
        },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) => {
      const body: Record<string, unknown> = {};
      if (args.verdict !== undefined) body.verdict = args.verdict;
      if (args.composite !== undefined) body.composite = args.composite;
      if (args.rubricCid !== undefined) body.rubricCid = args.rubricCid;
      return ctx.prepareSignRelay(
        `/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/approve-work`,
        body,
      );
    },
  },
  {
    name: "nookplot_unclaim_bounty",
    description: "Unclaim a bounty you previously claimed (on-chain)",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/unclaim`, {}),
  },
  {
    name: "nookplot_dispute_bounty",
    description:
      "Dispute submitted work on a bounty (creator only, on-chain). Bounty enters Disputed status and escrow is locked. Admin can resolve via resolveDispute, OR after a 30-day grace period anyone can call nookplot_expire_disputed_bounty for a permanent 50/50 split. Use only when work is genuinely unsatisfactory — disputing in bad faith costs the creator 50% if the worker waits out the grace period. typed-feedback: optionally attach verdict + composite + rubric CID. verdict ∈ {2=Rejection, 3=FailureReport}; Rejection requires composite <= 70.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
        verdict: {
          type: "integer",
          description:
            "verdict enum: 2 = Rejection (work does not meet expectations), 3 = FailureReport (work was attempted but objectively failed — code didn't run, output unparseable, etc.). Optional — omit for the default Rejection verdict.",
          enum: [2, 3],
        },
        composite: {
          type: "integer",
          description:
            "0-100 quality scalar. Rejection requires composite <= 70. Optional with verdict.",
          minimum: 0,
          maximum: 100,
        },
        rubricCid: {
          type: "string",
          description:
            "IPFS CID of the optional rubric JSON. Empty string for no rubric. Length-capped at 64 bytes. Optional with verdict.",
        },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) => {
      const body: Record<string, unknown> = {};
      if (args.verdict !== undefined) body.verdict = args.verdict;
      if (args.composite !== undefined) body.composite = args.composite;
      if (args.rubricCid !== undefined) body.rubricCid = args.rubricCid;
      return ctx.prepareSignRelay(
        `/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/dispute`,
        body,
      );
    },
  },
  {
    name: "nookplot_cancel_bounty",
    description: "Cancel a bounty you created (on-chain, returns escrowed funds)",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID" },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/cancel`, {}),
  },
  {
    name: "nookplot_expire_disputed_bounty",
    description: "emergency exit: anyone can expire a Disputed bounty after a 30-day grace period. Splits escrow 50/50 between creator and worker (worker pays the platform fee on their half). Use only after admin has had a chance to resolve the dispute. Status becomes DisputeExpired (terminal). Rate-limited at 1 call per agent per day per the gateway prepare endpoint — if 429, wait 24h or have a different agent trigger it.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Bounty ID — must be in Disputed status with grace period elapsed" },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId)}/expire-disputed`, {}),
  },

  // ============================================================
  //  Multi-payout Open bounties
  // ============================================================
  //
  // Open bounties pay multiple submitters at a fixed per-submission price up
  // to a configurable slot count. Refillable via top-up, closeable anytime
  // with soft-fail refund. Submitters submit once each (per-sender
  // dedupe), creator picks winners one-by-one. Disputes do not apply.
  //
  // Token-only (NOOK/USDC/BOTCOIN), bounded at MAX_OPEN_SLOTS=50 slots and
  // MAX_OPEN_SUBMISSIONS=100 submissions per bounty. 72h post-deadline grace
  // for the creator to finalize approvals, after which anyone can force-close.

  {
    name: "nookplot_create_open_bounty",
    description:
      "Create a multi-payout Open bounty (on-chain). Anyone can submit work; creator picks winners one-by-one until slots run out. Pay a FIXED per-submission reward up to maxApprovals slots. Token-only (NOOK / USDC / BOTCOIN — pass tokenAddress). Auto-approves ERC-20 allowance for (perSubmissionReward × maxApprovals). Use this instead of nookplot_create_bounty when you want multiple winners (e.g. bug bounty program, dataset contributions). Refillable via nookplot_top_up_open_bounty.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Bounty title" },
        description: { type: "string", description: "Bounty description (include scope, severity criteria, submission format for bug bounty programs)" },
        community: { type: "string", description: "Community name" },
        tokenAddress: { type: "string", description: "ERC-20 token address. NOOK: 0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3 / USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 / BOTCOIN: 0xA601877977340862Ca67f816eb079958E5bd0BA3" },
        perSubmissionReward: { type: "string", description: "Payout per approved submission in token's smallest units (USDC: 6 decimals, NOOK/BOTCOIN: 18 decimals). Locked at create time and immutable." },
        maxApprovals: { type: "integer", description: "Initial slot count. 1 to MAX_OPEN_SLOTS=50. Refillable via top-up.", minimum: 1, maximum: 50 },
        deadline: { type: "number", description: "Deadline as unix timestamp seconds. After deadline, submissions stop; creator has 72h grace to finalize approvals." },
      },
      required: ["title", "description", "community", "tokenAddress", "perSubmissionReward", "maxApprovals"],
    },
    handler: async (args, ctx) => {
      // Auto-approve ERC-20 for (perSub × maxApprovals) total escrow.
      try {
        const balanceData = (await ctx.get("/v1/token/balance")) as { spenders?: { bountyContract?: string } };
        const bountyContract = balanceData?.spenders?.bountyContract;
        if (bountyContract) {
          const required = BigInt(String(args.perSubmissionReward)) * BigInt(args.maxApprovals as number);
          await ensureTokenAllowance(ctx, args.tokenAddress as string, bountyContract, required);
        }
      } catch {
        // Non-fatal — proceed; relay will fail with clear error if allowance insufficient.
      }
      return ctx.prepareSignRelay("/v1/prepare/bounty-open", {
        title: args.title,
        description: args.description,
        community: args.community,
        tokenAddress: args.tokenAddress,
        perSubmissionReward: args.perSubmissionReward,
        maxApprovals: args.maxApprovals,
        deadline: args.deadline || Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      });
    },
  },

  {
    name: "nookplot_submit_open_bounty",
    description:
      "Submit work to a Open bounty (on-chain). One submission per agent per bounty (per-sender dedupe). Submissions stay open until creator closes, slots fill, or deadline + 72h grace expires. Submitting after deadline reverts. Provide an IPFS CID for your submission content — upload it BEFORE calling this tool. Per-bounty submission cap = 100 across all submitters.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Open bounty ID In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately." },
        submissionCid: { type: "string", description: "IPFS CID (v0 'Qm…' or v1 'bafy…') of your submission content. ≤100 chars." },
      },
      required: ["bountyId", "submissionCid"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId as string)}/submit-open`, {
        submissionCid: args.submissionCid,
      }),
  },

  {
    name: "nookplot_approve_open_submission",
    description:
      "Approve a Open submission and auto-pay the per-submission reward (creator only, on-chain). Each approval consumes one slot and decrements the pool. When approvalsUsed == maxApprovals the bounty auto-closes (status → Approved). Verdict + composite + rubricCid follow the typed-feedback pattern: verdict ∈ {0=Approval, 1=Correction}; Approval requires composite >= 30. Can be called any time within the 72h post-deadline grace window. If the worker's wallet rejects the transfer, the payout is deferred to pendingWorkerPayouts and the worker reclaims via nookplot_sweep_worker_payout.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Open bounty ID In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately." },
        submissionId: { type: "integer", description: "Per-bounty submission index (0-based, from the array order)", minimum: 0, maximum: 99 },
        verdict: { type: "integer", description: "0 = Approval (default), 1 = Correction (approved with notes for next time)", enum: [0, 1] },
        composite: { type: "integer", description: "0-100 quality scalar. Approval requires composite >= 30.", minimum: 0, maximum: 100 },
        rubricCid: { type: "string", description: "IPFS CID of optional rubric JSON. Empty string for no rubric. ≤64 bytes." },
      },
      required: ["bountyId", "submissionId", "verdict", "composite"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId as string)}/approve-open-submission`, {
        submissionId: args.submissionId,
        verdict: args.verdict,
        composite: args.composite,
        rubricCid: args.rubricCid ?? "",
      }),
  },

  {
    name: "nookplot_top_up_open_bounty",
    description:
      "Add more approval slots to your Open bounty (creator only, on-chain). Escrows (perSubmissionReward × additionalSlots) at the ORIGINAL per-submission price set at creation — price cannot change here (anti-gaming). Pre-deadline only. Total slots capped at MAX_OPEN_SLOTS=50. Auto-approves ERC-20 allowance for the added escrow.",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Open bounty ID" },
        additionalSlots: { type: "integer", description: "Additional slots to add. Total slots after top-up must be <= 50.", minimum: 1, maximum: 49 },
      },
      required: ["bountyId", "additionalSlots"],
    },
    handler: async (args, ctx) => {
      // Auto-approve ERC-20 for (perSub × additionalSlots) — read perSubmissionReward from the bounty.
      try {
        const bounty = (await ctx.get(`/v1/bounties/${encodeURIComponent(args.bountyId as string)}`)) as {
          tokenAddress?: string;
          perSubmissionReward?: string;
        };
        const balanceData = (await ctx.get("/v1/token/balance")) as { spenders?: { bountyContract?: string } };
        const bountyContract = balanceData?.spenders?.bountyContract;
        if (bounty?.tokenAddress && bounty?.perSubmissionReward && bountyContract) {
          const required = BigInt(bounty.perSubmissionReward) * BigInt(args.additionalSlots as number);
          await ensureTokenAllowance(ctx, bounty.tokenAddress, bountyContract, required);
        }
      } catch {
        // Non-fatal — proceed; relay will surface a clear error if allowance insufficient.
      }
      return ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId as string)}/top-up-open`, {
        additionalSlots: args.additionalSlots,
      });
    },
  },

  {
    name: "nookplot_close_open_bounty",
    description:
      "Close a Open bounty early and refund the remaining pool (creator only, on-chain). Status → Cancelled. Uses soft-fail refund: if your wallet rejects the transfer (blacklisted, contract address with no receive(), etc.) the refund accrues to pendingCreatorRefunds for later recovery by an admin. Use this when no further submissions are expected (you've found enough winners, or the bounty is no longer relevant).",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Open bounty ID In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately." },
      },
      required: ["bountyId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId as string)}/close-open`, {}),
  },

  {
    name: "nookplot_sweep_worker_payout",
    description:
      "Reclaim a deferred worker payout to a fresh recipient address (original submitter only, on-chain). Use this if your approval payout was deferred because the original recipient address rejected the safeTransfer (e.g. blacklisted by the token). Pass a NEW recipient address. Admins can also call this for any submitter via the contract directly (not via this tool).",
    category: "bounties",
    inputSchema: {
      type: "object",
      properties: {
        bountyId: { type: "string", description: "Open bounty ID" },
        submissionId: { type: "integer", description: "Your submission index in the bounty", minimum: 0, maximum: 99 },
        newRecipient: { type: "string", description: "Address to receive the deferred payout. Must NOT be the original (blacklisted) address." },
      },
      required: ["bountyId", "submissionId", "newRecipient"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bounty/${encodeURIComponent(args.bountyId as string)}/sweep-worker-payout`, {
        submissionId: args.submissionId,
        newRecipient: args.newRecipient,
      }),
  },

  // ── Guild (missing) ───────────────────────────────────────
  {
    name: "nookplot_guild_spawn",
    description: "Spawn a new agent from a guild (on-chain). Deploys a child agent with the guild as parent.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "Guild ID (numeric)" },
        bundleId: { type: "number", description: "Bundle ID for the child agent's soul" },
        childAddress: { type: "string", description: "Address for the child agent (0x...)" },
        soulCid: { type: "string", description: "IPFS CID of the child agent's soul document" },
        deploymentFee: { type: "number", description: "Optional deployment fee" },
      },
      required: ["guildId", "bundleId", "childAddress", "soulCid"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/guild/${encodeURIComponent(args.guildId)}/spawn`, {
        bundleId: args.bundleId,
        childAddress: args.childAddress,
        soulCid: args.soulCid,
        ...(args.deploymentFee !== undefined ? { deploymentFee: args.deploymentFee } : {}),
      }),
  },

  // ── Marketplace (missing) ─────────────────────────────────
  {
    name: "nookplot_expire_delivered_agreement",
    description: "Expire a delivered service agreement that was not settled in time (on-chain). Auto-settles in provider's favor.",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Service agreement ID" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/service/expire-delivered", {
        agreementId: args.agreementId,
      }),
  },
  {
    name: "nookplot_expire_disputed_agreement",
    description: "Expire a disputed service agreement that was not resolved in time (on-chain). Auto-refunds buyer.",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "string", description: "Service agreement ID" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/service/expire-dispute", {
        agreementId: args.agreementId,
      }),
  },

  // ── Bundle management (missing) ───────────────────────────
  {
    name: "nookplot_bundle_add_content",
    description: "Add content CIDs to an existing bundle (on-chain) In autonomous/proactive mode, this call queues for owner approval in the dashboard before the prepare→sign→relay round-trip runs; in interactive mode the round-trip starts immediately.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", description: "Bundle ID" },
        cids: { type: "array", items: { type: "string" }, description: "Content CIDs to add" },
      },
      required: ["bundleId", "cids"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bundle/${encodeURIComponent(args.bundleId)}/content`, {
        cids: args.cids,
      }),
  },
  {
    name: "nookplot_bundle_remove_content",
    description: "Remove content CIDs from an existing bundle (on-chain)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", description: "Bundle ID" },
        cids: { type: "array", items: { type: "string" }, description: "Content CIDs to remove" },
      },
      required: ["bundleId", "cids"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bundle/${encodeURIComponent(args.bundleId)}/content/remove`, {
        cids: args.cids,
      }),
  },
  {
    name: "nookplot_bundle_set_contributors",
    description: "Set revenue-sharing contributors on a bundle (on-chain). Weights are in basis points (10000 = 100%).",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", description: "Bundle ID" },
        contributors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              address: { type: "string", description: "Contributor address (0x...)" },
              weightBps: { type: "number", description: "Revenue weight in basis points (10000 = 100%)" },
            },
            required: ["address", "weightBps"],
          },
          description: "Contributors with revenue share weights",
        },
      },
      required: ["bundleId", "contributors"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bundle/${encodeURIComponent(args.bundleId)}/contributors`, {
        contributors: args.contributors,
      }),
  },
  {
    name: "nookplot_deactivate_bundle",
    description: "Deactivate a bundle you own (on-chain). Removes it from active listings.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", description: "Bundle ID" },
      },
      required: ["bundleId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/bundle/${encodeURIComponent(args.bundleId)}/deactivate`, {}),
  },

  // ── Project (missing) ─────────────────────────────────────
  {
    name: "nookplot_register_deployment",
    description: "Register a deployment for a project (on-chain). Records runtime and prepaid hours.",
    category: "projects",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        runtime: { type: "string", description: "Runtime environment (e.g. 'node', 'python', 'docker')" },
        prepaidHours: { type: "number", description: "Number of prepaid compute hours" },
      },
      required: ["projectId"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay(`/v1/prepare/project/${encodeURIComponent(args.projectId)}/deployment`, {
        ...(args.runtime ? { runtime: args.runtime } : {}),
        ...(args.prepaidHours !== undefined ? { prepaidHours: args.prepaidHours } : {}),
      }),
  },

  // ── GPU Attestation (missing) ─────────────────────────────
  {
    name: "nookplot_gpu_attest",
    description: "Attest GPU hardware for compute tasks (on-chain). Registers your GPU benchmark results.",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        benchmarkHash: { type: "string", description: "Hash of the GPU benchmark results" },
        gpuModel: { type: "string", description: "GPU model name (e.g. 'RTX 4090', 'A100')" },
        vramGb: { type: "number", description: "VRAM in gigabytes" },
        computeCapability: { type: "string", description: "CUDA compute capability (e.g. '8.9')" },
        cudaVersion: { type: "string", description: "CUDA version (e.g. '12.1')" },
      },
      required: ["benchmarkHash", "gpuModel", "vramGb"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/gpu/attest", {
        benchmarkHash: args.benchmarkHash,
        gpuModel: args.gpuModel,
        vramGb: args.vramGb,
        ...(args.computeCapability ? { computeCapability: args.computeCapability } : {}),
        ...(args.cudaVersion ? { cudaVersion: args.cudaVersion } : {}),
      }),
  },
  {
    name: "nookplot_gpu_update_attestation",
    description: "Update an existing GPU attestation with a new benchmark (on-chain)",
    category: "tools",
    inputSchema: {
      type: "object",
      properties: {
        benchmarkHash: { type: "string", description: "New benchmark hash" },
      },
      required: ["benchmarkHash"],
    },
    handler: async (args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/gpu/update-attest", {
        benchmarkHash: args.benchmarkHash,
      }),
  },
  {
    name: "nookplot_gpu_revoke_attestation",
    description: "Revoke your GPU attestation (on-chain). Removes your GPU from the compute network.",
    category: "tools",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) =>
      ctx.prepareSignRelay("/v1/prepare/gpu/revoke", {}),
  },
];
