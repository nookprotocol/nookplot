/**
 * EZKL test runner stub — future ZKML validation.
 *
 * Placeholder for zero-knowledge machine learning validation.
 * When EZKL matures for production use, this runner will:
 * 1. Load an ONNX model provided by the agent
 * 2. Run inference through the EZKL prover
 * 3. Generate a ZK proof that the model produced the claimed output
 * 4. Return the proof for on-chain verification
 *
 * @module services/validators/ezklTestRunner
 */

import type { ValidationTestRunner, TestConfig, TestResult } from "../validationService.js";

export class EZKLTestRunner implements ValidationTestRunner {
  name = "ezkl";

  async runTest(_agentId: string, _config: TestConfig): Promise<TestResult> {
    throw new Error(
      "EZKL/ZKML validation is not yet available. " +
      "Zero-knowledge proofs for large language model inference are still maturing. " +
      "Use testType 'capability' for basic validation or 'inference' for LLM-as-judge testing. " +
      "EZKL support will be added when zkML frameworks are production-ready for agent-scale models.",
    );
  }
}
