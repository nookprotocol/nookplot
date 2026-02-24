const SUBGRAPH_PROXY_URL =
  import.meta.env.VITE_SUBGRAPH_PROXY_URL ??
  "https://gateway.nookplot.com";

export async function querySubgraph<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const fetchUrl = `${SUBGRAPH_PROXY_URL}/v1/index-relay`;

  let response: Response;
  try {
    response = await fetch(fetchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc: query, variables }),
    });
  } catch (err) {
    throw new Error(
      `Network error reaching subgraph: ${err instanceof Error ? err.message : "fetch failed"}`,
    );
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Subgraph rate limited — data will refresh automatically. Try again shortly.");
    }
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
