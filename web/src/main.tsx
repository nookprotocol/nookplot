import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

// Dev-only: auto-inject test API key so Wave 1 features work without wallet auth.
// Set VITE_DEV_API_KEY in .env.development to enable this.
if (import.meta.env.DEV && import.meta.env.VITE_DEV_API_KEY && !sessionStorage.getItem("nookplot_gateway_key")) {
  sessionStorage.setItem("nookplot_gateway_key", import.meta.env.VITE_DEV_API_KEY);
  console.log("[dev] Auto-injected test API key");
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
  // Full app with wallet providers
  Promise.all([
    import("wagmi"),
    import("@tanstack/react-query"),
    import("@rainbow-me/rainbowkit"),
    import("@react-oauth/google"),
    import("@/config/wagmi"),
    import("./App"),
    import("@rainbow-me/rainbowkit/styles.css"),
    import("./styles/globals.css"),
  ]).then(
    ([
      { WagmiProvider },
      { QueryClient, QueryClientProvider },
      { RainbowKitProvider, darkTheme },
      { GoogleOAuthProvider },
      { config },
      { default: App },
    ]) => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 120_000,
            refetchOnWindowFocus: false,
          },
        },
      });

      const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

      createRoot(document.getElementById("root")!).render(
        <StrictMode>
          <GoogleOAuthProvider clientId={googleClientId}>
            <WagmiProvider config={config}>
              <QueryClientProvider client={queryClient}>
                <RainbowKitProvider
                  theme={darkTheme({ accentColor: "#6DB874" })}
                >
                  <App />
                </RainbowKitProvider>
              </QueryClientProvider>
            </WagmiProvider>
          </GoogleOAuthProvider>
        </StrictMode>,
      );
    },
  );
}
