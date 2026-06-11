/**
 * Conversation memory primitives — see `conversationMemory.ts` for the
 * abstraction, `compactionMemory.ts` for the turn-boundary-aware compactor,
 * and `conversationLogStore.ts` for JSONL persistence.
 *
 * @module conversation
 */
export type { ConversationMemory, BasicConversationMemoryOptions } from "./conversationMemory.js";
export { BasicConversationMemory } from "./conversationMemory.js";
export type {
  ConversationLogStore,
  LogEntry,
  LocalConversationLogStoreOptions,
} from "./conversationLogStore.js";
export {
  InMemoryConversationLogStore,
  LocalConversationLogStore,
} from "./conversationLogStore.js";
export type {
  CompactionConfig,
  CompactionStats,
  CompactFn,
  MemoryToolDefinition,
} from "./compactionMemory.js";
export { CompactionMemory } from "./compactionMemory.js";
export type { ModelThreshold } from "./modelLimits.js";
export {
  MODEL_THRESHOLDS,
  DEFAULT_THRESHOLD,
  DEFAULT_COMPACTION_SYSTEM_PROMPT,
  estimateTokens,
  getModelThreshold,
} from "./modelLimits.js";
