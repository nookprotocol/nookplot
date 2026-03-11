import { useState } from "react";
import { X, FileText, GitBranch, Box, Database, FlaskConical, Cpu, Package } from "lucide-react";
import { useSubmitResource } from "@/hooks/useResources";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SOURCE_TYPES = [
  { value: "paper", label: "Paper", icon: FileText, placeholder: "e.g. 2301.12345 or 10.1234/example", hint: "arXiv ID or DOI" },
  { value: "github_repo", label: "GitHub", icon: GitBranch, placeholder: "e.g. anthropics/claude-code", hint: "owner/repo" },
  { value: "huggingface_model", label: "HF Model", icon: Box, placeholder: "e.g. meta-llama/Llama-3.3-70B-Instruct", hint: "owner/model" },
  { value: "huggingface_dataset", label: "HF Dataset", icon: Database, placeholder: "e.g. squad or HuggingFaceFW/fineweb", hint: "owner/dataset" },
  { value: "replicate_model", label: "Replicate", icon: FlaskConical, placeholder: "e.g. stability-ai/sdxl", hint: "owner/model" },
  { value: "ollama_model", label: "Ollama", icon: Cpu, placeholder: "e.g. llama3.3 or deepseek-r1", hint: "model name" },
  { value: "pypi_package", label: "PyPI", icon: Package, placeholder: "e.g. transformers or torch", hint: "package name" },
] as const;

export function SubmitResourceDialog({ open, onClose }: Props) {
  const [sourceType, setSourceType] = useState("paper");
  const [identifier, setIdentifier] = useState("");
  const { mutate, isPending, isSuccess, data, error, reset } = useSubmitResource();

  if (!open) return null;

  const selectedType = SOURCE_TYPES.find((t) => t.value === sourceType) ?? SOURCE_TYPES[0];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) return;
    mutate({ sourceType, identifier: identifier.trim() });
  };

  const handleClose = () => {
    setIdentifier("");
    reset();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={handleClose}>
      <div
        className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-foreground">Submit Resource</h2>
          <button onClick={handleClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {isSuccess ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-card p-4 text-center">
              {data?.status === "created" ? (
                <>
                  <p className="text-sm font-medium text-foreground">Resource submitted</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    It will be enriched automatically within a few minutes.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">Already exists</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    This resource is already in the knowledge base. No credits charged.
                  </p>
                </>
              )}
            </div>
            <button
              onClick={handleClose}
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Type selector — grid of chips */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-2">Type</label>
              <div className="grid grid-cols-4 gap-1.5">
                {SOURCE_TYPES.map((t) => {
                  const Icon = t.icon;
                  const active = sourceType === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => { setSourceType(t.value); setIdentifier(""); }}
                      className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-[10px] font-medium transition-colors ${
                        active
                          ? "border-accent bg-accent/10 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-border-hover"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Identifier input */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                {selectedType.hint}
              </label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={selectedType.placeholder}
                className="w-full bg-card border border-border text-foreground rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
            </div>

            {/* Cost note */}
            <p className="text-[10px] text-muted-foreground">
              Costs 1.00 credit. Duplicates are free.
            </p>

            {/* Error */}
            {error && (
              <p className="text-xs text-red-400">{error.message}</p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isPending || !identifier.trim()}
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending ? "Submitting..." : "Submit Resource"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
