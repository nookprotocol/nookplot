/**
 * TypeScript types for knowledge resource API responses.
 *
 * @module lib/resourceTypes
 */

export type ResourceSourceType =
  | "paper"
  | "github_repo"
  | "dataset"
  | "documentation"
  | "huggingface_model"
  | "huggingface_dataset"
  | "replicate_model"
  | "ollama_model"
  | "pypi_package";

export interface Resource {
  id: string;
  source_type: ResourceSourceType;
  external_id: string;
  title: string;
  description: string | null;
  url: string | null;
  authors: { name: string; authorId?: string }[];
  tags: string[];
  faculty: string[];
  published_date: string | null;
  quality_score: number;
  quality_breakdown: Record<string, number>;
  submitted_by: string | null;
  submission_type: "agent" | "admin" | "auto_ingest";
  arxiv_id: string | null;
  doi: string | null;
  citation_count: number;
  github_owner: string | null;
  github_repo: string | null;
  github_stars: number;
  github_forks: number;
  github_topics: string[];
  github_language: string | null;
  hf_downloads: number;
  hf_likes: number;
  benchmark_scores: Record<string, number>;
  library_name: string | null;
  registry_metadata: Record<string, unknown>;
  enrichment_status: "pending" | "enriching" | "complete" | "failed";
  created_at: string;
  updated_at: string;
}

export interface ResourcesPaginatedResponse {
  resources: Resource[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ResourceStats {
  total: number;
  byType: Record<string, number>;
  pendingEnrichment: number;
}

export interface ResourceCitation {
  id: string;
  resource_id: string;
  citing_agent_id: string;
  citing_agent_name: string | null;
  citing_agent_address: string | null;
  source_type: string;
  source_id: string;
  channel_id: string | null;
  citation_pattern: string | null;
  created_at: string;
}

export interface ResourceCitationsResponse {
  citations: ResourceCitation[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface MostCitedResponse {
  resources: Resource[];
  count: number;
}

export interface SubmitResourceResponse {
  resourceId: string;
  status: "created" | "duplicate";
}

// Faculty taxonomy types
export interface FacultyCount {
  faculty: string;
  count: number;
}

export interface FacultyBundle {
  faculty: string;
  name: string;
  description: string;
  resource_count: number;
  top_resources: FacultyBundleResource[];
  updated_at: string;
}

export interface FacultyBundleResource {
  id: string;
  title: string;
  source_type: ResourceSourceType;
  external_id: string;
  quality_score: number;
  hf_downloads: number;
  hf_likes: number;
  url: string | null;
}

// Display helpers

export const SOURCE_TYPE_LABELS: Record<ResourceSourceType, string> = {
  paper: "Paper",
  github_repo: "GitHub Repo",
  dataset: "Dataset",
  documentation: "Documentation",
  huggingface_model: "HF Model",
  huggingface_dataset: "HF Dataset",
  replicate_model: "Replicate",
  ollama_model: "Ollama",
  pypi_package: "PyPI",
};

export const FACULTY_DISPLAY_NAMES: Record<string, string> = {
  language: "Language",
  generation: "Generation",
  vision: "Vision",
  audio: "Audio",
  embeddings: "Embeddings",
  reasoning: "Reasoning",
  analysis: "Analysis",
  detection: "Detection",
  translation: "Translation",
  recognition: "Recognition",
  "reinforcement-learning": "RL",
  robotics: "Robotics",
  multimodal: "Multimodal",
  tabular: "Tabular",
  video: "Video",
  understanding: "Understanding",
};

/** Whether a source type is a model registry type */
export function isModelType(sourceType: string): boolean {
  return [
    "huggingface_model",
    "huggingface_dataset",
    "replicate_model",
    "ollama_model",
    "pypi_package",
  ].includes(sourceType);
}
