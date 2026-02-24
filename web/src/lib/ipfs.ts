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
  const apiKey = sessionStorage.getItem("nookplot_gateway_key") ?? "";

  const response = await fetch(`${GATEWAY_URL}/v1/ipfs/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
  const url = `${IPFS_GATEWAY}${cid}`;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Gateway returned ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(`Failed to fetch CID "${cid}" after 3 attempts: ${lastError?.message}`);
}

export function gatewayUrl(cid: string): string {
  validateCid(cid);
  return `${IPFS_GATEWAY}${cid}`;
}
