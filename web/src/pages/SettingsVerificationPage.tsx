import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useSearchParams } from "react-router-dom";
import {
  ShieldCheck,
  Shield,
  ShieldAlert,
  Github,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
} from "lucide-react";
import { BrandConnectButton } from "@/components/shared/BrandConnectButton";
import { VerificationBadge } from "@/components/shared/VerificationBadge";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { useVerificationTier } from "@/hooks/useVerificationTier";
import { useHumanVerification, type VerificationClaim } from "@/hooks/useHumanVerification";
import { useQueryClient } from "@tanstack/react-query";

/** Tier descriptions for the UI */
const TIERS = [
  {
    tier: 0,
    name: "Unverified",
    description: "Wallet only. Read-only access — browse, view profiles, explore.",
    icon: ShieldAlert,
    color: "text-muted-foreground",
    bgColor: "bg-muted/30",
  },
  {
    tier: 1,
    name: "Verified",
    description: "Connect GitHub or Twitter. Unlocks posting, commenting, and messaging.",
    icon: Shield,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
  },
  {
    tier: 2,
    name: "Trusted",
    description: "Connect both GitHub and Twitter. Full access — vote, follow, attest, bounties, and more.",
    icon: ShieldCheck,
    color: "text-accent",
    bgColor: "bg-accent/10",
  },
];

export function SettingsVerificationPage() {
  const { address, isConnected } = useAccount();
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const { data: tierStatus, refetch: refetchTier } = useVerificationTier(address);
  const {
    initiateGitHub,
    completeGitHub,
    getPendingOAuthCode,
    hasPendingSession,
    fetchClaims,
    isLoading,
    error,
    clearError,
  } = useHumanVerification();

  const [githubUsername, setGithubUsername] = useState("");
  const [claims, setClaims] = useState<VerificationClaim[]>([]);
  const [completionResult, setCompletionResult] = useState<{
    verified: boolean;
    tier: number;
    tierName: string;
  } | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);

  // Load existing claims
  useEffect(() => {
    if (address) {
      fetchClaims(address).then(setClaims);
    }
  }, [address, fetchClaims]);

  // Handle OAuth callback (code in URL params)
  useEffect(() => {
    const code = getPendingOAuthCode();
    if (code && hasPendingSession() && !isCompleting && !completionResult) {
      setIsCompleting(true);
      // Clean the URL
      setSearchParams({}, { replace: true });

      completeGitHub(code).then((result) => {
        setIsCompleting(false);
        if (result) {
          setCompletionResult({
            verified: result.verified,
            tier: result.tier.tier,
            tierName: result.tier.tierName,
          });
          // Refresh tier status and claims
          refetchTier();
          queryClient.invalidateQueries({ queryKey: ["verification-tier"] });
          if (address) {
            fetchClaims(address).then(setClaims);
          }
        }
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount

  const handleGitHubConnect = useCallback(async () => {
    if (!address || !githubUsername.trim()) return;
    clearError();
    await initiateGitHub(address, githubUsername.trim());
  }, [address, githubUsername, initiateGitHub, clearError]);

  const currentTier = tierStatus?.tier ?? 0;
  const githubClaim = claims.find((c) => c.platform === "github");
  const twitterClaim = claims.find((c) => c.platform === "twitter");

  // Not connected — show connect prompt
  if (!isConnected || !address) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-xl font-semibold">Identity Verification</h1>
        <div className="rounded-lg border border-border bg-card p-8 text-center space-y-4">
          <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground">
            Connect your wallet to manage identity verification.
          </p>
          <BrandConnectButton />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <SettingsNav />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Identity Verification</h1>
        {tierStatus && (
          <div className="flex items-center gap-2">
            <VerificationBadge tier={currentTier} platforms={tierStatus.verifiedPlatforms} size="md" />
            <span className="text-sm text-muted-foreground capitalize">{tierStatus.tierName}</span>
          </div>
        )}
      </div>

      {/* Success message after verification */}
      {completionResult && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-accent shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium">GitHub verified successfully</p>
            <p className="text-sm text-muted-foreground">
              Your verification tier is now: <span className="font-medium capitalize">{completionResult.tierName}</span>
            </p>
          </div>
          <button
            onClick={() => setCompletionResult(null)}
            className="ml-auto text-muted-foreground hover:text-foreground text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium">Verification error</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          <button
            onClick={clearError}
            className="ml-auto text-muted-foreground hover:text-foreground text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Completing OAuth spinner */}
      {isCompleting && (
        <div className="rounded-lg border border-border bg-card p-6 text-center space-y-3">
          <Loader2 className="mx-auto h-6 w-6 text-accent animate-spin" />
          <p className="text-sm text-muted-foreground">Completing GitHub verification...</p>
        </div>
      )}

      {/* Tier progress */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Verification Tiers</h2>
        <div className="space-y-3">
          {TIERS.map((t) => {
            const Icon = t.icon;
            const isActive = currentTier >= t.tier;
            const isCurrent = currentTier === t.tier;
            return (
              <div
                key={t.tier}
                className={`flex items-start gap-3 p-3 rounded-lg transition-colors ${
                  isCurrent ? `${t.bgColor} border border-${t.color.replace("text-", "")}/20` : "opacity-60"
                }`}
              >
                <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${isActive ? t.color : "text-muted"}`} />
                <div>
                  <p className={`text-sm font-medium ${isCurrent ? "" : ""}`}>
                    Tier {t.tier}: {t.name}
                    {isCurrent && <span className="ml-2 text-xs text-muted-foreground">(current)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
                </div>
                {isActive && t.tier > 0 && (
                  <CheckCircle2 className="h-4 w-4 text-accent shrink-0 ml-auto mt-0.5" />
                )}
              </div>
            );
          })}
        </div>

        {/* Expiry warning */}
        {tierStatus && tierStatus.daysUntilExpiry !== null && tierStatus.daysUntilExpiry <= 3 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded bg-warning/10 border border-warning/20">
            <Clock className="h-4 w-4 text-warning shrink-0" />
            <p className="text-xs text-warning">
              Verification expires in {tierStatus.daysUntilExpiry} day{tierStatus.daysUntilExpiry !== 1 ? "s" : ""}.
              Re-verify your accounts below to maintain access.
            </p>
          </div>
        )}
      </div>

      {/* Connected accounts */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Connected Accounts</h2>

        {/* GitHub */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Github className="h-5 w-5" />
              <span className="text-sm font-medium">GitHub</span>
            </div>
            {githubClaim && githubClaim.status === "verified" && !githubClaim.isExpired && (
              <span className="inline-flex items-center gap-1 text-xs text-accent">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Verified as {githubClaim.externalId}
              </span>
            )}
            {githubClaim && githubClaim.isExpired && (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <Clock className="h-3.5 w-3.5" />
                Expired
              </span>
            )}
          </div>

          {/* Show connect form if not verified or expired */}
          {(!githubClaim || githubClaim.status !== "verified" || githubClaim.isExpired) && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={githubUsername}
                  onChange={(e) => setGithubUsername(e.target.value)}
                  placeholder="Your GitHub username"
                  className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background
                             placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                  disabled={isLoading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && githubUsername.trim()) {
                      handleGitHubConnect();
                    }
                  }}
                />
                <button
                  onClick={handleGitHubConnect}
                  disabled={isLoading || !githubUsername.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-hover
                             text-white rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Github className="h-4 w-4" />
                  )}
                  {githubClaim?.isExpired ? "Re-verify" : "Connect"}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                You'll be redirected to GitHub to authorize read-only access to your public profile.
              </p>
            </div>
          )}

          {/* Show re-verify button for valid verified claims */}
          {githubClaim && githubClaim.status === "verified" && !githubClaim.isExpired && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Verified{githubClaim.verifiedAt ? ` on ${new Date(githubClaim.verifiedAt).toLocaleDateString()}` : ""}
                {githubClaim.expiresAt && ` — expires ${new Date(githubClaim.expiresAt).toLocaleDateString()}`}
              </span>
              <button
                onClick={() => {
                  setGithubUsername(githubClaim.externalId);
                  // Scroll up or let user click connect
                }}
                className="inline-flex items-center gap-1 text-accent hover:text-accent-hover"
              >
                <RefreshCw className="h-3 w-3" />
                Re-verify early
              </button>
            </div>
          )}
        </div>

        {/* Twitter (placeholder — not yet wired) */}
        <div className="border-t border-border pt-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              <span className="text-sm font-medium">Twitter / X</span>
            </div>
            {twitterClaim && twitterClaim.status === "verified" && !twitterClaim.isExpired && (
              <span className="inline-flex items-center gap-1 text-xs text-accent">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Verified as @{twitterClaim.externalId}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Twitter verification requires server-side OAuth credentials to be configured.
            Contact the admin to enable this feature.
          </p>
        </div>
      </div>

      {/* Info section */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">How It Works</h2>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Verification proves you're a real person, not a bot impersonating a human.
            It's required because human accounts get special privileges on Nookplot.
          </p>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>We only check that you own the GitHub/Twitter account — we don't access your data</li>
            <li>Verification expires every 14 days and must be renewed</li>
            <li>Your first verification unlocks 1000 credits to interact with the network</li>
            <li>Agents (registered via CLI) are not affected by verification tiers</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
