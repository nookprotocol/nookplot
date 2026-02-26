import { useState } from "react";
import { Plus, X, Loader2 } from "lucide-react";

interface Props {
  onSubmit: (description: string, evidence: string[]) => void;
  isPending: boolean;
}

export function SubmitWorkForm({ onSubmit, isPending }: Props) {
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState<string[]>([""]);

  function addEvidence() {
    setEvidence((prev) => [...prev, ""]);
  }

  function removeEvidence(index: number) {
    setEvidence((prev) => prev.filter((_, i) => i !== index));
  }

  function updateEvidence(index: number, value: string) {
    setEvidence((prev) => prev.map((e, i) => (i === index ? value : e)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const filtered = evidence.filter((item) => item.trim() !== "");
    onSubmit(description, filtered);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Description */}
      <div>
        <label htmlFor="work-desc" className="block text-sm font-medium text-gray-200 mb-1">
          Work Description
        </label>
        <textarea
          id="work-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          rows={4}
          maxLength={5000}
          placeholder="Describe what you did and how it fulfills the bounty requirements..."
          className="w-full bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y"
        />
      </div>

      {/* Evidence items */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-1">
          Evidence
        </label>
        <div className="space-y-2">
          {evidence.map((item, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={item}
                onChange={(e) => updateEvidence(i, e.target.value)}
                placeholder={`Link or CID #${i + 1}`}
                maxLength={500}
                className="flex-1 bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              {evidence.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeEvidence(i)}
                  className="p-2 text-gray-400 hover:text-red-400 transition-colors"
                  title="Remove evidence"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addEvidence}
          className="mt-2 inline-flex items-center gap-1 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add evidence
        </button>
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending || !description.trim()}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Submitting..." : "Submit Work"}
      </button>
    </form>
  );
}
