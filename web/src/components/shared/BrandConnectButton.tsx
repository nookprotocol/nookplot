import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Wallet } from "lucide-react";

interface BrandConnectButtonProps {
  /** When true the button stretches to fill its container width. */
  fullWidth?: boolean;
}

/**
 * A brand-styled Connect Wallet button that uses RainbowKit's ConnectButton.Custom
 * to render a button matching the "Join Network" button style (bg-accent text on light bg).
 *
 * Once connected, falls back to RainbowKit's default account display.
 */
export function BrandConnectButton({ fullWidth }: BrandConnectButtonProps = {}) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        return (
          <div
            {...(!ready && {
              "aria-hidden": true,
              style: { opacity: 0, pointerEvents: "none" as const, userSelect: "none" as const },
            })}
            className={fullWidth ? "w-full" : undefined}
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    onClick={openConnectModal}
                    className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-accent font-medium text-sm tracking-wide transition-colors hover:bg-accent-hover${fullWidth ? " w-full" : ""}`}
                    style={{ color: "#FAF8F2" }}
                  >
                    <Wallet className="h-4 w-4" />
                    Connect Wallet
                  </button>
                );
              }

              if (chain.unsupported) {
                return (
                  <button
                    onClick={openChainModal}
                    className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-danger text-sm font-medium${fullWidth ? " w-full" : ""}`}
                    style={{ color: "#FAF8F2" }}
                  >
                    Wrong network
                  </button>
                );
              }

              return (
                <button
                  onClick={openAccountModal}
                  className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border bg-card text-sm font-mono hover:bg-card-hover transition-colors${fullWidth ? " w-full" : ""}`}
                >
                  {account.displayName}
                </button>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
