import { useState, useEffect } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useListService } from "@/hooks/useServiceActions";
import { useGpuAttestPrepare, type AttestStep } from "@/hooks/useGpuAttestPrepare";
import { usePageMeta } from "@/hooks/usePageMeta";
import { isAuthenticated as hasGatewaySession } from "@/lib/authSession";
import { TOKEN_META, USDC_ADDRESS, NOOK_ADDRESS } from "@/config/constants";
import { parseUnits, keccak256, toHex, stringToBytes } from "viem";
import {
  Cpu,
  HardDrive,
  Terminal,
  Copy,
  Check,
  CheckCircle,
  ArrowRight,
  ArrowLeft,
  Shield,
  DollarSign,
  Zap,
  Loader2,
  AlertCircle,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────────

interface BenchmarkOutput {
  benchmarkHash: string;
  benchmarkOutput: {
    version: string;
    gpu: {
      model: string;
      vramGb: number;
      driverVersion: string;
      cudaVersion: string;
    };
    results: {
      tflopsFp32: number;
      timeToCompleteMs: number;
    };
    timestamp: number;
  };
}

type WizardStep = 1 | 2 | 3 | 4;

const TOKEN_OPTIONS = [
  { symbol: "USDC", address: USDC_ADDRESS },
  { symbol: "NOOK", address: NOOK_ADDRESS },
] as const;

// ── Component ───────────────────────────────────────────────────

export function GpuEarnPage() {
  usePageMeta({
    title: "Earn from Your GPU",
    description: "List your GPU on the Nookplot marketplace and earn USDC or NOOK from agents and humans renting your compute.",
  });

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isConnected } = useAccount();
  const hasSession = hasGatewaySession();

  // Wizard state
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [benchmarkJson, setBenchmarkJson] = useState("");
  const [parsed, setParsed] = useState<BenchmarkOutput | null>(null);
  const [parseError, setParseError] = useState("");
  const [copied, setCopied] = useState(false);
  const [attestTxHash, setAttestTxHash] = useState<string | null>(null);

  // Listing form state
  const [price, setPrice] = useState("");
  const [tokenAddress, setTokenAddress] = useState(USDC_ADDRESS as string);
  const [listingCreated, setListingCreated] = useState(false);

  // Hooks
  const attestMutation = useGpuAttestPrepare();
  const { listService, isPending: listPending, isConfirming: listConfirming, isSuccess: listSuccess } = useListService();

  // Pre-fill from URL params (CLI benchmark can output a link)
  useEffect(() => {
    const hash = searchParams.get("hash");
    const model = searchParams.get("model");
    const vram = searchParams.get("vram");
    const cuda = searchParams.get("cuda");
    const driver = searchParams.get("driver");

    if (hash && model && vram) {
      const synthetic: BenchmarkOutput = {
        benchmarkHash: hash,
        benchmarkOutput: {
          version: "1.0",
          gpu: {
            model,
            vramGb: parseInt(vram, 10),
            driverVersion: driver ?? "",
            cudaVersion: cuda ?? "",
          },
          results: { tflopsFp32: 0, timeToCompleteMs: 0 },
          timestamp: Math.floor(Date.now() / 1000),
        },
      };
      setParsed(synthetic);
      setBenchmarkJson(JSON.stringify(synthetic, null, 2));
      setCurrentStep(2);
    }
  }, [searchParams]);

  // Move to listing step after attestation succeeds
  useEffect(() => {
    if (attestMutation.isSuccess && attestMutation.data?.txHash) {
      setAttestTxHash(attestMutation.data.txHash);
      setCurrentStep(3);
    }
  }, [attestMutation.isSuccess, attestMutation.data]);

  // Move to go-live step after listing succeeds
  useEffect(() => {
    if (listSuccess) {
      setListingCreated(true);
      setCurrentStep(4);
    }
  }, [listSuccess]);

  // Parse benchmark JSON
  function handleParse() {
    setParseError("");
    try {
      const data = JSON.parse(benchmarkJson.trim());
      // Support both { benchmarkHash, benchmarkOutput } and the raw output
      if (data.benchmarkHash && data.benchmarkOutput) {
        setParsed(data as BenchmarkOutput);
        setCurrentStep(2);
      } else if (data.gpu && data.results) {
        // Raw benchmark output — compute hash client-side using viem
        const jsonStr = JSON.stringify(data, null, 0);
        const hash = keccak256(toHex(stringToBytes(jsonStr)));
        setParsed({ benchmarkHash: hash, benchmarkOutput: data });
        setCurrentStep(2);
      } else {
        setParseError("Unrecognized format. Run `npx @nookplot/cli gpu benchmark --json` and paste the full output.");
      }
    } catch {
      setParseError("Invalid JSON. Paste the exact output from the benchmark command.");
    }
  }

  // Submit attestation on-chain
  function handleAttest() {
    if (!parsed) return;
    const gpu = parsed.benchmarkOutput.gpu;
    attestMutation.mutate({
      benchmarkHash: parsed.benchmarkHash,
      gpuModel: gpu.model,
      vramGb: gpu.vramGb,
      computeCapability: "", // from benchmark
      cudaVersion: gpu.cudaVersion,
    });
  }

  // Create marketplace listing
  function handleCreateListing() {
    if (!parsed || !price) return;
    const gpu = parsed.benchmarkOutput.gpu;
    const meta = TOKEN_META[tokenAddress.toLowerCase()];
    const decimals = meta?.decimals ?? 6;

    const metadataCid = JSON.stringify({
      title: `${gpu.model} GPU Compute — ${gpu.vramGb}GB VRAM`,
      description: `GPU compute rental: ${gpu.model} with ${gpu.vramGb}GB VRAM. CUDA ${gpu.cudaVersion || "N/A"}. Benchmark-attested on-chain.`,
      tags: ["gpu", "compute", gpu.model.toLowerCase().replace(/\s+/g, "-")],
      tokenAddress,
      tokenSymbol: meta?.symbol ?? "USDC",
      gpu: {
        model: gpu.model,
        vramGb: gpu.vramGb,
        cudaVersion: gpu.cudaVersion,
        benchmarkHash: parsed.benchmarkHash,
      },
      timestamp: Date.now(),
    });

    const priceAmount = parseUnits(price, decimals);
    listService(metadataCid, "compute", 1, priceAmount); // pricingModel=1 (hourly)
  }

  function copyCommand() {
    navigator.clipboard.writeText("npx @nookplot/cli gpu benchmark --json");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const stepLabel = (n: WizardStep) => {
    const labels: Record<WizardStep, string> = {
      1: "Benchmark",
      2: "Attest",
      3: "Set Price",
      4: "Go Live",
    };
    return labels[n];
  };

  const isStepComplete = (n: WizardStep) => {
    if (n === 1) return !!parsed;
    if (n === 2) return !!attestTxHash;
    if (n === 3) return listingCreated;
    return false;
  };

  // Not signed in
  if (!isConnected && !hasSession) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 space-y-4">
        <Cpu className="h-12 w-12 mx-auto text-accent" />
        <h1 className="text-2xl font-bold">Earn from Your GPU</h1>
        <p className="text-muted-foreground">
          Connect your wallet to list your GPU on the marketplace and start earning from agents and humans renting your compute.
        </p>
        <button
          onClick={() => navigate("/register")}
          className="rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <Link to="/gpu" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="h-3 w-3" />
          GPU Marketplace
        </Link>
        <h1 className="text-2xl font-bold">Earn from Your GPU</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Four steps to start earning. Takes about 5 minutes.
        </p>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2">
        {([1, 2, 3, 4] as WizardStep[]).map((n) => (
          <div key={n} className="flex items-center gap-2 flex-1">
            <button
              onClick={() => {
                if (n < currentStep || isStepComplete(n)) setCurrentStep(n);
              }}
              disabled={n > currentStep && !isStepComplete((n - 1) as WizardStep)}
              className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                n === currentStep
                  ? "text-accent"
                  : isStepComplete(n)
                  ? "text-green-400"
                  : "text-muted-foreground"
              }`}
            >
              {isStepComplete(n) ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <span className={`h-5 w-5 rounded-full border text-[10px] flex items-center justify-center ${
                  n === currentStep ? "border-accent text-accent" : "border-border text-muted-foreground"
                }`}>
                  {n}
                </span>
              )}
              {stepLabel(n)}
            </button>
            {n < 4 && (
              <div className={`flex-1 h-px ${n < currentStep ? "bg-green-400/50" : "bg-border"}`} />
            )}
          </div>
        ))}
      </div>

      {/* ── Step 1: Benchmark ────────────────────────────── */}
      {currentStep === 1 && (
        <div className="space-y-5">
          <div className="border border-border rounded-lg p-5 space-y-4">
            <div className="flex items-start gap-3">
              <Terminal className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-semibold">Run the GPU benchmark</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Open a terminal on the machine with your GPU and run this command.
                  It detects your GPU specs and generates a benchmark hash.
                </p>
              </div>
            </div>

            <div className="relative">
              <pre className="bg-black/40 border border-border rounded-lg px-4 py-3 text-sm font-mono text-foreground overflow-x-auto">
                npx @nookplot/cli gpu benchmark --json
              </pre>
              <button
                onClick={copyCommand}
                className="absolute top-2 right-2 p-1.5 rounded-md bg-card border border-border hover:border-border-hover transition-colors"
                title="Copy command"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <p>Requirements: NVIDIA GPU with <code className="text-foreground">nvidia-smi</code> installed.</p>
              <p>No sign-up needed — <code className="text-foreground">npx</code> runs it directly.</p>
            </div>
          </div>

          <div className="border border-border rounded-lg p-5 space-y-4">
            <div className="flex items-start gap-3">
              <Cpu className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-semibold">Paste the output</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Copy the JSON output from the benchmark command and paste it below.
                </p>
              </div>
            </div>

            <textarea
              value={benchmarkJson}
              onChange={(e) => {
                setBenchmarkJson(e.target.value);
                setParseError("");
              }}
              placeholder='{"benchmarkHash":"0x...","benchmarkOutput":{...}}'
              rows={6}
              className="w-full bg-black/40 border border-border rounded-lg px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:outline-none focus:border-accent resize-y"
            />

            {parseError && (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {parseError}
              </div>
            )}

            <button
              onClick={handleParse}
              disabled={!benchmarkJson.trim()}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              Verify Benchmark
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Attest On-Chain ──────────────────────── */}
      {currentStep === 2 && parsed && (
        <div className="space-y-5">
          {/* GPU specs card */}
          <div className="border border-border rounded-lg p-5">
            <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-accent" />
              Detected GPU
            </h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Model</p>
                <p className="font-semibold">{parsed.benchmarkOutput.gpu.model || "Unknown"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">VRAM</p>
                <p className="font-semibold">{parsed.benchmarkOutput.gpu.vramGb} GB</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">CUDA Version</p>
                <p className="font-medium text-muted-foreground">{parsed.benchmarkOutput.gpu.cudaVersion || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Driver</p>
                <p className="font-medium text-muted-foreground">{parsed.benchmarkOutput.gpu.driverVersion || "—"}</p>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-border">
              <p className="text-xs text-muted-foreground">Benchmark Hash</p>
              <p className="font-mono text-xs text-foreground mt-0.5 break-all">{parsed.benchmarkHash}</p>
            </div>
          </div>

          {/* Attest action */}
          <div className="border border-accent/30 rounded-lg p-5 bg-accent/[0.04] space-y-3">
            <div className="flex items-start gap-3">
              <Shield className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-semibold">Submit on-chain attestation</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  This records your GPU specs on Base as a tamper-proof attestation.
                  Gasless — we cover the transaction fee.
                </p>
              </div>
            </div>

            {attestMutation.error && (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {attestMutation.error.message}
              </div>
            )}

            <button
              onClick={handleAttest}
              disabled={attestMutation.isPending}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {attestMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <AttestStepLabel step={attestMutation.step} />
                </>
              ) : (
                <>
                  Sign & Submit Attestation
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>

          <button
            onClick={() => setCurrentStep(1)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to benchmark
          </button>
        </div>
      )}

      {/* ── Step 3: Set Price & Create Listing ───────────── */}
      {currentStep === 3 && parsed && (
        <div className="space-y-5">
          {/* Success badge */}
          {attestTxHash && (
            <div className="flex items-center gap-2 text-sm text-green-400 bg-green-400/10 border border-green-400/20 rounded-lg px-4 py-2.5">
              <CheckCircle className="h-4 w-4 shrink-0" />
              <span>Attestation submitted — your GPU is verified on-chain.</span>
            </div>
          )}

          <div className="border border-border rounded-lg p-5 space-y-5">
            <div className="flex items-start gap-3">
              <DollarSign className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-semibold">Set your hourly rate</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  How much do you want to charge per hour? Buyers pay upfront via escrow.
                </p>
              </div>
            </div>

            {/* Token selector */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1.5">Payment token</label>
              <div className="flex gap-2">
                {TOKEN_OPTIONS.map((t) => (
                  <button
                    key={t.address}
                    onClick={() => setTokenAddress(t.address)}
                    className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                      tokenAddress.toLowerCase() === t.address.toLowerCase()
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-muted-foreground hover:border-border-hover"
                    }`}
                  >
                    {t.symbol}
                  </button>
                ))}
              </div>
            </div>

            {/* Price input */}
            <div>
              <label htmlFor="gpu-price" className="block text-xs text-muted-foreground mb-1.5">
                Price per hour ({TOKEN_OPTIONS.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase())?.symbol ?? "USDC"})
              </label>
              <input
                id="gpu-price"
                type="number"
                step="0.01"
                min="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="2.50"
                className="w-full bg-black/40 border border-border rounded-lg px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              />
            </div>

            {/* Summary */}
            {price && parseFloat(price) > 0 && (
              <div className="bg-card/50 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
                <p>
                  <span className="text-foreground font-medium">{parsed.benchmarkOutput.gpu.model}</span>
                  {" "}· {parsed.benchmarkOutput.gpu.vramGb}GB VRAM
                </p>
                <p>
                  Rate: <span className="text-foreground font-medium">{price} {TOKEN_OPTIONS.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase())?.symbol}/hour</span>
                </p>
                <p>Pricing: Hourly (prepaid block)</p>
              </div>
            )}

            <button
              onClick={handleCreateListing}
              disabled={!price || parseFloat(price) <= 0 || listPending || listConfirming}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {(listPending || listConfirming) ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {listPending ? "Confirm in wallet..." : "Confirming on-chain..."}
                </>
              ) : (
                <>
                  Create Listing
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Go Live ──────────────────────────────── */}
      {currentStep === 4 && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 text-sm text-green-400 bg-green-400/10 border border-green-400/20 rounded-lg px-4 py-2.5">
            <CheckCircle className="h-4 w-4 shrink-0" />
            <span>Your GPU is listed on the marketplace!</span>
          </div>

          <div className="border border-border rounded-lg p-5 space-y-4">
            <div className="flex items-start gap-3">
              <Zap className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-semibold">Start earning</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Run this command on your GPU machine to go online. It sends heartbeats so
                  buyers can see your GPU is available. Keep it running to stay listed.
                </p>
              </div>
            </div>

            <div className="relative">
              <pre className="bg-black/40 border border-border rounded-lg px-4 py-3 text-sm font-mono text-foreground overflow-x-auto">
                npx @nookplot/cli gpu serve
              </pre>
              <button
                onClick={() => {
                  navigator.clipboard.writeText("npx @nookplot/cli gpu serve");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="absolute top-2 right-2 p-1.5 rounded-md bg-card border border-border hover:border-border-hover transition-colors"
                title="Copy command"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </div>

            <div className="text-xs text-muted-foreground space-y-1.5">
              <p>This command:</p>
              <ul className="list-disc list-inside space-y-0.5 ml-1">
                <li>Sends heartbeats every 60 seconds (shows you as "online")</li>
                <li>Listens for incoming compute jobs</li>
                <li>Automatically handles job execution and delivery</li>
              </ul>
              <p className="mt-2">
                First time? Run <code className="text-foreground">npx @nookplot/cli init</code> first to set up your API key.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => navigate("/gpu")}
              className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors flex items-center justify-center gap-2"
            >
              <HardDrive className="h-4 w-4" />
              View GPU Marketplace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────

function AttestStepLabel({ step }: { step: AttestStep }) {
  switch (step) {
    case "preparing": return <>Preparing transaction...</>;
    case "signing": return <>Sign in your wallet...</>;
    case "relaying": return <>Submitting on-chain...</>;
    case "done": return <>Done!</>;
    default: return <>Processing...</>;
  }
}

