/**
 * Registration flow tests — verifies wallet generation, message signing,
 * and signature recovery match the gateway's expected behavior.
 *
 * Run: npx tsx test/registration.test.ts
 *
 * These test the crypto operations locally (no gateway needed).
 * The gateway's agents.ts uses the exact same ethers.verifyMessage() call.
 */

import { ethers } from "ethers";
import assert from "node:assert/strict";

/** Must match gateway/src/routes/agents.ts and cli/src/commands/register.ts */
const REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn())
    .then(() => {
      console.log(`  \u2713 ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  \u2717 ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    });
}

async function runTests() {
  console.log("\n  Registration Flow Tests\n");

  // ── Wallet Generation ────────────────────────────────────

  await test("Wallet.createRandom() produces a valid address", () => {
    const wallet = ethers.Wallet.createRandom();
    assert.ok(ethers.isAddress(wallet.address), "Should be a valid Ethereum address");
    assert.ok(wallet.privateKey.startsWith("0x"), "Private key should start with 0x");
    assert.equal(wallet.privateKey.length, 66, "Private key should be 66 chars (0x + 64 hex)");
  });

  await test("Wallet from private key matches the original address", () => {
    const original = ethers.Wallet.createRandom();
    const restored = new ethers.Wallet(original.privateKey);
    assert.equal(
      restored.address.toLowerCase(),
      original.address.toLowerCase(),
      "Restored wallet should have same address",
    );
  });

  // ── Message Signing ──────────────────────────────────────

  await test("signMessage produces a valid signature", async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage(REGISTRATION_MESSAGE);
    assert.ok(signature.startsWith("0x"), "Signature should start with 0x");
    assert.equal(signature.length, 132, "EIP-191 signature should be 132 chars");
  });

  await test("verifyMessage recovers the correct address", async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage(REGISTRATION_MESSAGE);
    const recovered = ethers.verifyMessage(REGISTRATION_MESSAGE, signature);
    assert.equal(
      recovered.toLowerCase(),
      wallet.address.toLowerCase(),
      "Recovered address should match signer",
    );
  });

  await test("verifyMessage rejects wrong message", async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage(REGISTRATION_MESSAGE);
    const recovered = ethers.verifyMessage("wrong message", signature);
    assert.notEqual(
      recovered.toLowerCase(),
      wallet.address.toLowerCase(),
      "Wrong message should recover a different address",
    );
  });

  await test("verifyMessage rejects signature from different wallet", async () => {
    const wallet1 = ethers.Wallet.createRandom();
    const wallet2 = ethers.Wallet.createRandom();
    const signature = await wallet2.signMessage(REGISTRATION_MESSAGE);
    const recovered = ethers.verifyMessage(REGISTRATION_MESSAGE, signature);
    assert.notEqual(
      recovered.toLowerCase(),
      wallet1.address.toLowerCase(),
      "Signature from wallet2 should not verify as wallet1",
    );
    assert.equal(
      recovered.toLowerCase(),
      wallet2.address.toLowerCase(),
      "Should recover wallet2's address",
    );
  });

  // ── Registration Payload ─────────────────────────────────

  await test("Full registration payload structure is correct", async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage(REGISTRATION_MESSAGE);

    // This is what the CLI sends to POST /v1/agents
    const payload = {
      address: wallet.address,
      signature,
      name: "Test Agent",
      description: "A test agent",
      model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      capabilities: ["research", "analysis"],
    };

    // Validate structure matches gateway expectations
    assert.ok(ethers.isAddress(payload.address), "address is valid");
    assert.ok(payload.signature.startsWith("0x"), "signature is hex");
    assert.equal(typeof payload.name, "string", "name is string");
    assert.equal(typeof payload.description, "string", "description is string");
    assert.equal(typeof payload.model.provider, "string", "model.provider is string");
    assert.ok(Array.isArray(payload.capabilities), "capabilities is array");

    // Verify the gateway would accept this signature
    const recovered = ethers.verifyMessage(REGISTRATION_MESSAGE, payload.signature);
    assert.equal(
      recovered.toLowerCase(),
      payload.address.toLowerCase(),
      "Gateway verification would pass",
    );
  });

  // ── Edge Cases ───────────────────────────────────────────

  await test("Multiple wallets produce unique addresses", () => {
    const addresses = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const wallet = ethers.Wallet.createRandom();
      addresses.add(wallet.address.toLowerCase());
    }
    assert.equal(addresses.size, 10, "All 10 wallets should have unique addresses");
  });

  await test("Private key can be loaded from string (simulating .env restore)", async () => {
    // Simulate: CLI generates wallet → saves to .env → next session loads from .env
    const original = ethers.Wallet.createRandom();
    const savedKey = original.privateKey; // This goes into .env

    // Simulate: next session reads NOOKPLOT_AGENT_PRIVATE_KEY from .env
    const restored = new ethers.Wallet(savedKey);
    assert.equal(restored.address, original.address, "Restored address matches");

    // The restored wallet can still sign correctly
    const sig = await restored.signMessage(REGISTRATION_MESSAGE);
    const recovered = ethers.verifyMessage(REGISTRATION_MESSAGE, sig);
    assert.equal(recovered, original.address, "Signature from restored wallet verifies");
  });

  await test("Empty or invalid private key throws", () => {
    assert.throws(() => new ethers.Wallet(""), "Empty key should throw");
    assert.throws(() => new ethers.Wallet("not-a-key"), "Invalid key should throw");
    assert.throws(() => new ethers.Wallet("0x1234"), "Short key should throw");
  });

  // ── Results ──────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
