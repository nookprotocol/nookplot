/**
 * Lightweight GraphQL client for The Graph Protocol subgraph.
 *
 * Uses native `fetch` (Node 18+) — no external dependencies. Provides
 * typed query execution with error handling and fallback awareness.
 *
 * @module graphql
 */

/**
 * Error thrown when a GraphQL query fails.
 */
export class SubgraphQueryError extends Error {
  constructor(
    message: string,
    public readonly errors?: Array<{ message: string }>,
  ) {
    super(message);
    this.name = "SubgraphQueryError";
  }
}

/**
 * Lightweight client for querying a Graph Protocol subgraph.
 *
 * @example
 * ```ts
 * const client = new SubgraphClient("https://api.studio.thegraph.com/query/1742698/nookplotmainnet/v0.3.0");
 * const data = await client.query<{ agents: { id: string }[] }>(`{
 *   agents(first: 10) { id }
 * }`);
 * ```
 */
export class SubgraphClient {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    if (!endpoint) {
      throw new Error("SubgraphClient: endpoint URL is required");
    }
    this.endpoint = endpoint;
  }

  /**
   * Execute a GraphQL query against the subgraph.
   *
   * @param queryString - The GraphQL query string.
   * @param variables - Optional query variables.
   * @returns The `data` portion of the GraphQL response, typed as `T`.
   * @throws {SubgraphQueryError} If the query returns GraphQL errors.
   * @throws {Error} If the network request fails.
   */
  async query<T = Record<string, unknown>>(
    queryString: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const body: Record<string, unknown> = { query: queryString };
    if (variables) {
      body.variables = variables;
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`SubgraphClient: network error — ${msg}`);
    }

    if (!response.ok) {
      throw new Error(
        `SubgraphClient: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      throw new SubgraphQueryError(
        `SubgraphClient: GraphQL errors — ${json.errors.map((e) => e.message).join("; ")}`,
        json.errors,
      );
    }

    if (!json.data) {
      throw new Error("SubgraphClient: response contained no data");
    }

    return json.data;
  }

  /**
   * Check if the subgraph is reachable and responding.
   * Returns true if a simple introspection query succeeds.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.query<{ _meta: { block: { number: number } } }>(
        `{ _meta { block { number } } }`,
      );
      return true;
    } catch {
      return false;
    }
  }
}
