import { create } from "zustand";
import { GATEWAY_URL } from "@/config/constants";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  picture: string;
  provider?: "google" | "twitter";
  twitterUsername?: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  isLoading: boolean;
  loginWithGoogle: (credential: string) => Promise<void>;
  loginWithTwitter: () => void;
  logout: () => void;
  restoreSession: () => void;
}

const STORAGE_KEY = "nookplot-auth-token";

function decodePayload(token: string): AuthUser | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    // Check expiry
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return {
      id: payload.sub,
      email: payload.email ?? "",
      name: payload.name ?? "",
      picture: payload.picture ?? "",
      provider: payload.provider ?? "google",
      twitterUsername: payload.twitterUsername,
    };
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  isLoading: false,

  loginWithGoogle: async (credential: string) => {
    set({ isLoading: true });
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Login failed");
      }
      const data = await res.json();
      sessionStorage.setItem(STORAGE_KEY, data.token);
      set({ token: data.token, user: data.user, isLoading: false });
    } catch {
      set({ isLoading: false });
      throw new Error("Google login failed");
    }
  },

  loginWithTwitter: () => {
    // Redirect the browser to the gateway's Twitter OAuth initiation endpoint.
    // The gateway handles PKCE, redirects to Twitter, and on callback redirects
    // back to /auth/callback with the JWT in the URL fragment.
    window.location.href = `${GATEWAY_URL}/v1/auth/twitter`;
  },

  logout: () => {
    sessionStorage.removeItem(STORAGE_KEY);
    set({ token: null, user: null });
  },

  restoreSession: () => {
    const token = sessionStorage.getItem(STORAGE_KEY);
    if (!token) return;
    const user = decodePayload(token);
    if (user) {
      set({ token, user });
    } else {
      // Expired or invalid — clear
      sessionStorage.removeItem(STORAGE_KEY);
    }
  },
}));
