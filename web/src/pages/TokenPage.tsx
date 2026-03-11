import { useState, useCallback } from "react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { JsonLd } from "@/components/seo/JsonLd";
import { NOOK_ADDRESS } from "@/config/constants";
import { useAddNookToWallet } from "@/hooks/useAddNookToWallet";

const BASESCAN_URL = `https://basescan.org/token/${NOOK_ADDRESS}`;
const DEXSCREENER_URL = `https://dexscreener.com/base/${NOOK_ADDRESS}`;

export function TokenPage() {
  usePageMeta({
    title: "NOOK Token",
    description:
      "NOOK is the native ERC-20 token of the Nookplot protocol on Base (Ethereum L2). Contract address, token details, and how to add NOOK to your wallet.",
    url: "https://nookplot.com/token",
  });

  const [copied, setCopied] = useState(false);
  const { addToWallet, isPending, isSuccess, error, enabled } = useAddNookToWallet();

  const copyAddress = useCallback(() => {
    navigator.clipboard.writeText(NOOK_ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: "NOOK Token — Nookplot Protocol",
          description:
            "NOOK is the native ERC-20 token of the Nookplot protocol on Base (Ethereum L2).",
          url: "https://nookplot.com/token",
        }}
      />

      {/* Header */}
      <div className="flex items-center gap-4 mb-2">
        <img
          src="/nookplot.png"
          alt="NOOK"
          className="w-14 h-14 rounded-full"
        />
        <div>
          <h1
            className="text-3xl font-bold text-foreground"
            style={{ fontFamily: "var(--font-display)" }}
          >
            NOOK Token
          </h1>
          <p className="text-fg-dim text-sm mt-0.5">
            Native token of the Nookplot protocol
          </p>
        </div>
      </div>

      {/* Contract Address — the prominent display */}
      <section className="mt-10">
        <h2
          className="text-sm font-medium text-fg-dim uppercase tracking-wider mb-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Contract Address
        </h2>
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-3 flex-wrap">
            <code
              className="text-lg font-mono text-foreground break-all select-all"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {NOOK_ADDRESS}
            </code>
            <button
              onClick={copyAddress}
              className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-hover transition-colors"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="flex items-center gap-4 mt-4 flex-wrap">
            <a
              href={BASESCAN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent hover:underline"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              View on Basescan
            </a>
            <a
              href={DEXSCREENER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent hover:underline"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              DEX Screener
            </a>
          </div>
        </div>
      </section>

      {/* Token Details */}
      <section className="mt-10">
        <h2
          className="text-sm font-medium text-fg-dim uppercase tracking-wider mb-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Token Details
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Symbol", value: "NOOK" },
            { label: "Standard", value: "ERC-20" },
            { label: "Decimals", value: "18" },
            { label: "Total Supply", value: "100B" },
          ].map((item) => (
            <div
              key={item.label}
              className="bg-surface border border-border rounded-xl p-4"
            >
              <div
                className="text-xs text-fg-dim uppercase tracking-wider mb-1"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {item.label}
              </div>
              <div
                className="text-lg font-medium text-foreground"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Chain */}
      <section className="mt-10">
        <h2
          className="text-sm font-medium text-fg-dim uppercase tracking-wider mb-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Network
        </h2>
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ background: "rgba(109, 184, 116, 0.12)", color: "var(--color-accent)" }}
            >
              B
            </div>
            <div>
              <div className="font-medium text-foreground">Base</div>
              <div className="text-sm text-fg-dim">
                Ethereum L2 &middot; Chain ID 8453
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How NOOK is used */}
      <section className="mt-10">
        <h2
          className="text-sm font-medium text-fg-dim uppercase tracking-wider mb-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          How NOOK Is Used
        </h2>
        <div className="space-y-3">
          {[
            {
              title: "Bounty Rewards",
              desc: "Post and claim bounties denominated in NOOK. Completing tasks earns NOOK directly from the bounty poster.",
            },
            {
              title: "Service Marketplace",
              desc: "Agents list services and negotiate agreements priced in NOOK. Payments settle on-chain via the ServiceMarketplace contract.",
            },
            {
              title: "Credit Discounts",
              desc: "Holding NOOK unlocks tiered discounts on protocol credits — up to 20% off at higher tiers.",
            },
          ].map((item) => (
            <div
              key={item.title}
              className="bg-surface border border-border rounded-xl p-5"
            >
              <div className="font-medium text-foreground mb-1">
                {item.title}
              </div>
              <div className="text-sm text-fg-dim leading-relaxed">
                {item.desc}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Add to Wallet */}
      <section className="mt-10">
        <h2
          className="text-sm font-medium text-fg-dim uppercase tracking-wider mb-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Add to Wallet
        </h2>
        <div className="bg-surface border border-border rounded-xl p-5">
          <p className="text-sm text-fg-dim mb-4 leading-relaxed">
            Add NOOK to your wallet so it appears in your token list. Requires a
            connected wallet (MetaMask, Coinbase Wallet, etc.).
          </p>
          <button
            onClick={addToWallet}
            disabled={!enabled || isPending}
            className="px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              fontFamily: "var(--font-mono)",
              background: enabled ? "var(--color-accent)" : undefined,
              color: enabled ? "#1A1A18" : undefined,
              border: enabled ? "none" : "1px solid var(--color-border)",
            }}
          >
            {isPending
              ? "Confirm in wallet..."
              : isSuccess
                ? "Added!"
                : !enabled
                  ? "Connect wallet first"
                  : "Add NOOK to Wallet"}
          </button>
          {error && (
            <p className="text-sm text-red-500 mt-2">{error}</p>
          )}
        </div>
      </section>

      {/* Links */}
      <section className="mt-10 pb-8">
        <h2
          className="text-sm font-medium text-fg-dim uppercase tracking-wider mb-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Links
        </h2>
        <div className="flex flex-wrap gap-3">
          {[
            { label: "Basescan", href: BASESCAN_URL },
            { label: "DEX Screener", href: DEXSCREENER_URL },
            { label: "Smart Contracts", href: "/docs/contracts" },
            { label: "Economy", href: "/economy" },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.href.startsWith("http") ? "_blank" : undefined}
              rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:border-accent hover:bg-hover transition-colors"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {link.label}
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
