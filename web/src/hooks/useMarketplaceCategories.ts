import { useMemo } from "react";
import { useGatewayQuery } from "./useGatewayQuery";

/** Shape returned by GET /v1/marketplace/categories */
interface CategoriesResponse {
  categories: Array<{ category: string; count: number }>;
}

export interface CategoryTab {
  label: string;
  value: string;
  count?: number;
}

/** Core categories that always appear (in this order), even with 0 listings. */
const CORE_CATEGORIES = ["data", "security", "coding", "research"];

/** Maximum visible tabs before overflow goes into a "More" dropdown. */
const MAX_VISIBLE_TABS = 10;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Fetches marketplace category counts from the gateway and merges them with
 * the core set.  Returns visible tabs, overflow tabs, and a flat list of all
 * category slugs (for the create-listing form).
 */
export function useMarketplaceCategories() {
  const { data, isLoading } = useGatewayQuery<CategoriesResponse>(
    ["marketplace-categories"],
    "/v1/marketplace/categories",
    { staleTime: 60_000 },
  );

  const { visibleTabs, overflowTabs, allCategories } = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const item of data?.categories ?? []) {
      countMap.set(item.category.toLowerCase(), item.count);
    }

    // "All" is always first
    const allTab: CategoryTab = { label: "All", value: "" };

    // Core tabs in fixed order
    const coreTabs: CategoryTab[] = CORE_CATEGORIES.map((slug) => ({
      label: capitalize(slug),
      value: slug,
      count: countMap.get(slug) ?? 0,
    }));

    const coreSet = new Set(CORE_CATEGORIES);

    // Dynamic tabs: everything from API not in core, with count > 0, sorted desc
    const dynamicTabs: CategoryTab[] = (data?.categories ?? [])
      .filter((c) => !coreSet.has(c.category.toLowerCase()) && c.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((c) => ({
        label: capitalize(c.category),
        value: c.category.toLowerCase(),
        count: c.count,
      }));

    const combined = [allTab, ...coreTabs, ...dynamicTabs];

    // Split at MAX_VISIBLE_TABS (the "All" tab counts toward the limit)
    const visible = combined.slice(0, MAX_VISIBLE_TABS);
    const overflow = combined.slice(MAX_VISIBLE_TABS);

    // Flat slug list for create-listing form (excludes "All")
    const slugs = [...CORE_CATEGORIES, ...dynamicTabs.map((t) => t.value)];

    return { visibleTabs: visible, overflowTabs: overflow, allCategories: slugs };
  }, [data]);

  return { visibleTabs, overflowTabs, allCategories, isLoading };
}
