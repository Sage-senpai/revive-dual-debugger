/**
 * ContractDeployer — compiles and deploys Solidity contracts to the local
 * Revive dev node using both EVM (solc) and PVM (resolc) toolchains.
 *
 * Automates:
 *   1. EVM compilation:  solc --combined-json abi,bin,bin-runtime,srcmap,srcmap-runtime
 *   2. PVM compilation:  resolc --bin --abi (outputs RISC-V bytecode)
 *   3. Deployment via Ethereum JSON-RPC (eth_sendTransaction)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { CompiledArtifact } from './sourceMapper';
import { BackendType } from './backendConnector';

const execFileAsync = promisify(execFile);

/**
 * On Windows, wrap Linux tool invocations in `wsl -d Ubuntu -- env PATH=... <bin> <args>`.
 * Converts Windows paths to their /mnt/<drive>/... WSL equivalents.
 * extraPath entries are prepended to PATH inside WSL so resolc can find solc.
 */
function toWslPath(p: string): string {
  if (p.startsWith('/')) return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_m, d: string) => `/mnt/${d.toLowerCase()}/`);
}

function wslExec(
  binPath: string,
  args: string[],
  opts: { maxBuffer: number },
  extraPath?: string
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== 'win32') {
    const env = extraPath ? { ...process.env, PATH: `${extraPath}:${process.env.PATH}` } : process.env;
    return execFileAsync(binPath, args, { ...opts, env });
  }
  const wslBin = toWslPath(binPath);
  const cmdArgs = extraPath
    ? ['-d', 'Ubuntu', '--', 'env', `PATH=${extraPath}:/usr/local/bin:/usr/bin:/bin`, wslBin, ...args]
    : ['-d', 'Ubuntu', '--', wslBin, ...args];
  return execFileAsync('wsl', cmdArgs, opts);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeployerConfig {
  solcPath: string;
  resolcPath: string;
  backend: BackendType;
  ethRpcUrl: string;
}

export interface CompileResult {
  evm?: CompiledArtifact;
  pvm?: PvmArtifact;
  contractName: string;
  sourceFile: string;
}

export interface PvmArtifact {
  bytecode: string;    // RISC-V bytecode hex
  abi: unknown[];
  contractName: string;
}

export interface DeployResult {
  backend: BackendType;
  txHash: string;
  contractAddress: string;
  gasUsed?: bigint;
}

// ─── Solc Output Format ───────────────────────────────────────────────────────

interface SolcCombinedOutput {
  contracts: {
    [fileAndContract: string]: {
      abi: string;
      bin: string;
      'bin-runtime': string;
      srcmap: string;
      'srcmap-runtime': string;
    };
  };
  sourceList: string[];
  version: string;
}

// ─── ContractDeployer ─────────────────────────────────────────────────────────

export class ContractDeployer {
  private config: DeployerConfig;
  private rpcId = 1;

  constructor(config: DeployerConfig) {
    this.config = config;
  }

  // ─── Compile ───────────────────────────────────────────────────────────────

  async compile(contractFile: string): Promise<CompileResult> {
    const absPath = path.resolve(contractFile);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Contract file not found: ${absPath}`);
    }

    const contractName = this.extractContractName(absPath);
    const result: CompileResult = { contractName, sourceFile: absPath };

    // Compile for EVM if needed
    if (this.config.backend === 'REVM' || this.config.backend === 'BOTH') {
      result.evm = await this.compileWithSolc(absPath, contractName);
    }

    // Compile for PVM if needed
    if (this.config.backend === 'PVM' || this.config.backend === 'BOTH') {
      result.pvm = await this.compileWithResolc(absPath, contractName);
    }

    return result;
  }

  // ─── EVM Compilation (solc) ────────────────────────────────────────────────

  private async compileWithSolc(
    contractFile: string,
    contractName: string
  ): Promise<CompiledArtifact> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-solc-'));
    const outputFile = path.join(tmpDir, 'output.json');

    try {
      const args = [
        '--combined-json', 'abi,bin,bin-runtime,srcmap,srcmap-runtime',
        '--optimize',
        '--output-dir', tmpDir,
        contractFile
      ];

      let stdout = '';
      try {
        const result = await wslExec(this.config.solcPath, args, {
          maxBuffer: 50 * 1024 * 1024  // 50MB
        });
        stdout = result.stdout;
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        // solc writes output to stdout even on warnings
        if (execErr.stdout) {
          stdout = execErr.stdout;
        } else {
          throw new Error(
            `solc compilation failed: ${execErr.stderr ?? execErr.message ?? String(err)}\n` +
            'Ensure solc is installed: npm install -g solc'
          );
        }
      }

      let combined: SolcCombinedOutput;
      try {
        combined = JSON.parse(stdout);
      } catch {
        throw new Error(
          `solc produced invalid JSON output. First 200 chars: ${stdout.slice(0, 200)}`
        );
      }
      const key = Object.keys(combined.contracts).find(k =>
        k.includes(contractName)
      );

      if (!key) {
        const available = Object.keys(combined.contracts).join(', ');
        throw new Error(
          `Contract '${contractName}' not found in solc output. Available: ${available}`
        );
      }

      const contract = combined.contracts[key];
      return {
        abi: JSON.parse(contract.abi),
        bytecode: contract.bin,
        deployedBytecode: contract['bin-runtime'],
        sourceMap: contract.srcmap,
        deployedSourceMap: contract['srcmap-runtime']
      };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ─── PVM Compilation (resolc) ──────────────────────────────────────────────

  private async compileWithResolc(
    contractFile: string,
    contractName: string
  ): Promise<PvmArtifact> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-resolc-'));

    try {
      const args = [
        '--bin',
        '--abi',
        '--output-dir', tmpDir,
        contractFile
      ];

      // resolc shells out to `solc` — ensure solc's directory is on PATH
      const solcDir = path.dirname(this.config.solcPath);
      try {
        await wslExec(this.config.resolcPath, args, {
          maxBuffer: 50 * 1024 * 1024
        }, solcDir);
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; message?: string };
        throw new Error(
          `resolc compilation failed: ${execErr.stderr ?? execErr.message ?? String(err)}\n` +
          'Ensure resolc is installed: npm install -g @parity/resolc'
        );
      }

      // resolc outputs <ContractName>.polkavm and <ContractName>.abi
      const binFile = path.join(tmpDir, `${contractName}.polkavm`);
      const abiFile = path.join(tmpDir, `${contractName}.abi`);

      if (!fs.existsSync(binFile)) {
        // Try alternate output naming
        const files = fs.readdirSync(tmpDir);
        const pvmFile = files.find(f => f.endsWith('.polkavm'));
        if (!pvmFile) {
          throw new Error(
            `resolc output not found in ${tmpDir}. Files: ${files.join(', ')}`
          );
        }
        const bytecode = fs.readFileSync(path.join(tmpDir, pvmFile)).toString('hex');
        const abiContent = files.find(f => f.endsWith('.abi'))
          ? JSON.parse(fs.readFileSync(path.join(tmpDir, files.find(f => f.endsWith('.abi'))!), 'utf8'))
          : [];
        return { bytecode, abi: abiContent, contractName };
      }

      const bytecode = fs.readFileSync(binFile).toString('hex');
      const abi = fs.existsSync(abiFile)
        ? JSON.parse(fs.readFileSync(abiFile, 'utf8'))
        : [];

      return { bytecode, abi, contractName };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ─── Deploy ────────────────────────────────────────────────────────────────

  async deploy(
    artifact: CompiledArtifact | PvmArtifact,
    backend: BackendType,
    constructorArgs: unknown[] = []
  ): Promise<DeployResult> {
    // Both EVM and PVM deployments go through the eth-rpc adapter
    // The adapter routes to the correct VM internally
    const bytecode = 'bytecode' in artifact ? artifact.bytecode : (artifact as CompiledArtifact).bytecode;

    // Encode constructor args (simplified — use ethers.js for production)
    const deployData = `0x${bytecode}`;

    const accounts = await this.rpcCall<string[]>('eth_accounts', []);
    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts available from eth-rpc adapter');
    }
    const from = accounts[0];

    const txHash = await this.rpcCall<string>('eth_sendTransaction', [{
      from,
      data: deployData,
      gas: '0x' + (5_000_000n).toString(16)
    }]);

    // Wait for receipt
    let receipt: { contractAddress?: string; gasUsed?: string; status?: string } | null = null;
    for (let i = 0; i < 30; i++) {
      receipt = await this.rpcCall('eth_getTransactionReceipt', [txHash]);
      if (receipt) break;
      await sleep(1000);
    }

    if (!receipt || !receipt.contractAddress) {
      throw new Error(`Deployment transaction ${txHash} failed or did not create a contract`);
    }

    return {
      backend,
      txHash,
      contractAddress: receipt.contractAddress,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private extractContractName(filePath: string): string {
    return path.basename(filePath, path.extname(filePath));
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const response = await axios.post<{ result: T; error?: { message: string } }>(
      this.config.ethRpcUrl,
      { jsonrpc: '2.0', id: this.rpcId++, method, params },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 }
    );
    if (response.data.error) {
      throw new Error(`RPC error: ${response.data.error.message}`);
    }
    return response.data.result;
  }

  // ─── Utility: Encode ABI Call ──────────────────────────────────────────────

  /**
   * Encode a function call selector (first 4 bytes of keccak256 of signature).
   * Minimal implementation — for production use viem or ethers.js.
   */
  static encodeFunctionSelector(signature: string): string {
    // Simple djb2 hash as placeholder — replace with actual keccak256 in production
    let hash = 5381;
    for (let i = 0; i < signature.length; i++) {
      hash = ((hash << 5) + hash) + signature.charCodeAt(i);
      hash = hash & hash;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
