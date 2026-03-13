/**
 * NodeOrchestrator — manages the lifecycle of the local Revive development node.
 *
 * Spawns and monitors:
 *   1. revive-dev-node  — substrate node with pallet-revive
 *   2. pallet-revive-eth-rpc  — Ethereum JSON-RPC compatibility adapter
 *
 * Health-checks via eth_blockNumber and emits structured events.
 */

import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import * as http from 'http';

// ─── WSL helpers (Windows-only) ───────────────────────────────────────────────

/**
 * On Windows, Linux binaries must run inside WSL.
 * Converts a Windows path like C:\Users\...\bin\linux\eth-rpc
 * to its WSL mount path /mnt/c/Users/.../bin/linux/eth-rpc,
 * then wraps the call as: spawn('wsl', ['-d', 'Ubuntu', '--', <wslPath>, ...args])
 */
function wslSpawn(
  binPath: string,
  args: string[],
  options: SpawnOptions
): ChildProcess {
  if (process.platform !== 'win32') {
    return spawn(binPath, args, options);
  }
  const wslPath = toWslPath(binPath);
  return spawn('wsl', ['-d', 'Ubuntu', '--', wslPath, ...args], options);
}

function toWslPath(winPath: string): string {
  // Already a WSL path
  if (winPath.startsWith('/')) return winPath;
  // C:\Users\... → /mnt/c/Users/...
  return winPath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_m, d: string) => `/mnt/${d.toLowerCase()}/`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface NodeOrchestratorConfig {
  nodePath: string;       // path to revive-dev-node binary
  ethRpcPath: string;     // path to pallet-revive-eth-rpc binary
  ethRpcUrl: string;      // e.g. http://localhost:8545
  substrateUrl: string;   // e.g. ws://localhost:9944
  enableStrace: boolean;  // emit strace logs
  trace: boolean;         // verbose logging
}

export interface NodeLogLine {
  source: 'substrate' | 'ethrpc';
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
  raw: string;
  timestamp: number;
}

// ─── NodeOrchestrator ─────────────────────────────────────────────────────────

export class NodeOrchestrator extends EventEmitter {
  private substrateProcess: ChildProcess | null = null;
  private ethRpcProcess: ChildProcess | null = null;
  private status: NodeStatus = 'stopped';
  private config: NodeOrchestratorConfig;
  private startupTimeout = 30_000;  // 30 seconds
  private healthCheckInterval: NodeJS.Timeout | null = null;

  // Accumulated log buffer for late subscribers
  private logBuffer: NodeLogLine[] = [];
  private maxBufferSize = 500;

  constructor(config: NodeOrchestratorConfig) {
    super();
    this.config = config;
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') {
      return;
    }

    this.setStatus('starting');
    this.emit('log', this.makeLog('substrate', 'info', 'Starting revive-dev-node...'));

    try {
      await this.startSubstrateNode();
      await this.waitForSubstrateReady();

      await this.startEthRpc();
      await this.waitForEthRpcReady();

      this.setStatus('running');
      this.startHealthChecks();
      this.emit('ready');
    } catch (err) {
      this.setStatus('error');
      this.emit('error', err);
      throw err;
    }
  }

  // ─── Stop ──────────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    await this.killProcess(this.ethRpcProcess, 'pallet-revive-eth-rpc');
    await this.killProcess(this.substrateProcess, 'revive-dev-node');

    this.ethRpcProcess = null;
    this.substrateProcess = null;
    this.setStatus('stopped');
    this.emit('stopped');
  }

  // ─── Substrate Node ────────────────────────────────────────────────────────

  private startSubstrateNode(): Promise<void> {
    return new Promise((resolve, reject) => {
      const rustLog = this.config.enableStrace
        ? 'runtime::revive::strace=trace,runtime::revive=debug,error'
        : 'runtime::revive=info,error';

      const args = [
        '--dev',
        '--tmp',
        '--rpc-cors=all',
        '--rpc-external',
      ];

      const env = {
        ...process.env,
        RUST_LOG: rustLog,
        RUST_BACKTRACE: this.config.trace ? '1' : '0'
      };

      this.emit('log', this.makeLog(
        'substrate', 'debug',
        `Spawning: ${this.config.nodePath} ${args.join(' ')}`
      ));

      this.substrateProcess = wslSpawn(this.config.nodePath, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const proc = this.substrateProcess;

      proc.on('error', (err) => {
        const msg = err.message.includes('ENOENT')
          ? `revive-dev-node binary not found at: ${this.config.nodePath}. ` +
            'Build with: cargo build -p revive-dev-node --release'
          : err.message;
        reject(new Error(msg));
      });

      proc.on('exit', (code, signal) => {
        if (this.status !== 'stopped') {
          this.emit('log', this.makeLog(
            'substrate', 'warn',
            `revive-dev-node exited unexpectedly (code=${code}, signal=${signal})`
          ));
          this.setStatus('error');
          this.emit('error', new Error(`Node exited with code ${code}`));
        }
      });

      proc.stdout?.on('data', (data: Buffer) => {
        this.processNodeOutput('substrate', data.toString());
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.processNodeOutput('substrate', text);
        // Emit raw strace lines for pvmConnector
        for (const line of text.split('\n')) {
          if (line.includes('runtime::revive')) {
            this.emit('straceLine', line);
          }
        }
      });

      // Resolve once spawned (health check will verify readiness)
      resolve();
    });
  }

  private async waitForSubstrateReady(): Promise<void> {
    const wsUrl = this.config.substrateUrl;
    const deadline = Date.now() + this.startupTimeout;

    while (Date.now() < deadline) {
      try {
        await this.checkSubstrateHealth(wsUrl);
        this.emit('log', this.makeLog('substrate', 'info', 'Substrate node is ready'));
        return;
      } catch {
        await sleep(1000);
      }
    }
    throw new Error(`Substrate node did not become ready within ${this.startupTimeout}ms`);
  }

  private checkSubstrateHealth(wsUrl: string): Promise<void> {
    // Use HTTP RPC for health check (simpler than WebSocket)
    const httpUrl = wsUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'system_health', params: []
      });
      const urlObj = new URL(httpUrl);
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: parseInt(urlObj.port || '9944'),
          path: urlObj.pathname || '/',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
        },
        (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        }
      );
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ─── Eth-RPC Adapter ───────────────────────────────────────────────────────

  private startEthRpc(): Promise<void> {
    return new Promise((resolve) => {
      const args = ['--dev'];

      this.emit('log', this.makeLog(
        'ethrpc', 'info',
        `Starting Ethereum RPC adapter at ${this.config.ethRpcUrl}`
      ));

      this.ethRpcProcess = wslSpawn(this.config.ethRpcPath, args, {
        env: { ...process.env, RUST_LOG: 'pallet_revive_eth_rpc=info,error' },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const proc = this.ethRpcProcess;

      proc.on('error', (err) => {
        const msg = err.message.includes('ENOENT')
          ? `eth-rpc binary not found at: ${this.config.ethRpcPath}. ` +
            'Build with: cargo build -p pallet-revive-eth-rpc --release'
          : err.message;
        // Non-fatal — REVM tracing may still work if eth-rpc is run separately
        this.emit('log', this.makeLog('ethrpc', 'warn', msg));
        resolve();  // resolve anyway, let health check determine status
      });

      proc.stdout?.on('data', (d: Buffer) => this.processNodeOutput('ethrpc', d.toString()));
      proc.stderr?.on('data', (d: Buffer) => this.processNodeOutput('ethrpc', d.toString()));

      resolve();
    });
  }

  private async waitForEthRpcReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await this.checkEthRpcHealth();
        this.emit('log', this.makeLog('ethrpc', 'info', 'Ethereum RPC adapter is ready'));
        return;
      } catch {
        await sleep(1000);
      }
    }
    this.emit('log', this.makeLog('ethrpc', 'warn',
      'eth-rpc adapter did not respond — REVM backend may be unavailable'));
  }

  private checkEthRpcHealth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.ethRpcUrl);
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: []
      });
      const req = http.request(
        {
          hostname: url.hostname,
          port: parseInt(url.port || '8545'),
          path: url.pathname || '/',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
        },
        (res) => { res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)); }
      );
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ─── Health Checks ─────────────────────────────────────────────────────────

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.checkEthRpcHealth();
      } catch {
        if (this.status === 'running') {
          this.emit('log', this.makeLog('ethrpc', 'warn', 'eth-rpc health check failed'));
        }
      }
    }, 10_000);
  }

  // ─── Log Processing ────────────────────────────────────────────────────────

  private processNodeOutput(source: 'substrate' | 'ethrpc', text: string): void {
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const level = detectLogLevel(trimmed);
      const logLine = this.makeLog(source, level, trimmed, raw);
      this.bufferLog(logLine);
      this.emit('log', logLine);
    }
  }

  private makeLog(
    source: 'substrate' | 'ethrpc',
    level: NodeLogLine['level'],
    message: string,
    raw = message
  ): NodeLogLine {
    return { source, level, message, raw, timestamp: Date.now() };
  }

  private bufferLog(line: NodeLogLine): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }
  }

  // ─── Kill Helper ───────────────────────────────────────────────────────────

  private killProcess(proc: ChildProcess | null, _name: string): Promise<void> {
    if (!proc || proc.killed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      proc.on('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
        resolve();
      }, 3000);
    });
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  getStatus(): NodeStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  getLogBuffer(): NodeLogLine[] {
    return [...this.logBuffer];
  }

  private setStatus(s: NodeStatus): void {
    this.status = s;
    this.emit('statusChange', s);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function detectLogLevel(line: string): NodeLogLine['level'] {
  if (/\bERROR\b/i.test(line)) return 'error';
  if (/\bWARN\b/i.test(line)) return 'warn';
  if (/\bDEBUG\b/i.test(line)) return 'debug';
  if (/\bTRACE\b/i.test(line)) return 'trace';
  return 'info';
}
