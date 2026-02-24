import { useState } from "react";
import { useAgentDomains, useRegisterDomain, useDeleteDomain, useVerifyDomain } from "@/hooks/useAgentDomains";
import type { VerificationInstructions } from "@/hooks/useAgentDomains";
import { Globe, Plus, CheckCircle, XCircle, Trash2, Shield, Copy, Check } from "lucide-react";

export function AgentDomainsPage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [pendingVerification, setPendingVerification] = useState<{
    domain: string;
    instructions: VerificationInstructions;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  const { domains, isLoading, refresh } = useAgentDomains(connected ? apiKey : null);
  const { register, isRegistering, error: registerError } = useRegisterDomain(connected ? apiKey : null);
  const { deleteDomain, isDeleting } = useDeleteDomain(connected ? apiKey : null);
  const { verify, isVerifying } = useVerifyDomain(connected ? apiKey : null);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleRegister = async () => {
    if (!newDomain.trim()) return;
    const result = await register(newDomain.trim().toLowerCase());
    if (result) {
      setPendingVerification({
        domain: result.domain.domain,
        instructions: result.verificationInstructions,
      });
      setNewDomain("");
      refresh();
    }
  };

  const handleVerify = async (domainId: string) => {
    setVerifyResult(null);
    const result = await verify(domainId);
    if (result?.verified) {
      setVerifyResult("Domain verified!");
      setPendingVerification(null);
      refresh();
    } else {
      setVerifyResult(result?.error ?? "Verification failed");
    }
  };

  const handleDelete = async (domainId: string) => {
    const ok = await deleteDomain(domainId);
    if (ok) refresh();
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!connected) {
    return (
      <div className="max-w-2xl mx-auto py-16">
        <div className="text-center mb-8">
          <Globe className="h-12 w-12 text-accent mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Custom Domains</h1>
          <p className="text-muted-foreground">
            Register and verify custom domains for your agent.
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-6">
          <label className="block text-sm font-medium mb-2">API Key</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              placeholder="nk_..."
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={handleConnect}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Globe className="h-6 w-6 text-accent" />
          Custom Domains
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Register custom domains for your agent&apos;s reachability and brand.
        </p>
      </div>

      {/* Register New Domain */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Register Domain
        </h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRegister()}
            placeholder="agent.example.com"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={handleRegister}
            disabled={isRegistering || !newDomain.trim()}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
          >
            {isRegistering ? "Registering..." : "Register"}
          </button>
        </div>
        {registerError && (
          <p className="text-red-400 text-xs mt-2">{registerError}</p>
        )}
      </div>

      {/* Pending Verification Instructions */}
      {pendingVerification && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-5">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2 text-amber-400">
            <Shield className="h-4 w-4" />
            Verify {pendingVerification.domain}
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Add the following DNS TXT record to verify ownership:
          </p>
          <div className="bg-background rounded-lg p-4 space-y-2 font-mono text-xs">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Host:</span>
              <span className="text-foreground">{pendingVerification.instructions.record}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Type:</span>
              <span className="text-foreground">TXT</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Value:</span>
              <span className="text-foreground break-all">{pendingVerification.instructions.value}</span>
              <button
                onClick={() => copyToClipboard(pendingVerification.instructions.value)}
                className="ml-auto shrink-0 p-1 hover:bg-card rounded transition-colors"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">TTL:</span>
              <span className="text-foreground">{pendingVerification.instructions.ttl}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            After adding the record, click &quot;Verify&quot; on the domain below. DNS propagation may take a few minutes.
          </p>
          {verifyResult && (
            <p className={`text-xs mt-2 ${verifyResult.includes("verified") ? "text-green-400" : "text-red-400"}`}>
              {verifyResult}
            </p>
          )}
        </div>
      )}

      {/* Domain List */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Your Domains</h2>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-16 bg-card border border-border rounded-xl animate-pulse" />
            ))}
          </div>
        ) : domains.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No domains registered yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {domains.map((domain) => (
              <div
                key={domain.id}
                className="bg-card border border-border rounded-xl px-5 py-4 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm font-semibold">{domain.domain}</span>
                    {domain.verified ? (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-green-400 bg-green-400/10">
                        <CheckCircle className="h-3 w-3" />
                        Verified
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-amber-400 bg-amber-400/10">
                        <XCircle className="h-3 w-3" />
                        Unverified
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Added {new Date(domain.createdAt).toLocaleDateString()}
                    {domain.verifiedAt && ` · Verified ${new Date(domain.verifiedAt).toLocaleDateString()}`}
                  </div>
                </div>

                <div className="flex gap-2 shrink-0">
                  {!domain.verified && (
                    <button
                      onClick={() => handleVerify(domain.id)}
                      disabled={isVerifying}
                      className="px-3 py-1.5 text-xs border border-accent/30 text-accent rounded-lg hover:bg-accent/10 transition-colors disabled:opacity-50"
                    >
                      {isVerifying ? "Checking..." : "Verify"}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(domain.id)}
                    disabled={isDeleting}
                    className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
