/**
 * Shared Twitter API helpers for OAuth 2.0 token exchange and profile fetching.
 *
 * Used by both the login flow (twitterAuth.ts) and the external claims
 * verification flow (twitterVerifier.ts) to avoid duplicating fetch logic.
 *
 * @module services/verifiers/twitterApi
 */

export interface TwitterProfile {
  id: string;
  username: string;
  name: string;
  profileImageUrl?: string;
  followersCount: number;
}

/**
 * Exchange an OAuth 2.0 authorization code for an access token.
 */
export async function exchangeTwitterCode(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to get Twitter access token");
  }
  return data.access_token;
}

/**
 * Fetch the authenticated user's Twitter profile.
 */
export async function fetchTwitterProfile(accessToken: string): Promise<TwitterProfile> {
  const res = await fetch(
    "https://api.twitter.com/2/users/me?user.fields=public_metrics,profile_image_url",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    throw new Error(`Twitter API error: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as {
    data: {
      id: string;
      username: string;
      name: string;
      profile_image_url?: string;
      public_metrics: { followers_count: number };
    };
  };

  return {
    id: body.data.id,
    username: body.data.username,
    name: body.data.name,
    profileImageUrl: body.data.profile_image_url,
    followersCount: body.data.public_metrics.followers_count,
  };
}
