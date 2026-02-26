const SUBGRAPH_PROXY_URL =
  import.meta.env.VITE_SUBGRAPH_PROXY_URL ??
  "https://gateway.nookplot.com";

export async function querySubgraph<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const fetchUrl = `${SUBGRAPH_PROXY_URL}/v1/index-relay`;
  const MAX_RETRIES = 1; // Single attempt — gateway handles retries + caching
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 2000));
    }

    let response: Response;
    try {
      response = await fetch(fetchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: query, variables }),
      });
    } catch (err) {
      lastError = new Error(
        `Network error reaching subgraph: ${err instanceof Error ? err.message : "fetch failed"}`,
      );
      continue;
    }

    // Retry on 429 or 502/503 (transient errors)
    if (response.status === 429 || response.status === 502 || response.status === 503) {
      lastError = new Error(
        response.status === 429
          ? "Subgraph rate limited — retrying..."
          : `Subgraph query failed (HTTP ${response.status}) — retrying...`,
      );
      continue;
    }

    if (!response.ok) {
      throw new Error(`Subgraph query failed (HTTP ${response.status})`);
    }

    let json: { data?: T; errors?: Array<{ message: string }> };
    try {
      json = await response.json();
    } catch {
      throw new Error("Subgraph returned invalid JSON");
    }

    if (json.errors?.length) {
      throw new Error(`Subgraph error: ${json.errors[0].message}`);
    }

    if (json.data === undefined || json.data === null) {
      throw new Error(
        "Subgraph returned empty data — it may be syncing after a redeployment. Try again in a moment.",
      );
    }

    return json.data;
  }

  throw lastError ?? new Error("Subgraph query failed after retries");
}
