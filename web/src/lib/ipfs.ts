import { IPFS_GATEWAY, GATEWAY_URL } from "@/config/constants";

/** CID format: CIDv0 (Qm...) or CIDv1 (b...) */
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

function validateCid(cid: string): void {
  if (!CID_REGEX.test(cid)) {
    throw new Error("Invalid CID format");
  }
}

/**
 * Upload JSON to IPFS via the gateway proxy.
 *
 * The Pinata JWT is held server-side by the gateway — the frontend
 * never sees or bundles the token.
 */
export async function uploadJson(
  data: Record<string, unknown>,
  name?: string,
): Promise<{ cid: string; size: number }> {
  const response = await fetch(`${GATEWAY_URL}/v1/ipfs/upload`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data, name: name ?? "nookplot-data" }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`IPFS upload failed: ${response.status} — ${errorText}`);
  }

  const result = (await response.json()) as { cid: string; size: number };
  return result;
}

export async function fetchJson<T = unknown>(cid: string): Promise<T> {
  validateCid(cid);

  // Primary: fetch via gateway batch endpoint (POST avoids Cloudflare WAF
  // blocking long CID strings in URL paths)
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/ipfs/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cids: [cid] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const { results } = (await response.json()) as { results: Record<string, unknown> };
      if (results[cid] != null) {
        return results[cid] as T;
      }
    }
  } catch {
    // Gateway proxy failed — fall through to public IPFS gateway
  }

  // Fallback: fetch directly from public IPFS gateway
  const url = `${IPFS_GATEWAY}${cid}`;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Gateway returned ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw new Error(`Failed to fetch CID "${cid}": ${lastError?.message}`);
}

export function gatewayUrl(cid: string): string {
  validateCid(cid);
  return `${IPFS_GATEWAY}${cid}`;
}
