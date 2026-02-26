import { useState } from "react";

interface RevenueConfigFormProps {
  agent: string;
  currentConfig?: {
    ownerBps: number;
    receiptChainBps: number;
    treasuryBps: number;
    bundleId: number;
  };
  onSubmit: (config: {
    ownerBps: number;
    receiptChainBps: number;
    treasuryBps: number;
    bundleId: number;
  }) => void;
  isSubmitting?: boolean;
}

export function RevenueConfigForm({
  currentConfig,
  onSubmit,
  isSubmitting = false,
}: RevenueConfigFormProps) {
  const [ownerBps, setOwnerBps] = useState(currentConfig?.ownerBps ?? 5000);
  const [chainBps, setChainBps] = useState(currentConfig?.receiptChainBps ?? 4000);
  const [treasuryBps, setTreasuryBps] = useState(currentConfig?.treasuryBps ?? 1000);
  const [bundleId, setBundleId] = useState(currentConfig?.bundleId ?? 0);

  const total = ownerBps + chainBps + treasuryBps;
  const isValid = total === 10000;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Revenue Share Configuration</h3>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Owner (bps)
          </label>
          <input
            type="number"
            value={ownerBps}
            onChange={(e) => setOwnerBps(Number(e.target.value))}
            min={0}
            max={10000}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Receipt Chain (bps)
          </label>
          <input
            type="number"
            value={chainBps}
            onChange={(e) => setChainBps(Number(e.target.value))}
            min={0}
            max={10000}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Treasury (bps)
          </label>
          <input
            type="number"
            value={treasuryBps}
            onChange={(e) => setTreasuryBps(Number(e.target.value))}
            min={0}
            max={10000}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Bundle ID
        </label>
        <input
          type="number"
          value={bundleId}
          onChange={(e) => setBundleId(Number(e.target.value))}
          min={0}
          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
      </div>

      <div className="flex items-center justify-between">
        <span className={`text-xs ${isValid ? "text-green-400" : "text-red-400"}`}>
          Total: {total} / 10000 bps {isValid ? "(valid)" : "(must equal 10000)"}
        </span>
        <button
          onClick={() => onSubmit({ ownerBps, receiptChainBps: chainBps, treasuryBps, bundleId })}
          disabled={!isValid || isSubmitting}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Saving..." : "Save Config"}
        </button>
      </div>
    </div>
  );
}
