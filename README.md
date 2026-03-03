# ReviveDualDebugger

> The first dual-VM debugger for Polkadot's `pallet-revive` — debug Solidity contracts on both REVM (EVM) and PolkaVM (RISC-V) simultaneously.

## What Is This?

ReviveDualDebugger is a VS Code extension that provides integrated debugging for Solidity contracts deployed via `pallet-revive` on the Polkadot Hub. It supports both execution backends:

- **REVM** — Ethereum Virtual Machine compatibility layer (stack-based, 256-bit ops, traditional gas)
- **PolkaVM** — RISC-V native execution (register-based, 64-bit, `ref_time` + `proof_size` weight model)

The extension shows both traces **side-by-side** in real time, with a live **Weight Meter** comparing EVM gas consumption against Substrate weight metrics.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                      │
│  Commands, StatusBar, Webview, Config                        │
└──────────────────────┬──────────────────────────────────────┘
                       │ DAP (Debug Adapter Protocol)
┌──────────────────────▼──────────────────────────────────────┐
│  ReviveDebugSession (LoggingDebugSession)                    │
│                                                             │
│  ┌─────────────────┐   ┌──────────────────────────────┐    │
│  │  RevmConnector  │   │       PvmConnector            │    │
│  │  eth JSON-RPC   │   │  strace log stream parser     │    │
│  │  debug_traceT   │   │  runtime::revive::strace=trace│    │
│  └────────┬────────┘   └───────────────┬──────────────┘    │
│           │                            │                    │
│  ┌────────▼────────────────────────────▼─────────────────┐ │
│  │           WeightMeter · SourceMapper                   │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │ child_process.spawn
┌──────────────────────▼──────────────────────────────────────┐
│  NodeOrchestrator                                           │
│  revive-dev-node + pallet-revive-eth-rpc                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

Before using ReviveDualDebugger, install the following:

### Required

| Tool | Install | Purpose |
|---|---|---|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) | Extension runtime |
| **Rust toolchain** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | Build substrate binaries |
| **solc** | `npm install -g solc` | EVM compilation |

### For EVM (REVM) debugging

```bash
# Build revive-dev-node
git clone https://github.com/paritytech/polkadot-sdk
cd polkadot-sdk
cargo build -p revive-dev-node --release

# Build eth-rpc adapter
cargo build -p pallet-revive-eth-rpc --release

# Copy binaries to PATH
cp target/release/revive-dev-node ~/.local/bin/
cp target/release/pallet-revive-eth-rpc ~/.local/bin/
```

### For PolkaVM (PVM) debugging

```bash
# Install resolc (Solidity → RISC-V compiler)
npm install -g @parity/resolc
```

---

## Installation

### From Source

```bash
git clone https://github.com/your-org/revive-dual-debugger
cd revive-dual-debugger
npm install
npm run compile
```

Then in VS Code: **Extensions** → **Install from VSIX** (or press F5 to open Extension Development Host).

### From VS Code Marketplace

*Coming soon — search "ReviveDualDebugger"*

---

## Quick Start

### 1. Add launch configuration

Copy `example-launch.json` to your project's `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "revive",
      "request": "launch",
      "name": "Debug Solidity (Dual VM)",
      "contractFile": "${file}",
      "backend": "BOTH",
      "autoStartNode": true
    }
  ]
}
```

### 2. Open a Solidity file

```bash
code examples/Counter.sol
```

### 3. Press F5

The extension will:
1. Start `revive-dev-node` with strace logging enabled
2. Start the `pallet-revive-eth-rpc` adapter
3. Compile your contract with `solc` (EVM) and `resolc` (PVM)
4. Deploy both artifacts to the local node
5. Open the **Dual-VM Trace** webview
6. Stop at entry, ready for step-through debugging

### 4. Step through execution

| Key | Action |
|---|---|
| **F10** | Step over (next opcode/syscall) |
| **F11** | Step into |
| **Shift+F11** | Step out |
| **F5** | Continue to next breakpoint |
| **F9** | Toggle breakpoint at current line |

---

## Configuration

Add these to your VS Code `settings.json`:

```json
{
  "revive.nodePath": "revive-dev-node",
  "revive.ethRpcPath": "pallet-revive-eth-rpc",
  "revive.resolcPath": "resolc",
  "revive.solcPath": "solc",
  "revive.defaultBackend": "BOTH",
  "revive.ethRpcPort": 8545,
  "revive.substratePort": 9944
}
```

### launch.json Options

| Option | Type | Default | Description |
|---|---|---|---|
| `contractFile` | `string` | `${file}` | Path to the Solidity file |
| `backend` | `"REVM" \| "PVM" \| "BOTH"` | `"BOTH"` | Execution backend |
| `ethRpcUrl` | `string` | `"http://localhost:8545"` | eth-rpc adapter URL |
| `substrateUrl` | `string` | `"ws://localhost:9944"` | Substrate WebSocket URL |
| `nodePath` | `string` | `"revive-dev-node"` | Node binary path |
| `ethRpcPath` | `string` | `"pallet-revive-eth-rpc"` | eth-rpc binary path |
| `resolcPath` | `string` | `"resolc"` | resolc compiler path |
| `solcPath` | `string` | `"solc"` | solc compiler path |
| `constructorArgs` | `array` | `[]` | Constructor arguments |
| `autoStartNode` | `boolean` | `true` | Auto-start local dev node |
| `trace` | `boolean` | `false` | Verbose debug logging |

---

## Commands

Access via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Revive: Start Local Dev Node` | Start revive-dev-node + eth-rpc |
| `Revive: Stop Local Dev Node` | Stop the running node |
| `Revive: Switch to REVM Backend` | Switch active session to EVM |
| `Revive: Switch to PolkaVM Backend` | Switch active session to PVM |
| `Revive: One-Click Deploy & Debug` | Compile, deploy, and start debugging |
| `Revive: Compile Solidity Contract` | Compile without deploying |
| `Revive: Open Dual-VM Trace View` | Open the trace webview panel |

---

## The Dual-VM Trace View

The webview shows two columns:

**Left — REVM (EVM):**
```
PC    OPCODE        GAS COST   STACK TOP
0     PUSH1         3          —
2     PUSH1         3          0x00
4     MSTORE        9          0x00
5     CALLVALUE     2          0x60
...
```

**Right — PolkaVM Syscalls:**
```
→ seal_caller()                         ← Ok(0xf39f...)
→ seal_get_storage(key: 0x0000...02)    ← Ok(data: 0x0000...00)
→ seal_get_storage(key: 0x0000...01)    ← Ok(data: 0x0000...01)
→ seal_set_storage(key: 0x0000...02, value: 0x01)  ← Ok(2)
→ seal_deposit_event(topics: [...], data: 0x...)   ← Ok(())
```

**Bottom — Weight Meter:**
```
EVM Gas:     45,575 / 30,000,000 (0.2%)  ████░░░░░░░░░░░░░░░░
PVM ref_time:   12.3 μs (0.0% of block)  █░░░░░░░░░░░░░░░░░░░
PVM proof_size:  2.1 KB (0.0% of block)  █░░░░░░░░░░░░░░░░░░░
Verdict: Execution appears efficient on both backends
```

---

## PVM Host Functions Reference

The debugger annotates all `pallet-revive` UAPI syscalls:

| Syscall | Description | EVM Equivalent |
|---|---|---|
| `seal_get_storage` | Read storage slot | `SLOAD` |
| `seal_set_storage` | Write storage slot | `SSTORE` |
| `seal_caller` | Get caller address | `CALLER` |
| `seal_call` | Call another contract | `CALL` |
| `seal_instantiate` | Deploy new contract | `CREATE` |
| `seal_deposit_event` | Emit event | `LOGn` |
| `seal_value_transferred` | Get `msg.value` | `CALLVALUE` |
| `seal_transfer` | Transfer tokens | `CALL` with value |
| `seal_hash_keccak_256` | Keccak-256 hash | `SHA3` |
| `seal_xcm_send` | Send XCM message | *(no EVM equiv)* |
| `seal_call_runtime` | Call pallet dispatchable | *(no EVM equiv)* |

---

## Understanding Weight vs Gas

The Polkadot fee formula:

```
Total Fee = max(ref_time_weight, proof_size_weight) × Multiplier + Length Fee
```

Where:
- **`ref_time`** — computational cycles consumed (analogous to EVM gas)
- **`proof_size`** — bytes read from storage needed for block validation
- **`storage_deposit`** — balance locked for state occupancy

### Common Patterns

| Behavior | EVM Gas Impact | PVM Weight Impact |
|---|---|---|
| Storage read (`SLOAD`) | 2,100 gas (cold) | +32 bytes `proof_size` |
| Storage write (`SSTORE`) | 20,000 gas (dirty) | +64 bytes `proof_size` |
| Contract call | 700 gas | 1 syscall overhead |
| Event emission | 375+ gas | +data bytes `proof_size` |
| 256-bit arithmetic | 5 gas | Higher `ref_time` (emulated) |

---

## Development

```bash
# Install dependencies
npm install

# Build (production)
npm run compile

# Watch mode (development)
npm run watch

# Open Extension Development Host
# Press F5 in VS Code with this project open
```

### Project Structure

```
RevdDebugger/
├── src/
│   ├── extension.ts          Extension host entry point
│   ├── debugAdapter.ts       DAP session (ReviveDebugSession)
│   ├── backendConnector.ts   Interface definitions and types
│   ├── nodeOrchestrator.ts   Process lifecycle manager
│   ├── revmConnector.ts      EVM JSON-RPC backend
│   ├── pvmConnector.ts       PVM strace log backend
│   ├── straceParser.ts       Regex log parser
│   ├── weightMeter.ts        Gas/weight comparison engine
│   ├── sourceMapper.ts       Bytecode → Solidity line mapper
│   ├── contractDeployer.ts   solc + resolc compile/deploy
│   └── webview/
│       └── dualTracePanel.ts WebviewPanel manager + HTML
├── examples/
│   └── Counter.sol           Demo contract
├── example-launch.json       Template launch configuration
├── PITCH.md                  Grant pitch document
├── FEATURES.md               Feature list and roadmap
└── README.md                 This file
```

---

## Troubleshooting

### `revive-dev-node binary not found`

Ensure the binary is on your PATH or set `revive.nodePath` to its absolute path:
```json
{ "revive.nodePath": "/path/to/target/release/revive-dev-node" }
```

### `resolc compilation failed`

Install via npm: `npm install -g @parity/resolc`

Check the resolc version is compatible with your solc:
```bash
resolc --version
solc --version
```

### `eth_blockNumber timed out`

The eth-rpc adapter may take 10–15 seconds to start. Check node logs via:
- **View → Output → Revive Node** in VS Code
- Manually test: `curl -X POST http://localhost:8545 -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'`

### PVM trace shows no syscalls

Ensure the node is started with strace logging. The extension sets `RUST_LOG="runtime::revive::strace=trace"` automatically when `autoStartNode: true`. If running the node manually, add this environment variable.

---

## Contributing

Issues and PRs welcome. Key areas for contribution:

- DWARF/RISC-V source map support from `resolc` for precise PVM stepping
- XCM message flow visualization
- Westend Asset Hub remote connection
- Time-travel debugging (deterministic RISC-V state replay)

---

## License

MIT — see [LICENSE](LICENSE)

---

## Related Projects

- [paritytech/revive](https://github.com/paritytech/revive) — Solidity compiler for Polkadot
- [paritytech/polkadot-sdk](https://github.com/paritytech/polkadot-sdk) — Substrate + pallet-revive
- [paritytech/foundry-polkadot](https://github.com/paritytech/foundry-polkadot) — CLI test framework
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) — DAP specification
