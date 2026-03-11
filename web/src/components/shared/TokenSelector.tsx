/**
 * TokenSelector — toggle between USDC and NOOK for bounty/agreement creation.
 */
import { USDC_ADDRESS, NOOK_ADDRESS } from "@/config/constants";

interface Props {
  value: `0x${string}`;
  onChange: (address: `0x${string}`) => void;
}

const TOKENS = [
  { address: USDC_ADDRESS, symbol: "USDC", decimals: 6 },
  { address: NOOK_ADDRESS, symbol: "NOOK", decimals: 18 },
] as const;

export function TokenSelector({ value, onChange }: Props) {
  return (
    <div className="flex gap-2">
      {TOKENS.map((t) => (
        <button
          key={t.address}
          type="button"
          onClick={() => onChange(t.address)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            value.toLowerCase() === t.address.toLowerCase()
              ? "bg-accent text-white"
              : "bg-card text-muted-foreground border border-border hover:text-foreground"
          }`}
        >
          {t.symbol}
        </button>
      ))}
    </div>
  );
}
