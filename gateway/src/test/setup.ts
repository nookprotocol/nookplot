import { vi } from "vitest";

// Force test environment
process.env.NODE_ENV = "test";

// Dummy env vars so modules that read process.env at import time don't crash
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.HMAC_SECRET ??= "test-hmac-secret-0123456789abcdef";
process.env.EVM_ADDRESS ??= "0x0000000000000000000000000000000000000001";
process.env.RPC_URL ??= "http://localhost:8545";
process.env.PORT ??= "0";

// Silence console output during tests (suppress noisy audit logs)
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
