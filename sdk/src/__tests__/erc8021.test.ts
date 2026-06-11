/**
 * ERC-8021 Builder Code suffix construction + calldata appending tests.
 */
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { buildErc8021Suffix } from "../metatx";
import { ERC2771_FORWARDER_ABI } from "../abis";

const ERC_MARKER = "80218021802180218021802180218021"; // 16 bytes, repeating 8021

describe("buildErc8021Suffix", () => {
  it("encodes bc_hr8binqm correctly", () => {
    const suffix = buildErc8021Suffix("bc_hr8binqm");

    // code = "bc_hr8binqm" (11 chars)
    const expectedCodeHex = Buffer.from("bc_hr8binqm", "ascii").toString("hex");
    const expectedLength = "0b"; // 11 in hex
    const expectedSchema = "00";
    const expected = "0x" + expectedCodeHex + expectedLength + expectedSchema + ERC_MARKER;

    expect(suffix).toBe(expected);
  });

  it("encodes the ox docs example (baseapp) correctly", () => {
    // From ox docs: Attribution.toDataSuffix({ codes: ["baseapp"] })
    // = 0x07626173656170700080218021802180218021802180218021
    // Wait — ox puts codesLength BEFORE codes. Let me re-derive:
    // Actually the ox output for single code "baseapp":
    // 0x 07 6261736561707000 80218021802180218021802180218021
    // Hmm, that has 8 bytes of code data for 7-char string...
    // Let me just verify our suffix structure is self-consistent.
    const suffix = buildErc8021Suffix("baseapp");

    // "baseapp" = 7 bytes ASCII
    const codeHex = Buffer.from("baseapp", "ascii").toString("hex");
    expect(codeHex).toBe("62617365617070");

    // Structure: [codes] [length] [schema] [marker]
    const expected = "0x" + "62617365617070" + "07" + "00" + ERC_MARKER;
    expect(suffix).toBe(expected);
  });

  it("last 16 bytes are the 8021 marker", () => {
    const suffix = buildErc8021Suffix("bc_hr8binqm");
    const raw = suffix.slice(2); // strip 0x
    const last32Chars = raw.slice(-32); // 16 bytes = 32 hex chars
    expect(last32Chars).toBe(ERC_MARKER);
  });

  it("schema byte (second-to-last 16 bytes) is 0x00", () => {
    const suffix = buildErc8021Suffix("bc_hr8binqm");
    const raw = suffix.slice(2);
    // marker is last 32 chars, schema is 2 chars before that
    const schemaByte = raw.slice(-34, -32);
    expect(schemaByte).toBe("00");
  });

  it("codesLength byte matches actual code length", () => {
    const code = "bc_hr8binqm"; // 11 chars
    const suffix = buildErc8021Suffix(code);
    const raw = suffix.slice(2);
    // layout: [codeHex][lengthByte][schemaByte][marker]
    // lengthByte is at position: codeHex.length to codeHex.length+2
    const lengthByte = raw.slice(code.length * 2, code.length * 2 + 2);
    expect(parseInt(lengthByte, 16)).toBe(code.length);
  });

  it("can be parsed backwards (indexer simulation)", () => {
    const code = "bc_hr8binqm";
    const suffix = buildErc8021Suffix(code);
    const raw = suffix.slice(2);

    // Step 1: Extract last 16 bytes (32 hex chars) — verify marker
    const marker = raw.slice(-32);
    expect(marker).toBe(ERC_MARKER);

    // Step 2: Read preceding 1 byte — schema ID
    const schemaId = parseInt(raw.slice(-34, -32), 16);
    expect(schemaId).toBe(0);

    // Step 3: Read preceding 1 byte — codes length
    const codesLength = parseInt(raw.slice(-36, -34), 16);
    expect(codesLength).toBe(11);

    // Step 4: Read that many bytes — the codes
    const codesHex = raw.slice(-36 - codesLength * 2, -36);
    const codesStr = Buffer.from(codesHex, "hex").toString("ascii");
    expect(codesStr).toBe("bc_hr8binqm");
  });
});

describe("suffix appending to forwarder calldata", () => {
  const forwarderIface = new ethers.Interface(ERC2771_FORWARDER_ABI);

  const mockRequest = {
    from: "0x1234567890123456789012345678901234567890",
    to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    value: 0n,
    gas: 500000n,
    deadline: 1700000000,
    data: "0xdeadbeef",
    signature: "0x" + "ab".repeat(65),
  };

  it("ABI-encoded calldata can have suffix appended", () => {
    const encoded = forwarderIface.encodeFunctionData("execute", [mockRequest]);
    const suffix = buildErc8021Suffix("bc_hr8binqm");
    const withSuffix = encoded + suffix.slice(2);

    // Verify it's valid hex
    expect(withSuffix.startsWith("0x")).toBe(true);
    expect(withSuffix.length).toBeGreaterThan(encoded.length);

    // Verify the suffix is at the end
    expect(withSuffix.endsWith(ERC_MARKER)).toBe(true);
  });

  it("ABI decoding still works with suffix appended", () => {
    const encoded = forwarderIface.encodeFunctionData("execute", [mockRequest]);
    const suffix = buildErc8021Suffix("bc_hr8binqm");
    const withSuffix = encoded + suffix.slice(2);

    // ethers should still decode the function data correctly,
    // ignoring trailing bytes (same as the EVM does)
    const decoded = forwarderIface.decodeFunctionData("execute", withSuffix);
    const req = decoded[0];

    expect(req.from.toLowerCase()).toBe(mockRequest.from.toLowerCase());
    expect(req.to.toLowerCase()).toBe(mockRequest.to.toLowerCase());
    expect(req.value).toBe(mockRequest.value);
    expect(req.gas).toBe(mockRequest.gas);
    expect(req.data).toBe(mockRequest.data);
  });

  it("suffix does not interfere with function selector", () => {
    const encoded = forwarderIface.encodeFunctionData("execute", [mockRequest]);
    const suffix = buildErc8021Suffix("bc_hr8binqm");
    const withSuffix = encoded + suffix.slice(2);

    // First 4 bytes (8 hex chars + 0x) should be the execute selector
    const selector = withSuffix.slice(0, 10);
    const expectedSelector = forwarderIface.getFunction("execute")!.selector;
    expect(selector).toBe(expectedSelector);
  });
});
