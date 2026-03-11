import { ethers, type LogDescription } from "ethers";
import { config } from "../config.js";
import { ensureAgent, type MappingContext } from "./types.js";

/** Minimal ABI for KnowledgeBundle read functions */
const BUNDLE_ABI = [
  "function getBundleContent(uint256 bundleId) external view returns (string[] memory)",
  "function bundles(uint256) external view returns (address creator, string name, string descriptionCid, uint256 createdAt, bool isActive)",
];

/** Extracted metadata fields from an IPFS bundle description document. */
interface BundleMetadata {
  bundleType: string | null;
  tags: string[];
  domain: string | null;
  summary: string | null;
  custom: Record<string, unknown> | null;
}

/**
 * Fetch a bundle description document from IPFS and extract metadata fields.
 * Non-fatal: returns null on any failure (network, parse, missing fields).
 */
export async function fetchBundleMetadata(descriptionCid: string): Promise<BundleMetadata | null> {
  if (!descriptionCid) return null;

  try {
    const url = `${config.pinataGatewayUrl}/${descriptionCid}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[knowledgeBundle] IPFS fetch failed for ${descriptionCid}: HTTP ${response.status}`);
      return null;
    }

    const doc = await response.json();
    if (!doc || typeof doc !== "object") return null;

    const meta = doc.metadata;
    if (!meta || typeof meta !== "object") return null;

    return {
      bundleType: typeof meta.bundleType === "string" ? meta.bundleType.slice(0, 64) : null,
      tags: Array.isArray(meta.tags)
        ? meta.tags.filter((t: unknown) => typeof t === "string" && /^[a-z0-9][a-z0-9-]*$/.test(t)).slice(0, 20)
        : [],
      domain: typeof meta.domain === "string" ? meta.domain.slice(0, 128) : null,
      summary: typeof meta.summary === "string" ? meta.summary.slice(0, 2000) : null,
      custom: meta.custom && typeof meta.custom === "object" ? meta.custom : null,
    };
  } catch (err) {
    console.warn(
      `[knowledgeBundle] Failed to fetch/parse bundle metadata for ${descriptionCid}: ${(err as Error).message}`,
    );
    return null;
  }
}

function bundleEntityId(bundleId: bigint): string {
  // Match subgraph: Bytes.fromByteArray(Bytes.fromBigInt(bundleId))
  // This is the little-endian byte representation
  const hex = bundleId.toString(16).padStart(2, "0");
  // ethers BigInt to bytes in minimal form, zero-padded
  return "0x" + hex;
}

/**
 * Fetch content CIDs from the KnowledgeBundle contract on-chain and store them.
 * Non-fatal: logs a warning if the call fails but does not throw.
 */
async function fetchAndStoreContentCids(
  ctx: MappingContext,
  bundleId: bigint,
  entityId: string,
): Promise<void> {
  if (!ctx.provider) return;

  const contractAddr = config.contracts.KnowledgeBundle;
  if (!contractAddr) return;

  try {
    const contract = new ethers.Contract(contractAddr, BUNDLE_ABI, ctx.provider);
    const cids: string[] = await contract.getBundleContent(bundleId);
    if (cids.length > 0) {
      await ctx.client.query(
        `UPDATE idx_knowledge_bundles SET content_cids = $1 WHERE id = $2`,
        [cids, entityId],
      );
    }
  } catch (err) {
    console.warn(
      `[knowledgeBundle] Failed to fetch content CIDs for bundle ${bundleId}: ${(err as Error).message}`,
    );
  }
}

export async function handleBundleCreated(ctx: MappingContext, parsed: LogDescription) {
  const bundleId = parsed.args[0] as bigint; // indexed uint256
  const creator = parsed.args[1].toLowerCase(); // indexed address
  const name = parsed.args[2] as string;
  const cidCount = Number(parsed.args[3]);
  const timestamp = Number(parsed.args[4]);

  await ensureAgent(ctx.client, creator, ctx.blockNumber, false);

  const id = bundleEntityId(bundleId);

  // Fetch descriptionCid from chain via the auto-generated getter
  let descriptionCid = "";
  if (ctx.provider) {
    const contractAddr = config.contracts.KnowledgeBundle;
    if (contractAddr) {
      try {
        const contract = new ethers.Contract(contractAddr, BUNDLE_ABI, ctx.provider);
        const info = await contract.bundles(bundleId);
        descriptionCid = info[2] ?? ""; // (creator, name, descriptionCid, createdAt, isActive)
      } catch (err) {
        console.warn(
          `[knowledgeBundle] Failed to fetch descriptionCid for bundle ${bundleId}: ${(err as Error).message}`,
        );
      }
    }
  }

  await ctx.client.query(
    `INSERT INTO idx_knowledge_bundles (id, bundle_id, creator_id, name, description_cid, cid_count, created_at, is_active, _block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
     ON CONFLICT (id) DO NOTHING`,
    [id, Number(bundleId), creator, name, descriptionCid, cidCount, timestamp, ctx.blockNumber],
  );

  // Fetch actual content CIDs from chain (event doesn't include them)
  if (cidCount > 0) {
    await fetchAndStoreContentCids(ctx, bundleId, id);
  }

  // Fetch and store metadata from IPFS description document
  if (descriptionCid) {
    const meta = await fetchBundleMetadata(descriptionCid);
    if (meta) {
      await ctx.client.query(
        `UPDATE idx_knowledge_bundles
         SET bundle_type = $1, tags = $2, summary = $3, domain = $4, bundle_metadata = $5
         WHERE id = $6`,
        [
          meta.bundleType,
          meta.tags,
          meta.summary,
          meta.domain,
          meta.custom ? JSON.stringify(meta.custom) : null,
          id,
        ],
      );
    }
  }
}

export async function handleBundleContentAdded(ctx: MappingContext, parsed: LogDescription) {
  const bundleId = parsed.args[0] as bigint;
  const newCidCount = Number(parsed.args[1]);

  const id = bundleEntityId(bundleId);

  await ctx.client.query(
    `UPDATE idx_knowledge_bundles SET cid_count = $1, _block_number = $2 WHERE id = $3`,
    [newCidCount, ctx.blockNumber, id],
  );

  // Re-fetch full content CID list from chain
  await fetchAndStoreContentCids(ctx, bundleId, id);
}

export async function handleBundleContentRemoved(ctx: MappingContext, parsed: LogDescription) {
  const bundleId = parsed.args[0] as bigint;
  const newCidCount = Number(parsed.args[1]);

  const id = bundleEntityId(bundleId);

  await ctx.client.query(
    `UPDATE idx_knowledge_bundles SET cid_count = $1, _block_number = $2 WHERE id = $3`,
    [newCidCount, ctx.blockNumber, id],
  );

  // Re-fetch full content CID list from chain (CIDs were removed)
  await fetchAndStoreContentCids(ctx, bundleId, id);
}

export async function handleContributorWeightSet(ctx: MappingContext, parsed: LogDescription) {
  const bundleId = parsed.args[0] as bigint;
  const contributor = parsed.args[1].toLowerCase();
  const weightBps = Number(parsed.args[2]);

  await ensureAgent(ctx.client, contributor, ctx.blockNumber, false);

  const bundleKey = bundleEntityId(bundleId);
  const contribId = `${bundleKey}-${contributor}`;

  // Check if this is a new contributor
  const { rows } = await ctx.client.query(
    `SELECT 1 FROM idx_bundle_contributors WHERE id = $1`,
    [contribId],
  );
  const isNew = rows.length === 0;

  await ctx.client.query(
    `INSERT INTO idx_bundle_contributors (id, bundle_id, contributor_id, weight_bps, _block_number)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       weight_bps = EXCLUDED.weight_bps,
       _block_number = EXCLUDED._block_number`,
    [contribId, bundleKey, contributor, weightBps, ctx.blockNumber],
  );

  if (isNew) {
    await ctx.client.query(
      `UPDATE idx_knowledge_bundles SET contributor_count = contributor_count + 1, _block_number = $1 WHERE id = $2`,
      [ctx.blockNumber, bundleKey],
    );
  }
}

export async function handleBundleDeactivated(ctx: MappingContext, parsed: LogDescription) {
  const bundleId = parsed.args[0] as bigint;
  const id = bundleEntityId(bundleId);

  await ctx.client.query(
    `UPDATE idx_knowledge_bundles SET is_active = FALSE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, id],
  );
}
