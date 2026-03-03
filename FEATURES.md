# ReviveDualDebugger — Feature List

## Current Features (v0.1.0 MVP)

### Core Debugging

| Feature | Status | Description |
|---|---|---|
| DAP integration | ✅ | Full Debug Adapter Protocol via `@vscode/debugadapter` |
| REVM opcode stepping | ✅ | Step through every EVM instruction via `debug_traceTransaction` |
| PVM syscall stepping | ✅ | Step through every `seal_*` host function call via strace logs |
| Dual-backend mode | ✅ | Run REVM and PVM simultaneously and compare |
| Backend switcher | ✅ | Toggle between REVM / PVM / BOTH at runtime |
| Breakpoints | ✅ | Source-level breakpoints (resolved via solc source maps for EVM) |
| Call stack | ✅ | Shows EVM call depth / PVM syscall nesting |
| Variable inspection | ✅ | EVM stack + storage slots; PVM syscall args + weight metrics |
| Step Over (F10) | ✅ | Advance one opcode (EVM) or one syscall (PVM) |
| Step Into (F11) | ✅ | Step into CALL/CREATE (EVM) or nested contract call (PVM) |
| Step Out (Shift+F11) | ✅ | Exit current call frame |
| Continue (F5) | ✅ | Run to next breakpoint |
| Evaluate expression | ✅ | Type `metrics` in Debug Console for weight summary |

### Compilation & Deployment

| Feature | Status | Description |
|---|---|---|
| solc integration | ✅ | Compile Solidity to EVM bytecode |
| resolc integration | ✅ | Compile Solidity to PolkaVM (RISC-V) bytecode |
| Auto-deploy | ✅ | Deploy compiled artifacts to local dev node |
| One-click deploy & debug | ✅ | `Revive: One-Click Deploy & Debug` command |
| Constructor args | ✅ | Pass constructor arguments via launch config |

### Node Management

| Feature | Status | Description |
|---|---|---|
| Auto-start node | ✅ | Spawns `revive-dev-node` on debug session start |
| eth-rpc adapter | ✅ | Spawns `pallet-revive-eth-rpc` for EVM JSON-RPC |
| Health checks | ✅ | Polls `eth_blockNumber` every 10s |
| Graceful shutdown | ✅ | SIGTERM → SIGKILL with timeout on disconnect |
| Log forwarding | ✅ | Node logs visible in VS Code Output panel |
| strace capture | ✅ | Attaches to node stderr for `runtime::revive::strace` |

### Visualization

| Feature | Status | Description |
|---|---|---|
| Dual-trace webview | ✅ | Side-by-side REVM opcode / PVM syscall panes |
| Weight Meter | ✅ | Live `ref_time`, `proof_size`, `storage_deposit` bars |
| Gas vs Weight comparison | ✅ | Percentage bars showing consumption vs block limits |
| Verdict & warnings | ✅ | Automated analysis: "proof_size is the bottleneck" |
| Source line hints | ✅ | Clickable `:line` annotations in trace rows |
| Jump to source | ✅ | Click trace row to open Solidity file at that line |
| Copy trace | ✅ | Copy full trace to clipboard |
| Status bar integration | ✅ | Backend indicator + node status |

### Host Function Coverage

All 28 `pallet-revive` UAPI syscalls are recognized and annotated:

| Category | Syscalls |
|---|---|
| Storage | `seal_get_storage`, `seal_set_storage`, `seal_clear_storage` |
| Calls | `seal_call`, `seal_delegate_call`, `seal_instantiate` |
| Account | `seal_caller`, `seal_address`, `seal_origin`, `seal_balance`, `seal_minimum_balance` |
| Value | `seal_value_transferred`, `seal_transfer` |
| Block | `seal_block_number`, `seal_now` |
| Gas/Weight | `seal_gas_left`, `seal_weight_to_fee` |
| Code | `seal_code_hash`, `seal_own_code_hash`, `seal_is_contract` |
| Crypto | `seal_hash_sha2_256`, `seal_hash_keccak_256`, `seal_hash_blake2_128`, `seal_hash_blake2_256`, `seal_ecdsa_recover`, `seal_sr25519_verify` |
| Control | `seal_return`, `seal_revert`, `seal_terminate` |
| Events | `seal_deposit_event`, `seal_debug_message` |
| Runtime | `seal_call_runtime`, `seal_xcm_execute`, `seal_xcm_send` |

---

## Phase 2 Features (Planned — v0.2.0)

### Source Maps for PVM

| Feature | Description |
|---|---|
| resolc DWARF maps | Parse DWARF debug info from `resolc` output for precise RISC-V → Solidity mapping |
| Accurate PVM breakpoints | Breakpoints resolved to exact RISC-V instruction boundaries |
| Register state inspection | Show RISC-V register values (x0–x31) in Variables panel |
| Memory viewer | Inspect PVM linear memory alongside EVM memory |

### XCM Tracing

| Feature | Description |
|---|---|
| XCM flow visualization | When `seal_xcm_send` fires, show a flow diagram: origin → relay → destination |
| Cross-chain call graph | Visual graph of XCM messages between parachains |
| Multi-hop tracing | Follow a message through multiple XCM hops |
| XCM decode | Decode XCM versioned message bytes into human-readable instructions |

### Remote Debugging

| Feature | Description |
|---|---|
| Westend Asset Hub | Connect to the public Westend testnet for remote debugging |
| Transaction replay | Replay a historical transaction from any block number |
| Post-mortem analysis | Load a failed transaction from the chain and trace it locally |
| RPC node selector | Quick-pick list of known Polkadot/Kusama/Westend endpoints |

---

## Phase 3 Features (Future — v0.3.0+)

### Time-Travel Debugging

| Feature | Description |
|---|---|
| State snapshot | Capture complete PVM register + memory state at any point |
| Backward stepping | Step backward through PVM execution history |
| State diff | Show what changed between two execution snapshots |
| Replay from snapshot | Jump to any past state and re-run from there |

> **Technical note:** PolkaVM's deterministic RISC-V execution makes this feasible. The VM starts with a defined initial state; replaying the instruction log always produces the same result.

### Team Collaboration

| Feature | Description |
|---|---|
| Trace export | Export traces as JSON/CSV for offline analysis |
| Trace sharing | Share a trace URL with teammates (requires backend service) |
| Annotation | Add comments to trace rows |
| Diff view | Compare two traces from different contract versions |

### AI-Assisted Analysis

| Feature | Description |
|---|---|
| Weight optimization hints | AI-generated suggestions for reducing `proof_size` or `ref_time` |
| Anomaly detection | Highlight unusual patterns in EVM opcode sequences |
| Gas estimation | Predict gas/weight cost before deployment |
| Natural language queries | Ask "why did this transaction fail?" and get a trace-based answer |

### Ecosystem Integration

| Feature | Description |
|---|---|
| Foundry integration | Run Foundry tests and visualize traces in the debugger |
| Hardhat plugin | `npx hardhat revive-debug` command |
| GitHub Actions | CI badge showing gas/weight budget compliance |
| Polkadot.js Apps | Link from the Apps UI to open a transaction in the debugger |

---

## Feature Comparison: EVM vs PVM Debugging

| Capability | REVM (EVM) | PolkaVM (PVM) |
|---|---|---|
| Opcode stepping | ✅ Full | Syscall-level only |
| Source line mapping | ✅ Via solc srcmap | Best-effort (Phase 2: DWARF) |
| Stack inspection | ✅ Full EVM stack | N/A (RISC-V registers in Phase 2) |
| Storage slots | ✅ Via structLogs | Via `seal_get_storage` args |
| Gas tracking | ✅ Per-opcode | N/A (weight via strace) |
| Weight tracking | N/A | ✅ ref_time + proof_size |
| Event decoding | Via ABI | Via `seal_deposit_event` args |
| Revert reason | ✅ From returnData | ✅ From `seal_revert` |
| Contract calls | ✅ CALL depth | ✅ `seal_call` nesting |
| XCM messages | ❌ | ✅ `seal_xcm_send` (Phase 2: visualized) |
| Time-travel | ❌ | Phase 3 |
| Remote debug | Phase 2 | Phase 2 |

---

## Gas / Weight Reference Card

### EVM Opcode Costs (REVM)

| Opcode | Gas Cost | Notes |
|---|---|---|
| `SLOAD` (cold) | 2,100 | First access in tx |
| `SLOAD` (warm) | 100 | Subsequent access |
| `SSTORE` (new value) | 20,000 | Zero → non-zero |
| `SSTORE` (update) | 2,900 | Non-zero → non-zero |
| `CALL` | 700 + stipend | Plus value transfer cost |
| `CREATE` | 32,000 | Plus init code cost |
| `LOG3` | 375 + 8/byte | Events with 3 topics |
| `SHA3` | 30 + 6/word | Keccak hash |

### Substrate Weight Dimensions

| Dimension | Unit | Block Limit | Notes |
|---|---|---|---|
| `ref_time` | picoseconds | 500ms ≈ 500×10⁹ ps | Computation time |
| `proof_size` | bytes | 5 MB | Storage proof for validation |
| `storage_deposit` | planck | Per-byte rate | Locked balance for state |

### Common Proof Size Contributors (PVM)

| Operation | proof_size Added |
|---|---|
| `seal_get_storage` (32-byte key) | ~64 bytes |
| `seal_get_storage` (larger value) | ~64 + value_len bytes |
| `seal_set_storage` | ~96 bytes |
| `seal_caller` | ~32 bytes |
| `seal_deposit_event` | ~32 + data_len bytes |

---

## Known Limitations (v0.1.0)

1. **PVM breakpoints are approximate** — resolved at syscall boundaries, not individual RISC-V instructions. Phase 2 will add DWARF support.
2. **Constructor args encoding** — only raw hex encoding is supported. Use `resolc` or `ethers.js` for ABI-encoded args.
3. **Remote nodes** — only local dev node is supported in v0.1.0.
4. **Multi-file projects** — source map resolution works best with single-file contracts. Multi-file support coming in Phase 2.
5. **Windows paths** — some path handling assumes Unix separators. Set absolute paths in `settings.json` if running on Windows.
