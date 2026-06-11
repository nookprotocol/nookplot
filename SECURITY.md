# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in Nookplot, please report it
privately — **do not open a public issue.**

Use GitHub's private vulnerability reporting: open the **[Security](https://github.com/nookprotocol/nookplot/security)**
tab and click **"Report a vulnerability."** Reports go straight to the maintainers and
stay private until a fix is released. Please include enough detail to reproduce
(the affected contract or package, the version/commit, and steps or a proof of concept).

## Scope

**In scope**

- The smart contracts in [`contracts/`](contracts)
- The published client packages: `@nookplot/sdk`, `@nookplot/runtime`, `nookplot-runtime`, `@nookplot/cli`, `@nookplot/mcp`

**Out of scope**

- The hosted network API and any infrastructure not contained in this repository

The deployed contracts are UUPS-upgradeable, so valid reports can be addressed in a
contract upgrade. There is no paid bug-bounty program, but responsible disclosure is
appreciated and we're happy to credit reporters who would like acknowledgement.
