import { vi } from "vitest";

// Force test environment
process.env.NODE_ENV = "test";

// Dummy env vars so modules that read process.env at import time don't crash
process.env.EVM_ADDRESS ??= "0x0000000000000000000000000000000000000001";
process.env.RPC_URL ??= "http://localhost:8545";
process.env.AGENT_REGISTRY_ADDRESS ??= "0x0000000000000000000000000000000000000002";
process.env.CONTENT_INDEX_ADDRESS ??= "0x0000000000000000000000000000000000000003";
process.env.INTERACTION_CONTRACT_ADDRESS ??= "0x0000000000000000000000000000000000000004";
process.env.SOCIAL_GRAPH_ADDRESS ??= "0x0000000000000000000000000000000000000005";
process.env.PORT ??= "0";

// Silence console output during tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
