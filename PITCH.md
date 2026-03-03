# ReviveDualDebugger — Grant Pitch

## The Problem: A Debugging Void in the Revive Era

The Polkadot ecosystem is undergoing its most significant developer experience shift in years. With the `pallet-revive` replacing the legacy `pallet-contracts` WebAssembly environment, Ethereum developers can now deploy Solidity code natively on the Polkadot Hub — but they face a critical gap: **there is no debugger**.

When a Solidity contract deployed to the Polkadot Hub behaves differently than on Ethereum, developers have no tool to answer:

- Why did my transaction run out of gas on one VM but not the other?
- Which storage reads are inflating my `proof_size` beyond the block limit?
- Why does my `call{}()` succeed in REVM but fail in PolkaVM?
- How does the RISC-V weight model map to the Ethereum gas I already understand?

This is not a minor inconvenience. The absence of observability is a **migration blocker** — enterprise teams will not adopt a new execution environment they cannot debug.

---

## The Solution: A Unified Dual-VM Debugger

**ReviveDualDebugger** is a VS Code extension that provides the first integrated debugging experience for the `pallet-revive` dual-VM architecture.

### What It Does

| Feature | Description |
|---|---|
| **EVM Opcode Tracing** | Step through every EVM instruction via `debug_traceTransaction` on the local eth-rpc adapter |
| **PVM Syscall Tracing** | Observe every host-function call (`seal_*`) emitted by the PolkaVM runtime |
| **Side-by-Side View** | Two-pane webview showing REVM opcode trace alongside PVM syscall trace in real-time |
| **Weight Meter** | Live dashboard: `ref_time`, `proof_size`, `storage_deposit` vs EVM gas |
| **Backend Switcher** | Toggle between REVM, PVM, or BOTH without leaving VS Code |
| **One-Click Deploy** | Compile with `solc` + `resolc`, deploy to local node, and begin debugging in one action |
| **Breakpoint Support** | Set breakpoints in Solidity source, resolved to bytecode via compiler source maps |

### The Key Insight

The Polkadot fee model is fundamentally different from Ethereum:

```
Total Fee = max(ref_time_weight, proof_size_weight) × Multiplier + Length Fee
```

A contract that appears gas-efficient on REVM may be **expensive on PolkaVM** if it makes many storage reads (inflating `proof_size`) or runs complex loops (inflating `ref_time`). ReviveDualDebugger makes this difference **visible and actionable**.

---

## Competitive Analysis

| Tool | Revive Support | Source-Level Debug | Gas vs Weight |
|---|---|---|---|
| Foundry-Polkadot | Full (via `--resolc`) | CLI only | No |
| Remix IDE | EVM only | Yes (EVM only) | No |
| dAppForge | ink! / Substrate focus | No | No |
| Hardhat | EVM only | Yes (EVM only) | No |
| **ReviveDualDebugger** | **REVM + PVM** | **Yes (both VMs)** | **Yes (live dashboard)** |

ReviveDualDebugger is not competing with these tools — it **complements** them by filling the observability gap that exists at the intersection of EVM and PolkaVM execution.

---

## Technical Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                   │
│  Commands │ Status Bar │ Webview Manager │ Config Manager   │
└─────────────────────────┬──────────────────────────────────┘
                          │ Debug Adapter Protocol (DAP)
┌─────────────────────────▼──────────────────────────────────┐
│                   ReviveDebugSession                        │
│         (LoggingDebugSession — vscode-debugadapter)         │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────────────────┐    │
│  │  RevmConnector  │    │       PvmConnector           │    │
│  │                 │    │                              │    │
│  │ eth_* RPC calls │    │ strace log stream parser     │    │
│  │ debug_traceT... │    │ StraceParser + regex engine  │    │
│  └────────┬────────┘    └──────────────┬───────────── ┘    │
│           │                            │                    │
│  ┌────────▼────────────────────────────▼────────────────┐  │
│  │              WeightMeter + SourceMapper               │  │
│  └───────────────────────────────────────────────────── ┘  │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────┐
│                   NodeOrchestrator                          │
│  spawn(revive-dev-node) + spawn(pallet-revive-eth-rpc)      │
└────────────────────────────────────────────────────────────┘
```

---

## Strategic Positioning

### Why Now?

- **Polkadot Solidity Hackathon 2026** (DoraHacks) is live — tooling projects win
- The Revive pallet is production-ready but **zero debugging infrastructure exists**
- Ethereum developers migrating to Polkadot Hub need EVM-familiar tooling

### Funding Pathways

1. **Web3 Foundation Grants** — Developer tooling is a Tier 1 priority in the W3F grant guidelines
2. **Polkadot Treasury** — Infrastructure proposals with clear ecosystem benefit
3. **DoraHacks Polkadot Solidity Hackathon 2026** — Tooling track prize pool
4. **Parity Technologies Collaboration** — Path to integration in official Polkadot docs

### The "Official Debugger" Path

By open-sourcing the extension under MIT license and submitting a W3F grant, ReviveDualDebugger can become the **recommended debugger** in the Polkadot documentation — similar to how Foundry became the recommended test framework. This creates a long-term moat via:

- Documentation integration (every tutorial links to the debugger)
- VS Code Marketplace discoverability
- Polkadot Blockchain Academy curriculum inclusion

---

## Roadmap

### MVP (Weeks 1–2)
- [x] DAP session with REVM opcode tracing
- [x] PVM syscall tracing via strace log parsing
- [x] Dual-pane webview
- [x] Weight Meter dashboard
- [x] One-click deploy and debug

### Phase 2 (Weeks 3–6)
- [ ] Full source-level breakpoints via resolc source maps
- [ ] XCM trace visualization (seal_xcm_send → destination parachain)
- [ ] Westend Asset Hub remote connection
- [ ] Time-travel debugging (deterministic RISC-V replay)

### Phase 3 (Weeks 7–12)
- [ ] Collaborative trace sharing
- [ ] Mainnet post-mortem analysis
- [ ] Polkadot Blockchain Academy integration
- [ ] VS Code Marketplace publication

---

## Team

Built with **Claude Sonnet 4.6** AI-assisted engineering, leveraging:
- Deep understanding of the `pallet-revive` UAPI host functions
- VS Code Extension API and Debug Adapter Protocol expertise
- Polkadot SDK and substrate node architecture knowledge

> *"The transition to RISC-V via PolkaVM is a cornerstone of the Polkadot 2.0 vision. But performance without observability is a risk no development team should accept."*
