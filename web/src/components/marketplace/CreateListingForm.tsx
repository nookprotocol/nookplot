import { useState } from "react";
import { Loader2 } from "lucide-react";
import { USDC_ADDRESS, NOOK_ADDRESS } from "@/config/constants";

interface FormData {
  title: string;
  description: string;
  category: string;
  pricingModel: number;
  price: string;
  tokenAddress: string;
  tags: string[];
}

interface Props {
  onSubmit: (data: FormData) => void;
  isPending: boolean;
  /** Dynamic category slugs from the API; falls back to core set if omitted. */
  categories?: string[];
}

const TOKEN_OPTIONS = [
  { symbol: "USDC", address: USDC_ADDRESS, decimals: 6 },
  { symbol: "NOOK", address: NOOK_ADDRESS, decimals: 18 },
] as const;

const PRICING_MODELS = [
  { label: "Per Task", value: 0 },
  { label: "Hourly", value: 1 },
  { label: "Subscription", value: 2 },
  { label: "Custom", value: 3 },
];

const CORE_CATEGORIES = ["data", "security", "coding", "research"];

export function CreateListingForm({ onSubmit, isPending, categories }: Props) {
  const selectCategories = [...(categories ?? CORE_CATEGORIES), "other"];
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("research");
  const [pricingModel, setPricingModel] = useState(0);
  const [price, setPrice] = useState("");
  const [tokenAddress, setTokenAddress] = useState(USDC_ADDRESS as string);
  const [tagInput, setTagInput] = useState("");

  const selectedToken = TOKEN_OPTIONS.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase()) ?? TOKEN_OPTIONS[0];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = tagInput
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    onSubmit({ title, description, category, pricingModel, price, tokenAddress, tags });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Title */}
      <div>
        <label htmlFor="listing-title" className="block text-sm font-medium text-gray-200 mb-1">
          Service Title
        </label>
        <input
          id="listing-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
          placeholder="What service do you offer?"
          className="w-full bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>

      {/* Description */}
      <div>
        <label htmlFor="listing-desc" className="block text-sm font-medium text-gray-200 mb-1">
          Description
        </label>
        <textarea
          id="listing-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          rows={4}
          maxLength={5000}
          placeholder="Describe your service, deliverables, and expertise..."
          className="w-full bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y"
        />
      </div>

      {/* Category */}
      <div>
        <label htmlFor="listing-category" className="block text-sm font-medium text-gray-200 mb-1">
          Category
        </label>
        <select
          id="listing-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        >
          {selectCategories.map((c) => (
            <option key={c} value={c}>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {/* Pricing Model + Price row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-200 mb-2">
            Pricing Model
          </label>
          <div className="flex gap-2 flex-wrap">
            {PRICING_MODELS.map((pm) => (
              <button
                key={pm.value}
                type="button"
                onClick={() => setPricingModel(pm.value)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  pricingModel === pm.value
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-400 border border-gray-600 hover:text-gray-200"
                }`}
              >
                {pm.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="listing-price" className="block text-sm font-medium text-gray-200 mb-1">
            Price ({selectedToken.symbol}, optional)
          </label>
          <div className="flex gap-2">
            <input
              id="listing-price"
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="flex-1 bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            <div className="flex rounded-lg border border-gray-600 overflow-hidden">
              {TOKEN_OPTIONS.map((t) => (
                <button
                  key={t.symbol}
                  type="button"
                  onClick={() => setTokenAddress(t.address)}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    tokenAddress.toLowerCase() === t.address.toLowerCase()
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {t.symbol}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tags */}
      <div>
        <label htmlFor="listing-tags" className="block text-sm font-medium text-gray-200 mb-1">
          Tags (comma-separated)
        </label>
        <input
          id="listing-tags"
          type="text"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          placeholder="solidity, smart-contracts, auditing"
          maxLength={200}
          className="w-full bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending || !title || !description || !category}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Listing..." : "List Service"}
      </button>
    </form>
  );
}
