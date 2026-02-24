import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { Rocket, ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useBundles } from "@/hooks/useBundles";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

type WizardStep = "bundle" | "identity" | "avatar" | "review";

interface SoulForm {
  name: string;
  tagline: string;
  description: string;
  traits: string[];
  communicationStyle: string;
  communicationTone: string;
  verbosity: string;
  mission: string;
  domains: string[];
  goals: string[];
  avatarPalette: string;
  avatarShape: string;
  avatarComplexity: number;
}

const STEPS: WizardStep[] = ["bundle", "identity", "avatar", "review"];
const STEP_LABELS: Record<WizardStep, string> = {
  bundle: "Select Bundle",
  identity: "Identity & Personality",
  avatar: "Avatar",
  review: "Review & Deploy",
};

const PALETTES = ["ocean", "sunset", "forest", "neon", "cosmic", "earth", "mono"];
const SHAPES = ["circle", "hexagon", "diamond", "square"];

export function DeployAgentPage() {
  const { isConnected, address } = useAccount();
  const { bundles, isLoading: bundlesLoading } = useBundles(0, 50);

  const [step, setStep] = useState<WizardStep>("bundle");
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [form, setForm] = useState<SoulForm>({
    name: "",
    tagline: "",
    description: "",
    traits: [""],
    communicationStyle: "balanced",
    communicationTone: "friendly",
    verbosity: "moderate",
    mission: "",
    domains: [""],
    goals: [""],
    avatarPalette: "ocean",
    avatarShape: "circle",
    avatarComplexity: 3,
  });
  const [error, setError] = useState("");

  if (!isConnected) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Connect your wallet to deploy an agent.</p>
      </div>
    );
  }

  const currentStepIndex = STEPS.indexOf(step);
  const canGoBack = currentStepIndex > 0;
  const selectedBundle = bundles.find((b) => b.bundleId === selectedBundleId);

  const goNext = () => {
    setError("");
    if (step === "bundle" && !selectedBundleId) {
      setError("Select a knowledge bundle.");
      return;
    }
    if (step === "identity") {
      if (!form.name.trim()) { setError("Agent name is required."); return; }
      if (!form.mission.trim()) { setError("Mission is required."); return; }
    }
    if (currentStepIndex < STEPS.length - 1) {
      setStep(STEPS[currentStepIndex + 1]);
    }
  };

  const goBack = () => {
    setError("");
    if (currentStepIndex > 0) {
      setStep(STEPS[currentStepIndex - 1]);
    }
  };

  const updateList = (
    field: "traits" | "domains" | "goals",
    index: number,
    value: string,
  ) => {
    const updated = [...form[field]];
    updated[index] = value;
    setForm({ ...form, [field]: updated });
  };

  const addToList = (field: "traits" | "domains" | "goals") => {
    setForm({ ...form, [field]: [...form[field], ""] });
  };

  const removeFromList = (field: "traits" | "domains" | "goals", index: number) => {
    setForm({ ...form, [field]: form[field].filter((_, i) => i !== index) });
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
      </div>

      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <Rocket className="h-6 w-6 text-accent" />
        Deploy Agent
      </h1>

      {/* Step indicators */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${
                i < currentStepIndex
                  ? "bg-accent text-white"
                  : i === currentStepIndex
                    ? "bg-accent/20 text-accent border border-accent"
                    : "bg-card text-muted-foreground"
              }`}
            >
              {i < currentStepIndex ? <Check className="h-4 w-4" /> : i + 1}
            </div>
            <span className={`text-sm hidden sm:inline ${i === currentStepIndex ? "text-foreground font-medium" : "text-muted-foreground"}`}>
              {STEP_LABELS[s]}
            </span>
            {i < STEPS.length - 1 && (
              <div className="w-8 h-px bg-border" />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Step 1: Select Bundle */}
      {step === "bundle" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground mb-4">
            Choose the knowledge bundle that will shape your agent's expertise.
          </p>
          {bundlesLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 bg-card rounded-lg animate-pulse" />
              ))}
            </div>
          ) : bundles.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No bundles available. <Link to="/bundles/create" className="text-accent hover:underline">Create one first.</Link>
            </p>
          ) : (
            bundles.map((b) => (
              <button
                key={b.bundleId}
                onClick={() => setSelectedBundleId(b.bundleId)}
                className={`w-full text-left rounded-lg border p-4 transition-colors ${
                  selectedBundleId === b.bundleId
                    ? "border-accent bg-accent/5"
                    : "border-border bg-card hover:border-muted-foreground"
                }`}
              >
                <div className="font-medium">{b.name}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {b.cidCount} CIDs · {b.contributorCount} contributors
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {/* Step 2: Identity & Personality */}
      {step === "identity" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
              placeholder="e.g. PhiloBot"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Tagline</label>
            <input
              type="text"
              value={form.tagline}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
              placeholder="A short tagline for your agent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
              rows={3}
              placeholder="What does this agent do?"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Personality Traits</label>
            {form.traits.map((t, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={t}
                  onChange={(e) => updateList("traits", i, e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  placeholder="e.g. curious, analytical"
                />
                {form.traits.length > 1 && (
                  <button onClick={() => removeFromList("traits", i)} className="text-muted-foreground hover:text-red-400 text-sm px-2">
                    Remove
                  </button>
                )}
              </div>
            ))}
            {form.traits.length < 20 && (
              <button onClick={() => addToList("traits")} className="text-xs text-accent hover:underline">
                + Add trait
              </button>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Mission *</label>
            <input
              type="text"
              value={form.mission}
              onChange={(e) => setForm({ ...form, mission: e.target.value })}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
              placeholder="The agent's core purpose"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Domains</label>
            {form.domains.map((d, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={d}
                  onChange={(e) => updateList("domains", i, e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  placeholder="e.g. philosophy, ethics"
                />
                {form.domains.length > 1 && (
                  <button onClick={() => removeFromList("domains", i)} className="text-muted-foreground hover:text-red-400 text-sm px-2">
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button onClick={() => addToList("domains")} className="text-xs text-accent hover:underline">
              + Add domain
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Avatar */}
      {step === "avatar" && (
        <div className="space-y-6">
          <div className="flex justify-center">
            <ProceduralAvatar
              address={address ?? "0x0000000000000000000000000000000000000000"}
              traits={{
                palette: form.avatarPalette,
                shape: form.avatarShape,
                complexity: form.avatarComplexity,
              }}
              size={128}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Palette</label>
            <div className="flex flex-wrap gap-2">
              {PALETTES.map((p) => (
                <button
                  key={p}
                  onClick={() => setForm({ ...form, avatarPalette: p })}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                    form.avatarPalette === p
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Shape</label>
            <div className="flex flex-wrap gap-2">
              {SHAPES.map((s) => (
                <button
                  key={s}
                  onClick={() => setForm({ ...form, avatarShape: s })}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                    form.avatarShape === s
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">
              Complexity: {form.avatarComplexity}
            </label>
            <input
              type="range"
              min={1}
              max={5}
              value={form.avatarComplexity}
              onChange={(e) => setForm({ ...form, avatarComplexity: parseInt(e.target.value) })}
              className="w-full"
            />
          </div>
        </div>
      )}

      {/* Step 4: Review & Deploy */}
      {step === "review" && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 mb-6">
            <ProceduralAvatar
              address={address ?? "0x0000000000000000000000000000000000000000"}
              traits={{
                palette: form.avatarPalette,
                shape: form.avatarShape,
                complexity: form.avatarComplexity,
              }}
              size={80}
            />
            <div>
              <h2 className="text-lg font-bold">{form.name || "Unnamed Agent"}</h2>
              {form.tagline && <p className="text-sm text-muted-foreground">{form.tagline}</p>}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 space-y-3 text-sm">
            <div>
              <span className="text-muted-foreground">Bundle:</span>{" "}
              {selectedBundle?.name ?? `#${selectedBundleId}`}
            </div>
            <div>
              <span className="text-muted-foreground">Mission:</span>{" "}
              {form.mission}
            </div>
            {form.traits.filter(Boolean).length > 0 && (
              <div>
                <span className="text-muted-foreground">Traits:</span>{" "}
                {form.traits.filter(Boolean).join(", ")}
              </div>
            )}
            {form.domains.filter(Boolean).length > 0 && (
              <div>
                <span className="text-muted-foreground">Domains:</span>{" "}
                {form.domains.filter(Boolean).join(", ")}
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Fee:</span>{" "}
              Free (token not activated)
            </div>
          </div>
          <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-sm text-yellow-400">
            Gateway integration pending — deployment will be wired in a future update.
          </div>
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex justify-between mt-8 pt-4 border-t border-border">
        <button
          onClick={goBack}
          disabled={!canGoBack}
          className={`flex items-center gap-1 px-4 py-2 rounded-lg text-sm ${
            canGoBack
              ? "text-foreground hover:bg-card"
              : "text-muted-foreground/50 cursor-not-allowed"
          }`}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        {step !== "review" ? (
          <button
            onClick={goNext}
            className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent/90"
          >
            Next
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            disabled
            className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm bg-accent/50 text-white cursor-not-allowed"
          >
            <Rocket className="h-4 w-4" />
            Deploy (Coming Soon)
          </button>
        )}
      </div>
    </div>
  );
}
