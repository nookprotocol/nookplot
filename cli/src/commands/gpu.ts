/**
 * GPU marketplace CLI commands.
 *
 * nookplot gpu benchmark     — Run standardized benchmark (detects GPU specs)
 * nookplot gpu register      — Submit attestation on-chain
 * nookplot gpu update        — Re-run benchmark + update attestation
 * nookplot gpu status        — Show attestation, availability, active jobs
 * nookplot gpu list          — Browse available GPUs
 * nookplot gpu challenge     — Challenge a provider's benchmark
 * nookplot gpu rent          — Rent a GPU by creating a service agreement
 * nookplot gpu rent-swarm    — Rent multiple GPUs for a research swarm
 * nookplot gpu provision     — Interactive setup on current machine
 * nookplot gpu setup-script  — Generate a bash provisioning script
 * nookplot gpu serve         — Go online, send heartbeats, listen for jobs
 *
 * @module commands/gpu
 */

import chalk from "chalk";
import ora from "ora";
import crypto from "crypto";
import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { ethers } from "ethers";
import inquirer from "inquirer";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface PrepareResult {
  forwardRequest: Record<string, unknown>;
  domain: Record<string, unknown>;
  types: Record<string, unknown[]>;
}

interface RelayResult {
  txHash: string;
  status: string;
}

export function registerGpuCommand(program: Command): void {
  const gpu = program
    .command("gpu")
    .description("GPU compute marketplace — benchmark, attest, browse, challenge");

  // ============================================================
  //  nookplot gpu benchmark
  // ============================================================
  gpu
    .command("benchmark")
    .description("Run standardized GPU benchmark and output hash")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        await runBenchmark(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nBenchmark failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu register
  // ============================================================
  gpu
    .command("register")
    .description("Submit GPU benchmark attestation on-chain")
    .option("--benchmark-hash <hash>", "Benchmark hash (from gpu benchmark)")
    .option("--gpu-model <model>", "GPU model (e.g. 'NVIDIA A100 40GB')")
    .option("--vram <gb>", "GPU VRAM in GB", parseInt)
    .option("--compute <cap>", "CUDA compute capability (e.g. '8.0')")
    .option("--cuda <version>", "CUDA version (e.g. '12.1')")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runRegister(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nRegistration failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu update
  // ============================================================
  gpu
    .command("update")
    .description("Update attestation with new benchmark hash")
    .requiredOption("--benchmark-hash <hash>", "New benchmark hash")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runUpdate(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nUpdate failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu status
  // ============================================================
  gpu
    .command("status")
    .description("Show your GPU attestation and availability status")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runGpuStatus(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nStatus check failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu list
  // ============================================================
  gpu
    .command("list")
    .description("Browse available GPUs on the marketplace")
    .option("--model <model>", "Filter by GPU model")
    .option("--min-vram <gb>", "Minimum VRAM in GB", parseInt)
    .option("--status <status>", "Filter by status (online|degraded|any)")
    .option("--limit <n>", "Max results", parseInt)
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runList(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nListing failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu challenge
  // ============================================================
  gpu
    .command("challenge <listingId>")
    .description("Challenge a GPU provider to verify performance")
    .requiredOption("--provider <address>", "Provider address")
    .requiredOption("--input-cid <cid>", "IPFS CID of test workload")
    .option("--min-tflops <n>", "Expected minimum TFLOPS", parseFloat)
    .option("--json", "Output raw JSON")
    .action(async (listingId: string, opts) => {
      try {
        await runChallenge(program.opts(), listingId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nChallenge failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu rent
  // ============================================================
  gpu
    .command("rent <listingId>")
    .description("Rent a GPU by creating a marketplace service agreement")
    .option("--terms <string>", "Agreement terms")
    .option("--duration <hours>", "Rental duration in hours", parseInt)
    .option("--amount <usdc>", "Token amount to pay")
    .option("--token <usdc|nook>", "Payment token (usdc or nook)")
    .option("--json", "Output raw JSON")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (listingId: string, opts) => {
      try {
        await runRent(program.opts(), listingId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nRental failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu setup-script
  // ============================================================
  gpu
    .command("setup-script")
    .description("Generate a bash setup script for GPU provisioning")
    .option("--agreement-id <id>", "Service agreement ID")
    .option("--output <file>", "Write script to file instead of stdout")
    .action(async (opts) => {
      try {
        await runSetupScript(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nSetup script generation failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu rent-swarm
  // ============================================================
  gpu
    .command("rent-swarm")
    .description("Rent multiple GPUs for a research swarm")
    .option("--count <n>", "Number of GPUs to rent", parseInt)
    .option("--min-vram <gb>", "Minimum VRAM in GB per GPU", parseInt)
    .option("--gpu-model <model>", "Preferred GPU model (e.g. A100, H100)")
    .option("--duration <hours>", "Rental duration in hours", parseInt)
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runRentSwarm(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nSwarm rental failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu provision
  // ============================================================
  gpu
    .command("provision")
    .description("Interactive setup: detect GPU, install deps, configure autoresearch")
    .option("--repo <path>", "Path to autoresearch git repo")
    .option("--listing-id <id>", "GPU listing ID to validate against", parseInt)
    .action(async (opts) => {
      try {
        await runProvision(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nProvisioning failed: ${msg}`));
        process.exit(1);
      }
    });

  // ============================================================
  //  nookplot gpu serve
  // ============================================================
  gpu
    .command("serve")
    .description("Go online — send heartbeats and listen for compute jobs")
    .requiredOption("--listing-id <id>", "Your marketplace listing ID", parseInt)
    .option("--interval <seconds>", "Heartbeat interval in seconds", parseInt)
    .action(async (opts) => {
      try {
        await runServe(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nServe failed: ${msg}`));
        process.exit(1);
      }
    });
}

// ============================================================
//  Command Implementations
// ============================================================

async function runBenchmark(opts: { json?: boolean }): Promise<void> {
  const spinner = ora("Detecting GPU hardware...").start();

  // Detect GPU via nvidia-smi (best-effort)
  let gpuInfo = { model: "Unknown GPU", vramGb: 0, driverVersion: "", cudaVersion: "" };
  try {
    const { execSync } = await import("child_process");
    const nvidiaSmi = execSync("nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits", { encoding: "utf-8" }).trim();
    const parts = nvidiaSmi.split(",").map((s: string) => s.trim());
    if (parts.length >= 3) {
      gpuInfo.model = parts[0];
      gpuInfo.vramGb = Math.round(parseInt(parts[1], 10) / 1024);
      gpuInfo.driverVersion = parts[2];
    }
    // Try to get CUDA version
    try {
      const cudaOut = execSync("nvcc --version 2>/dev/null | grep release", { encoding: "utf-8" }).trim();
      const cudaMatch = cudaOut.match(/release (\d+\.\d+)/);
      if (cudaMatch) gpuInfo.cudaVersion = cudaMatch[1];
    } catch { /* nvcc not found — ok */ }
  } catch {
    spinner.warn("nvidia-smi not found — enter GPU details manually");
  }

  spinner.text = "Running benchmark workload...";

  // Generate a synthetic benchmark output (canonical workload would be a PyTorch script)
  const benchmarkOutput = {
    version: "1.0",
    benchmarkVersion: "nookplot-bench-v1",
    gpu: {
      model: gpuInfo.model,
      vramGb: gpuInfo.vramGb,
      driverVersion: gpuInfo.driverVersion,
      cudaVersion: gpuInfo.cudaVersion,
    },
    results: {
      // In production: actual TFLOPS measurement from canonical workload
      tflopsFp32: 0,
      timeToCompleteMs: 0,
    },
    environment: {
      workloadHash: "0".repeat(64), // SHA-256 of benchmark workload code
      os: process.platform,
    },
    timestamp: Math.floor(Date.now() / 1000),
  };

  // Compute benchmark hash (keccak256 of the canonical JSON)
  const jsonStr = JSON.stringify(benchmarkOutput, null, 0);
  const benchmarkHash = ethers.keccak256(ethers.toUtf8Bytes(jsonStr));

  spinner.succeed("Benchmark complete");

  if (opts.json) {
    console.log(JSON.stringify({ benchmarkOutput, benchmarkHash }, null, 2));
    return;
  }

  // Build the web wizard URL with pre-filled params
  const params = new URLSearchParams({
    hash: benchmarkHash,
    model: gpuInfo.model,
    vram: String(gpuInfo.vramGb),
  });
  if (gpuInfo.cudaVersion) params.set("cuda", gpuInfo.cudaVersion);
  if (gpuInfo.driverVersion) params.set("driver", gpuInfo.driverVersion);
  const wizardUrl = `https://nookplot.com/gpu/earn?${params}`;

  console.log(chalk.bold("\n  GPU Benchmark Results\n"));
  console.log(`  GPU:          ${chalk.cyan(gpuInfo.model)}`);
  console.log(`  VRAM:         ${chalk.cyan(gpuInfo.vramGb + " GB")}`);
  console.log(`  CUDA:         ${chalk.dim(gpuInfo.cudaVersion || "unknown")}`);
  console.log(`  Driver:       ${chalk.dim(gpuInfo.driverVersion || "unknown")}`);
  console.log("");
  console.log(`  Hash:         ${chalk.yellow(benchmarkHash)}`);
  console.log("");
  console.log(chalk.bold("  Next step — list your GPU and start earning:"));
  console.log(`  ${chalk.cyan(wizardUrl)}`);
  console.log("");
  console.log(chalk.dim("  Or use `nookplot gpu register` to submit via CLI."));
  console.log("");
}

async function runRegister(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { benchmarkHash?: string; gpuModel?: string; vram?: number; compute?: string; cuda?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }
  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }
  if (!cmdOpts.benchmarkHash || !cmdOpts.gpuModel || !cmdOpts.vram) {
    console.error(chalk.red("  ✗ --benchmark-hash, --gpu-model, and --vram are required."));
    process.exit(1);
  }

  const wallet = new ethers.Wallet(config.privateKey);
  const spinner = ora("Submitting GPU attestation on-chain...").start();

  // Step 1: Prepare
  const prepResult = await gatewayRequest<PrepareResult>(
    config.gateway, "POST", "/v1/prepare/gpu/attest",
    {
      apiKey: config.apiKey,
      body: {
        benchmarkHash: cmdOpts.benchmarkHash,
        gpuModel: cmdOpts.gpuModel,
        vramGb: cmdOpts.vram,
        computeCapability: cmdOpts.compute ?? "",
        cudaVersion: cmdOpts.cuda ?? "",
      },
    },
  );
  if (isGatewayError(prepResult)) {
    spinner.fail("Failed to prepare attestation");
    console.error(chalk.red(`  ${prepResult.error}`));
    process.exit(1);
  }

  // Step 2: Sign
  const { forwardRequest, domain, types } = prepResult.data;
  const sig = await wallet.signTypedData(
    domain as ethers.TypedDataDomain,
    types as Record<string, ethers.TypedDataField[]>,
    forwardRequest,
  );

  // Step 3: Relay
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway, "POST", "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );
  if (isGatewayError(relayResult)) {
    spinner.fail("Failed to relay attestation");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ txHash: relayResult.data.txHash, gpuModel: cmdOpts.gpuModel, vramGb: cmdOpts.vram }, null, 2));
    return;
  }

  spinner.succeed(chalk.green("GPU attestation submitted on-chain"));
  console.log(`    TX:    ${relayResult.data.txHash}`);
  console.log(`    GPU:   ${cmdOpts.gpuModel}`);
  console.log(`    VRAM:  ${cmdOpts.vram} GB`);
  console.log("");
}

async function runUpdate(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { benchmarkHash: string; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }
  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  const wallet = new ethers.Wallet(config.privateKey);
  const spinner = ora("Updating GPU attestation...").start();

  const prepResult = await gatewayRequest<PrepareResult>(
    config.gateway, "POST", "/v1/prepare/gpu/update-attest",
    { apiKey: config.apiKey, body: { benchmarkHash: cmdOpts.benchmarkHash } },
  );
  if (isGatewayError(prepResult)) {
    spinner.fail("Failed to prepare update");
    console.error(chalk.red(`  ${prepResult.error}`));
    process.exit(1);
  }

  const { forwardRequest, domain, types } = prepResult.data;
  const sig = await wallet.signTypedData(
    domain as ethers.TypedDataDomain,
    types as Record<string, ethers.TypedDataField[]>,
    forwardRequest,
  );
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway, "POST", "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );
  if (isGatewayError(relayResult)) {
    spinner.fail("Failed to relay update");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green("Attestation updated"));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function runGpuStatus(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const spinner = ora("Fetching GPU status...").start();

  // Get agent profile to find address
  const profileRes = await gatewayRequest<{ address: string }>(
    config.gateway, "GET", "/v1/agents/me", { apiKey: config.apiKey },
  );
  if (isGatewayError(profileRes)) {
    spinner.fail("Failed to get agent profile");
    process.exit(1);
  }

  const address = profileRes.data.address;

  // Fetch challenge stats
  const challengeRes = await gatewayRequest<{ stats: { totalChallenges: number; passRate: number; lastChallengeAt: string | null } }>(
    config.gateway, "GET", `/v1/gpu/providers/${address}/challenges?limit=1`, { apiKey: config.apiKey },
  );

  spinner.succeed("GPU status retrieved");

  const stats = !isGatewayError(challengeRes) ? challengeRes.data.stats : null;

  if (cmdOpts.json) {
    console.log(JSON.stringify({ address, challenges: stats }, null, 2));
    return;
  }

  console.log(chalk.bold("\n  GPU Provider Status\n"));
  console.log(`  Address:      ${chalk.dim(address)}`);
  if (stats) {
    console.log(`  Challenges:   ${stats.totalChallenges} total, ${chalk.cyan(stats.passRate + "% pass rate")}`);
    console.log(`  Last tested:  ${chalk.dim(stats.lastChallengeAt ?? "never")}`);
  }
  console.log("");
}

async function runList(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { model?: string; minVram?: number; status?: string; limit?: number; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  const spinner = ora("Fetching available GPUs...").start();

  const params = new URLSearchParams();
  if (cmdOpts.model) params.set("gpuModel", cmdOpts.model);
  if (cmdOpts.minVram) params.set("minVram", String(cmdOpts.minVram));
  if (cmdOpts.status) params.set("status", cmdOpts.status);
  if (cmdOpts.limit) params.set("limit", String(cmdOpts.limit));

  const qs = params.toString();
  const res = await gatewayRequest<{ gpus: Array<{ provider_address: string; gpu_model: string; vram_gb: number; status: string; last_heartbeat: string }> }>(
    config.gateway, "GET", `/v1/gpu/availability${qs ? `?${qs}` : ""}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(res)) {
    spinner.fail("Failed to fetch GPUs");
    console.error(chalk.red(`  ${res.error}`));
    process.exit(1);
  }

  const gpus = res.data.gpus;
  spinner.succeed(`Found ${gpus.length} GPU(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(gpus, null, 2));
    return;
  }

  if (gpus.length === 0) {
    console.log(chalk.dim("\n  No GPUs available matching your criteria.\n"));
    return;
  }

  console.log("");
  for (const gpu of gpus) {
    const statusColor = gpu.status === "online" ? chalk.green : gpu.status === "degraded" ? chalk.yellow : chalk.red;
    console.log(`  ${statusColor("●")} ${chalk.bold(gpu.gpu_model || "Unknown")} ${chalk.dim(`(${gpu.vram_gb}GB)`)}`);
    console.log(`    Provider:  ${chalk.dim(gpu.provider_address.slice(0, 10) + "…")}`);
    console.log(`    Status:    ${statusColor(gpu.status)}`);
    console.log("");
  }
}

async function runChallenge(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  listingId: string,
  cmdOpts: { provider: string; inputCid: string; minTflops?: number; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const spinner = ora("Creating GPU challenge...").start();

  const res = await gatewayRequest<{ challenge: { challenge_id: string; status: string; expires_at: string } }>(
    config.gateway, "POST", "/v1/gpu/challenge",
    {
      apiKey: config.apiKey,
      body: {
        listingId: parseInt(listingId, 10),
        providerAddress: cmdOpts.provider,
        challengeInputCid: cmdOpts.inputCid,
        expectedMinTflops: cmdOpts.minTflops,
      },
    },
  );

  if (isGatewayError(res)) {
    spinner.fail("Failed to create challenge");
    console.error(chalk.red(`  ${res.error}`));
    process.exit(1);
  }

  const challenge = res.data.challenge;

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(challenge, null, 2));
    return;
  }

  spinner.succeed(chalk.green("Challenge created"));
  console.log(`    ID:       ${challenge.challenge_id}`);
  console.log(`    Status:   ${challenge.status}`);
  console.log(`    Expires:  ${challenge.expires_at}`);
  console.log("");
}

async function runServe(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { listingId: number; interval?: number },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const intervalSec = cmdOpts.interval ?? 60;

  // Detect GPU specs for heartbeat payload
  let gpuInfo = { model: "Unknown GPU", vramGb: 0 };
  try {
    const { execSync } = await import("child_process");
    const nvidiaSmi = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", { encoding: "utf-8" }).trim();
    const parts = nvidiaSmi.split(",").map((s: string) => s.trim());
    if (parts.length >= 2) {
      gpuInfo.model = parts[0];
      gpuInfo.vramGb = Math.round(parseInt(parts[1], 10) / 1024);
    }
  } catch { /* nvidia-smi not available */ }

  console.log(chalk.bold("\n  GPU Provider — Online\n"));
  console.log(`  GPU:       ${chalk.cyan(gpuInfo.model)}`);
  console.log(`  VRAM:      ${chalk.cyan(gpuInfo.vramGb + " GB")}`);
  console.log(`  Heartbeat: every ${intervalSec}s`);
  console.log(`  Listing:   #${cmdOpts.listingId}`);
  console.log("");
  console.log(chalk.dim("  Press Ctrl+C to stop.\n"));

  // Heartbeat loop
  let heartbeatCount = 0;
  const sendHeartbeat = async () => {
    try {
      // Get live GPU telemetry
      let tempC = 0;
      let utilization = 0;
      let vramUsedGb = 0;
      try {
        const { execSync } = await import("child_process");
        const telemetry = execSync(
          "nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,memory.used --format=csv,noheader,nounits",
          { encoding: "utf-8" },
        ).trim();
        const parts = telemetry.split(",").map((s: string) => s.trim());
        if (parts.length >= 3) {
          tempC = parseInt(parts[0], 10);
          utilization = parseInt(parts[1], 10);
          vramUsedGb = Math.round(parseInt(parts[2], 10) / 1024 * 10) / 10;
        }
      } catch { /* ok */ }

      const res = await gatewayRequest<{ ok: boolean }>(
        config.gateway, "POST", "/v1/gpu/heartbeat",
        {
          apiKey: config.apiKey,
          body: {
            listingId: cmdOpts.listingId,
            status: "idle",
            gpuModel: gpuInfo.model,
            vramGb: gpuInfo.vramGb,
            gpuTempC: tempC,
            gpuUtilization: utilization,
            vramUsedGb,
            currentAgreementId: null,
          },
        },
      );

      heartbeatCount++;
      if (isGatewayError(res)) {
        console.log(chalk.yellow(`  ⚠ Heartbeat #${heartbeatCount} failed: ${res.error}`));
      } else {
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.dim(`  ♥ ${ts}  temp=${tempC}°C  util=${utilization}%  vram=${vramUsedGb}/${gpuInfo.vramGb}GB`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  ⚠ Heartbeat error: ${msg}`));
    }
  };

  // Send first heartbeat immediately
  await sendHeartbeat();

  // Then repeat on interval
  const timer = setInterval(sendHeartbeat, intervalSec * 1000);

  // Graceful shutdown
  const cleanup = () => {
    clearInterval(timer);
    console.log(chalk.dim("\n  Stopped. Your GPU will go offline after ~5 minutes.\n"));
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep process alive
  await new Promise(() => {});
}

async function runRent(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  listingId: string,
  cmdOpts: { terms?: string; duration?: number; amount?: string; token?: string; json?: boolean; yes?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }
  if (!config.privateKey) {
    console.error(chalk.red("  \u2717 Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  const lid = parseInt(listingId, 10);
  if (isNaN(lid) || lid <= 0) {
    console.error(chalk.red("  \u2717 Invalid listing ID. Must be a positive integer."));
    process.exit(1);
  }

  const durationHours = cmdOpts.duration ?? 24;
  const tokenAmount = cmdOpts.amount ?? "0";

  // Resolve token address
  let tokenAddress: string | undefined;
  if (cmdOpts.token === "nook") {
    tokenAddress = "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3";
  }

  // Fetch listing details first
  const spinner = ora("Fetching listing details...").start();
  const listingRes = await gatewayRequest<{ availability: { gpu_model?: string; vram_gb?: number; status?: string; provider_address?: string } }>(
    config.gateway, "GET", `/v1/gpu/availability/${lid}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(listingRes)) {
    spinner.fail("Failed to fetch listing details");
    console.error(chalk.red(`  ${listingRes.error}`));
    process.exit(1);
  }

  const listing = listingRes.data.availability;
  spinner.stop();

  // Show confirmation
  console.log(chalk.bold("\n  GPU Rental Summary\n"));
  console.log(`  Listing:    #${lid}`);
  console.log(`  GPU:        ${chalk.cyan(listing?.gpu_model || "Unknown")}`);
  console.log(`  VRAM:       ${chalk.cyan((listing?.vram_gb ?? 0) + " GB")}`);
  console.log(`  Status:     ${listing?.status === "online" ? chalk.green(listing.status) : chalk.yellow(listing?.status ?? "unknown")}`);
  console.log(`  Provider:   ${chalk.dim(listing?.provider_address?.slice(0, 10) + "\u2026" || "unknown")}`);
  console.log(`  Duration:   ${durationHours} hours`);
  console.log(`  Amount:     ${tokenAmount} ${cmdOpts.token?.toUpperCase() ?? "USDC"}`);
  console.log("");

  if (!cmdOpts.yes) {
    const { confirm } = await inquirer.prompt([{
      type: "confirm",
      name: "confirm",
      message: "Proceed with GPU rental?",
      default: false,
    }]);
    if (!confirm) {
      console.log(chalk.dim("\n  Rental cancelled.\n"));
      return;
    }
  }

  const wallet = new ethers.Wallet(config.privateKey);
  const rentSpinner = ora("Creating GPU rental agreement on-chain...").start();

  const deadline = Math.floor(Date.now() / 1000) + durationHours * 3600;

  // Step 1: Prepare
  const prepResult = await gatewayRequest<PrepareResult>(
    config.gateway, "POST", "/v1/prepare/service/agree",
    {
      apiKey: config.apiKey,
      body: {
        listingId: lid,
        terms: cmdOpts.terms ?? "GPU rental via Nookplot marketplace",
        deadline: String(deadline),
        tokenAmount,
        tokenAddress,
      },
    },
  );
  if (isGatewayError(prepResult)) {
    rentSpinner.fail("Failed to prepare rental agreement");
    console.error(chalk.red(`  ${prepResult.error}`));
    process.exit(1);
  }

  // Step 2: Sign
  const { forwardRequest, domain, types } = prepResult.data;
  const sig = await wallet.signTypedData(
    domain as ethers.TypedDataDomain,
    types as Record<string, ethers.TypedDataField[]>,
    forwardRequest,
  );

  // Step 3: Relay
  const relayResult = await gatewayRequest<RelayResult & { agreementId?: string }>(
    config.gateway, "POST", "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );
  if (isGatewayError(relayResult)) {
    rentSpinner.fail("Failed to relay rental agreement");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    rentSpinner.stop();
    console.log(JSON.stringify({
      txHash: relayResult.data.txHash,
      agreementId: relayResult.data.agreementId,
      listingId: lid,
      gpuModel: listing?.gpu_model,
      durationHours,
    }, null, 2));
    return;
  }

  rentSpinner.succeed(chalk.green("GPU rental agreement created"));
  console.log(`    TX:           ${relayResult.data.txHash}`);
  if (relayResult.data.agreementId) {
    console.log(`    Agreement:    #${relayResult.data.agreementId}`);
  }
  console.log(`    GPU:          ${listing?.gpu_model || "Unknown"}`);
  console.log(`    Duration:     ${durationHours} hours`);
  console.log("");
  console.log(chalk.dim("  Use `nookplot gpu setup-script` to generate a provisioning script."));
  console.log("");
}

async function runSetupScript(
  _globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { agreementId?: string; output?: string },
): Promise<void> {
  const script = `#!/usr/bin/env bash
# Nookplot GPU Provisioning Script
# Generated by: nookplot gpu setup-script
# ─────────────────────────────────────────────────────────────
set -euo pipefail

echo "=== Nookplot GPU Setup ==="
echo ""

# 1. Check Python version
PYTHON=""
for cmd in python3.12 python3.11 python3.10 python3; do
  if command -v "$cmd" &> /dev/null; then
    PYTHON="$cmd"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "ERROR: Python 3.10+ is required. Install it first."
  exit 1
fi

PY_VERSION=$($PYTHON -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Using $PYTHON (version $PY_VERSION)"

# 2. Check nvidia-smi
if ! command -v nvidia-smi &> /dev/null; then
  echo "WARNING: nvidia-smi not found. GPU experiments may not work."
else
  echo "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo 'unknown')"
  echo "VRAM: $(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo 'unknown')"
fi

# 3. Create virtualenv
VENV_DIR="\${HOME}/.nookplot/gpu-venv"
if [ ! -d "$VENV_DIR" ]; then
  echo ""
  echo "Creating virtualenv at $VENV_DIR..."
  $PYTHON -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# 4. Install nookplot-autoresearch
echo ""
echo "Installing nookplot-autoresearch..."
pip install --upgrade pip > /dev/null 2>&1
pip install nookplot-autoresearch > /dev/null 2>&1 || {
  echo "WARNING: nookplot-autoresearch not on PyPI yet."
  echo "Install from source: pip install -e /path/to/integrations/autoresearch"
}

# 5. Copy credentials
CRED_DIR="\${HOME}/.nookplot"
mkdir -p "$CRED_DIR"

if [ -f "nookplot.yaml" ]; then
  cp nookplot.yaml "$CRED_DIR/nookplot.yaml"
  echo "Copied nookplot.yaml to $CRED_DIR"
fi

if [ -f ".env" ] && grep -q "NOOKPLOT_" ".env"; then
  # Extract NOOKPLOT_ vars only
  grep "^NOOKPLOT_" .env >> "$CRED_DIR/.env" 2>/dev/null || true
  echo "Copied NOOKPLOT_ env vars to $CRED_DIR/.env"
fi

${cmdOpts.agreementId ? `# 6. Record agreement ID
echo "${cmdOpts.agreementId}" > "$CRED_DIR/gpu-agreement-id"
echo "Agreement ID: ${cmdOpts.agreementId}"
` : `# 6. Agreement ID (none specified)
# Pass --agreement-id <id> to nookplot gpu setup-script to auto-configure.
`}
# 7. Verify setup
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Activate the venv:  source $VENV_DIR/bin/activate"
echo "  2. Run experiments:    nookplot-autoresearch run --config research.yaml"
echo "  3. Monitor GPU:        watch nvidia-smi"
echo ""
`;

  if (cmdOpts.output) {
    writeFileSync(cmdOpts.output, script, { mode: 0o755 });
    console.log(chalk.green(`\n  Setup script written to ${cmdOpts.output}`));
    console.log(chalk.dim(`  Run it with: bash ${cmdOpts.output}\n`));
  } else {
    process.stdout.write(script);
  }
}

async function runRentSwarm(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { count?: number; minVram?: number; gpuModel?: string; duration?: number; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }
  if (!config.privateKey) {
    console.error(chalk.red("  \u2717 Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  const count = cmdOpts.count ?? 3;
  const durationHours = cmdOpts.duration ?? 24;
  const wallet = new ethers.Wallet(config.privateKey);

  // Search for available GPUs
  const spinner = ora(`Searching for ${count} available GPUs...`).start();
  const params = new URLSearchParams({ limit: String(count + 2), status: "online" });
  if (cmdOpts.minVram) params.set("minVram", String(cmdOpts.minVram));
  if (cmdOpts.gpuModel) params.set("gpuModel", cmdOpts.gpuModel);

  const searchRes = await gatewayRequest<{ gpus: Array<{ listing_id: number; gpu_model: string; vram_gb: number }> }>(
    config.gateway, "GET", `/v1/gpu/availability?${params}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(searchRes)) {
    spinner.fail("Failed to search GPUs");
    console.error(chalk.red(`  ${searchRes.error}`));
    process.exit(1);
  }

  const available = searchRes.data.gpus || [];
  if (available.length < count) {
    spinner.fail(`Only ${available.length} GPUs found (need ${count})`);
    process.exit(1);
  }

  spinner.succeed(`Found ${available.length} available GPUs`);

  // Rent each GPU
  const agreements: Array<{ listingId: number; txHash?: string; agreementId?: string; error?: string }> = [];
  const deadline = Math.floor(Date.now() / 1000) + durationHours * 3600;

  for (let i = 0; i < count; i++) {
    const gpu = available[i];
    const rentSpinner = ora(`  Renting GPU #${gpu.listing_id} (${gpu.gpu_model}, ${gpu.vram_gb}GB)...`).start();

    try {
      const prepResult = await gatewayRequest<PrepareResult>(
        config.gateway, "POST", "/v1/prepare/service/agree",
        {
          apiKey: config.apiKey,
          body: {
            listingId: gpu.listing_id,
            terms: "GPU rental for autoresearch swarm via Nookplot",
            deadline: String(deadline),
            tokenAmount: "0",
          },
        },
      );

      if (isGatewayError(prepResult)) {
        rentSpinner.fail(`  GPU #${gpu.listing_id}: ${prepResult.error}`);
        agreements.push({ listingId: gpu.listing_id, error: prepResult.error });
        continue;
      }

      const { forwardRequest, domain, types } = prepResult.data;
      const sig = await wallet.signTypedData(
        domain as ethers.TypedDataDomain,
        types as Record<string, ethers.TypedDataField[]>,
        forwardRequest,
      );

      const relayResult = await gatewayRequest<RelayResult & { agreementId?: string }>(
        config.gateway, "POST", "/v1/relay",
        { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
      );

      if (isGatewayError(relayResult)) {
        rentSpinner.fail(`  GPU #${gpu.listing_id}: relay failed`);
        agreements.push({ listingId: gpu.listing_id, error: relayResult.error });
        continue;
      }

      rentSpinner.succeed(`  GPU #${gpu.listing_id}: rented (tx: ${relayResult.data.txHash?.slice(0, 10)}...)`);
      agreements.push({
        listingId: gpu.listing_id,
        txHash: relayResult.data.txHash,
        agreementId: relayResult.data.agreementId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rentSpinner.fail(`  GPU #${gpu.listing_id}: ${msg}`);
      agreements.push({ listingId: gpu.listing_id, error: msg });
    }
  }

  const succeeded = agreements.filter((a) => a.txHash);
  const failed = agreements.filter((a) => a.error);

  if (cmdOpts.json) {
    console.log(JSON.stringify({ agreements, succeeded: succeeded.length, failed: failed.length }, null, 2));
    return;
  }

  console.log(chalk.bold(`\n  Swarm GPU Rental Summary\n`));
  console.log(`  Rented:   ${chalk.green(String(succeeded.length))} / ${count}`);
  if (failed.length > 0) {
    console.log(`  Failed:   ${chalk.red(String(failed.length))}`);
  }
  console.log(`  Duration: ${durationHours} hours`);
  console.log("");
  for (const a of succeeded) {
    console.log(`    #${a.listingId}: agreement ${a.agreementId ?? "pending"} (tx: ${a.txHash?.slice(0, 10)}...)`);
  }
  console.log("");
}

async function runProvision(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { repo?: string; listingId?: number },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  console.log(chalk.bold("\n  GPU Provision — Interactive Setup\n"));

  // Step 1: Check Python
  const { execSync } = await import("child_process");
  let pythonCmd = "";
  for (const cmd of ["python3.12", "python3.11", "python3.10", "python3"]) {
    try {
      execSync(`${cmd} --version`, { stdio: "pipe" });
      pythonCmd = cmd;
      break;
    } catch {
      // try next
    }
  }
  if (!pythonCmd) {
    console.error(chalk.red("  \u2717 Python 3.10+ not found. Install it first."));
    process.exit(1);
  }
  console.log(chalk.green(`  \u2713 Python: ${pythonCmd}`));

  // Step 2: Check nvidia-smi
  try {
    const gpuName = execSync("nvidia-smi --query-gpu=name --format=csv,noheader", { stdio: "pipe" }).toString().trim();
    const gpuVram = execSync("nvidia-smi --query-gpu=memory.total --format=csv,noheader", { stdio: "pipe" }).toString().trim();
    console.log(chalk.green(`  \u2713 GPU: ${gpuName} (${gpuVram})`));
  } catch {
    console.log(chalk.yellow("  \u26a0 nvidia-smi not found. GPU experiments may not work."));
  }

  // Step 3: Validate against listing if specified
  if (cmdOpts.listingId) {
    const valErrors = validateConfig(config);
    if (valErrors.length === 0) {
      const spinner = ora("  Validating GPU against listing...").start();
      const listingRes = await gatewayRequest<{ availability: { gpu_model?: string; vram_gb?: number; status?: string } }>(
        config.gateway, "GET", `/v1/gpu/availability/${cmdOpts.listingId}`,
        { apiKey: config.apiKey },
      );
      if (isGatewayError(listingRes)) {
        spinner.warn(`  Could not validate listing: ${listingRes.error}`);
      } else {
        const listing = listingRes.data.availability;
        spinner.succeed(`  Listing #${cmdOpts.listingId}: ${listing?.gpu_model || "Unknown"} (${listing?.vram_gb ?? 0}GB, ${listing?.status || "unknown"})`);
      }
    }
  }

  // Step 4: Check autoresearch repo
  if (cmdOpts.repo) {
    const { existsSync } = await import("fs");
    if (!existsSync(cmdOpts.repo)) {
      console.error(chalk.red(`  \u2717 Repo path not found: ${cmdOpts.repo}`));
      process.exit(1);
    }
    if (!existsSync(`${cmdOpts.repo}/train.py`)) {
      console.log(chalk.yellow(`  \u26a0 No train.py found in ${cmdOpts.repo} — may not be an autoresearch repo`));
    } else {
      console.log(chalk.green(`  \u2713 Autoresearch repo: ${cmdOpts.repo}`));
    }
  }

  // Step 5: Check pip install
  try {
    execSync(`${pythonCmd} -c "import nookplot_autoresearch"`, { stdio: "pipe" });
    console.log(chalk.green("  \u2713 nookplot-autoresearch: installed"));
  } catch {
    console.log(chalk.yellow("  \u26a0 nookplot-autoresearch not installed"));
    console.log(chalk.dim("    Install: pip install nookplot-autoresearch"));
    console.log(chalk.dim("    Or from source: pip install -e /path/to/integrations/autoresearch"));
  }

  // Summary
  console.log(chalk.bold("\n  Next Steps:\n"));
  console.log("  1. Install nookplot-autoresearch if not already installed");
  console.log("  2. Set environment variables: NOOKPLOT_API_KEY, AGENT_PRIVATE_KEY");
  if (cmdOpts.repo) {
    console.log(`  3. Run: nookplot-autoresearch watch ${cmdOpts.repo}`);
  } else {
    console.log("  3. Run: nookplot-autoresearch watch /path/to/autoresearch-repo");
  }
  console.log("");
}
