// Buffer polyfill — must be first: Privy embedded wallet SDK requires Node.js Buffer
import { Buffer } from "buffer";
globalThis.Buffer = Buffer;

import { StrictMode, lazy, Suspense, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { startSession, isAuthenticated } from "@/lib/authSession";

// Dev-only: auto-inject test API key so gated features work without wallet auth in dev mode
if (import.meta.env.DEV && !isAuthenticated() && import.meta.env.VITE_DEV_TEST_API_KEY) {
  startSession(import.meta.env.VITE_DEV_TEST_API_KEY)
    .then(() => console.log("[dev] Auto-injected test session"))
    .catch((err) => console.warn("[dev] Auto-inject session failed (gateway down?):", err));
}

// /about is a standalone landing page — skip wallet providers entirely
if (window.location.pathname === "/about") {
  const AboutPage = lazy(() =>
    import("@/pages/AboutPage").then((m) => ({ default: m.AboutPage })),
  );
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense
        fallback={
          <div
            style={{
              background: "#FAF8F2",
              height: "100vh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <p style={{ color: "#8A8A82" }}>Loading...</p>
          </div>
        }
      >
        <AboutPage />
      </Suspense>
    </StrictMode>,
  );
} else {
  // Core app modules (must succeed)
  const coreP = Promise.all([
    import("wagmi"),
    import("@tanstack/react-query"),
    import("@rainbow-me/rainbowkit"),
    import("@react-oauth/google"),
    import("@/config/wagmi"),
    import("./App"),
    import("@rainbow-me/rainbowkit/styles.css"),
    import("./styles/globals.css"),
  ]);

  // Privy modules (optional — app works without them)
  const privyP = Promise.all([
    import("@privy-io/react-auth"),
    import("@/config/privy"),
    import("@/components/auth/PrivySessionBridge"),
    import("@privy-io/wagmi"),
  ]).catch((err) => {
    console.warn("[nookplot] Privy failed to load, continuing without it:", err);
    // Clear stale Privy auth source so components don't try to render
    // Privy-dependent UI when PrivyProvider isn't in the tree
    localStorage.removeItem("nookplot_auth_source");
    return null;
  });

  Promise.all([coreP, privyP]).then(([coreMods, privyMods]) => {
    const [
      { WagmiProvider },
      { QueryClient, QueryClientProvider },
      { RainbowKitProvider, darkTheme },
      { GoogleOAuthProvider },
      { config },
      { default: App },
    ] = coreMods;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 4,
          retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
          staleTime: 120_000,       // "live" tier — 2 min default
          gcTime: 3_600_000,        // 1 hour — keep inactive cache entries longer
          refetchOnWindowFocus: false,
        },
      },
    });

    const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

    // Standard wagmi tree (no Privy) — used as fallback
    const wagmiTree = (
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider
            theme={darkTheme({ accentColor: "#6DB874" })}
          >
            <App />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    );

    // ErrorBoundary that catches Privy render crashes and falls back to standard wagmi
    class PrivyErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(err: unknown) {
        console.warn("[nookplot] Privy crashed at render, falling back to standard wagmi:", err);
        (window as any).__PRIVY_AVAILABLE__ = false;
        localStorage.removeItem("nookplot_auth_source");
      }
      render() {
        return this.state.failed ? wagmiTree : this.props.children;
      }
    }

    // Build app tree — use Privy's WagmiProvider when available to sync
    // embedded wallets into wagmi state, otherwise fall back to standard wagmi.
    let appTree: React.ReactNode = wagmiTree;

    if (privyMods) {
      try {
        const { PrivyProvider } = privyMods[0];
        const { PRIVY_APP_ID, privyConfig } = privyMods[1];
        const { PrivySessionBridge } = privyMods[2];
        const { WagmiProvider: PrivyWagmiProvider } = privyMods[3];

        if (PRIVY_APP_ID) {
          (window as any).__PRIVY_AVAILABLE__ = true;
          appTree = (
            <PrivyErrorBoundary>
              <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
                <PrivySessionBridge />
                <QueryClientProvider client={queryClient}>
                  <PrivyWagmiProvider config={config}>
                    <RainbowKitProvider
                      theme={darkTheme({ accentColor: "#6DB874" })}
                    >
                      <App />
                    </RainbowKitProvider>
                  </PrivyWagmiProvider>
                </QueryClientProvider>
              </PrivyProvider>
            </PrivyErrorBoundary>
          );
        } else {
          // PRIVY_APP_ID not set — clear stale Privy session markers
          localStorage.removeItem("nookplot_auth_source");
        }
      } catch (err) {
        console.warn("[nookplot] Privy setup failed, continuing without it:", err);
        localStorage.removeItem("nookplot_auth_source");
      }
    }

    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <GoogleOAuthProvider clientId={googleClientId}>
          {appTree}
        </GoogleOAuthProvider>
      </StrictMode>,
    );
  }).catch((err) => {
    console.error("[nookplot] Failed to load app:", err);
    const root = document.getElementById("root");
    if (root) {
      const safeMsg = (err?.message || "An unexpected error occurred.")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      root.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0E0F0E;color:#E8E6E1;font-family:system-ui,sans-serif;text-align:center;padding:2rem"><h2 style="margin-bottom:0.5rem">Failed to load</h2><p style="color:#9A9890;max-width:400px">${safeMsg}</p><button onclick="location.reload()" style="margin-top:1rem;padding:0.5rem 1rem;background:#151716;border:1px solid rgba(96,113,97,0.25);border-radius:8px;color:#E8E6E1;cursor:pointer">Reload</button></div>`;
    }
  });
}
