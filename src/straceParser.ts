/**
 * StraceParser — parses runtime::revive::strace log lines emitted by
 * the substrate node when running with:
 *   RUST_LOG="runtime::revive::strace=trace,runtime::revive=debug"
 *
 * Log formats observed in pallet-revive:
 *
 *   CALL ENTRY:
 *     runtime::revive::strace: [0xADDR] seal_get_storage(key: 0x1234...)
 *     runtime::revive::strace: [0xADDR] seal_call(callee: 0x..., value: 0, ...)
 *
 *   CALL EXIT:
 *     runtime::revive::strace: [0xADDR] -> Result: Ok(data: 0x...)
 *     runtime::revive::strace: [0xADDR] -> Result: Err(module error: ...)
 *
 *   WEIGHT LOG:
 *     runtime::revive: weight consumed: ref_time: 12345, proof_size: 6789
 *
 *   DEPLOY LOG:
 *     runtime::revive: deployed contract at 0xADDR
 */

import { SyscallStep } from './backendConnector';

// ─── Regex Patterns ───────────────────────────────────────────────────────────

const CALL_ENTRY_RE =
  /runtime::revive::strace:\s+\[(?:0x)?([0-9a-fA-F]+)\]\s+(\w+)\(([^]*?)\)$/;

const CALL_EXIT_RE =
  /runtime::revive::strace:\s+\[(?:0x)?([0-9a-fA-F]+)\]\s+->\s+Result:\s+(Ok|Err)\(([^]*)\)$/;

const WEIGHT_RE =
  /runtime::revive[^:]*:\s+weight\s+consumed[^:]*:\s+ref_time:\s*(\d+)[^,]*,\s*proof_size:\s*(\d+)/i;

const DEPLOY_RE =
  /runtime::revive[^:]*:\s+deployed\s+contract\s+at\s+(0x[0-9a-fA-F]+)/i;

const STORAGE_DEPOSIT_RE =
  /storage_deposit[^:]*:\s*(\d+)/i;

// ─── Parsed Events ────────────────────────────────────────────────────────────

export type StraceEventType = 'callEntry' | 'callExit' | 'weight' | 'deploy' | 'unknown';

export interface StraceCallEntry {
  type: 'callEntry';
  address: string;
  name: string;
  args: string;
  parsedArgs: Record<string, string>;
  raw: string;
}

export interface StraceCallExit {
  type: 'callExit';
  address: string;
  status: 'Ok' | 'Err';
  data: string;
  raw: string;
}

export interface StraceWeight {
  type: 'weight';
  refTime: bigint;
  proofSize: bigint;
  storageDeposit?: bigint;
  raw: string;
}

export interface StraceDeploy {
  type: 'deploy';
  contractAddress: string;
  raw: string;
}

export interface StraceUnknown {
  type: 'unknown';
  raw: string;
}

export type StraceEvent =
  | StraceCallEntry
  | StraceCallExit
  | StraceWeight
  | StraceDeploy
  | StraceUnknown;

// ─── Parser ───────────────────────────────────────────────────────────────────

export class StraceParser {
  private callDepth = 0;
  private stepCounter = 0;

  /** Parse a single log line. Returns null if the line is not strace-related. */
  parseLine(line: string): StraceEvent | null {
    const trimmed = line.trim();

    // Call entry
    const entryMatch = CALL_ENTRY_RE.exec(trimmed);
    if (entryMatch) {
      const [, address, name, argsRaw] = entryMatch;
      this.callDepth++;
      return {
        type: 'callEntry',
        address: address.toLowerCase(),
        name,
        args: argsRaw,
        parsedArgs: parseKeyValueArgs(argsRaw),
        raw: trimmed
      };
    }

    // Call exit
    const exitMatch = CALL_EXIT_RE.exec(trimmed);
    if (exitMatch) {
      const [, address, status, data] = exitMatch;
      this.callDepth = Math.max(0, this.callDepth - 1);
      return {
        type: 'callExit',
        address: address.toLowerCase(),
        status: status as 'Ok' | 'Err',
        data,
        raw: trimmed
      };
    }

    // Weight consumed
    const weightMatch = WEIGHT_RE.exec(trimmed);
    if (weightMatch) {
      const [, refTime, proofSize] = weightMatch;
      const depositMatch = STORAGE_DEPOSIT_RE.exec(trimmed);
      return {
        type: 'weight',
        refTime: BigInt(refTime),
        proofSize: BigInt(proofSize),
        storageDeposit: depositMatch ? BigInt(depositMatch[1]) : undefined,
        raw: trimmed
      };
    }

    // Deploy
    const deployMatch = DEPLOY_RE.exec(trimmed);
    if (deployMatch) {
      return {
        type: 'deploy',
        contractAddress: deployMatch[1].toLowerCase(),
        raw: trimmed
      };
    }

    // Any other revive log line
    if (trimmed.includes('runtime::revive')) {
      return { type: 'unknown', raw: trimmed };
    }

    return null;
  }

  /** Convert a StraceCallEntry into a SyscallStep for the UI. */
  toSyscallStep(entry: StraceCallEntry): SyscallStep {
    return {
      address: entry.address,
      name: entry.name,
      args: entry.args,
      isEntry: true,
      timestamp: Date.now()
    };
  }

  /** Convert a StraceCallExit into a SyscallStep return for the UI. */
  toSyscallReturn(exit: StraceCallExit): SyscallStep {
    return {
      address: exit.address,
      name: `→ ${exit.status}`,
      args: exit.data,
      result: exit.status,
      isEntry: false,
      timestamp: Date.now()
    };
  }

  reset(): void {
    this.callDepth = 0;
    this.stepCounter = 0;
  }

  get currentDepth(): number {
    return this.callDepth;
  }
}

// ─── Host Function Catalogue ──────────────────────────────────────────────────

/**
 * Known pallet-revive host functions (UAPI syscalls).
 * Used to annotate traces with human-readable descriptions.
 */
export const HOST_FUNCTIONS: Record<string, string> = {
  seal_get_storage:        'Read contract storage slot',
  seal_set_storage:        'Write contract storage slot',
  seal_clear_storage:      'Clear contract storage slot',
  seal_call:               'Call another contract',
  seal_delegate_call:      'Delegate call to another contract',
  seal_instantiate:        'Deploy a new contract',
  seal_terminate:          'Self-destruct contract',
  seal_transfer:           'Transfer native tokens',
  seal_value_transferred:  'Get value sent with this call',
  seal_address:            'Get own contract address',
  seal_caller:             'Get the caller address',
  seal_origin:             'Get the transaction origin',
  seal_balance:            'Get own account balance',
  seal_weight_to_fee:      'Convert weight to fee amount',
  seal_gas_left:           'Get remaining gas/weight',
  seal_block_number:       'Get current block number',
  seal_now:                'Get current block timestamp',
  seal_minimum_balance:    'Get minimum account balance',
  seal_code_hash:          'Get code hash of a contract',
  seal_own_code_hash:      'Get own code hash',
  seal_is_contract:        'Check if address is a contract',
  seal_hash_sha2_256:      'SHA2-256 hash',
  seal_hash_keccak_256:    'Keccak-256 hash',
  seal_hash_blake2_128:    'Blake2-128 hash',
  seal_hash_blake2_256:    'Blake2-256 hash',
  seal_ecdsa_recover:      'ECDSA signature recovery',
  seal_sr25519_verify:     'SR25519 signature verification',
  seal_return:             'Return data from contract',
  seal_revert:             'Revert contract execution',
  seal_deposit_event:      'Emit a contract event/log',
  seal_debug_message:      'Emit debug message',
  seal_call_runtime:       'Call a pallet dispatchable',
  seal_xcm_execute:        'Execute XCM message locally',
  seal_xcm_send:           'Send XCM message cross-chain',
};

/** Get human-readable description for a host function name. */
export function describeHostFunction(name: string): string {
  return HOST_FUNCTIONS[name] ?? `Unknown host function: ${name}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse "key: value, key2: 0x..." argument strings into a key→value map.
 * Handles hex values, quoted strings, and nested parens (best-effort).
 */
function parseKeyValueArgs(argsRaw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!argsRaw.trim()) {
    return result;
  }

  // Split on ", " boundaries that are not inside parens/brackets
  const pairs = splitArgs(argsRaw);
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }
    const key = pair.slice(0, colonIdx).trim();
    const value = pair.slice(colonIdx + 1).trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function splitArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}
