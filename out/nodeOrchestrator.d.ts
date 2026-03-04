/**
 * NodeOrchestrator — manages the lifecycle of the local Revive development node.
 *
 * Spawns and monitors:
 *   1. revive-dev-node  — substrate node with pallet-revive
 *   2. pallet-revive-eth-rpc  — Ethereum JSON-RPC compatibility adapter
 *
 * Health-checks via eth_blockNumber and emits structured events.
 */
import { EventEmitter } from 'events';
export type NodeStatus = 'stopped' | 'starting' | 'running' | 'error';
export interface NodeOrchestratorConfig {
    nodePath: string;
    ethRpcPath: string;
    ethRpcUrl: string;
    substrateUrl: string;
    enableStrace: boolean;
    trace: boolean;
}
export interface NodeLogLine {
    source: 'substrate' | 'ethrpc';
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    message: string;
    raw: string;
    timestamp: number;
}
export declare class NodeOrchestrator extends EventEmitter {
    private substrateProcess;
    private ethRpcProcess;
    private status;
    private config;
    private startupTimeout;
    private healthCheckInterval;
    private logBuffer;
    private maxBufferSize;
    constructor(config: NodeOrchestratorConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private startSubstrateNode;
    private waitForSubstrateReady;
    private checkSubstrateHealth;
    private startEthRpc;
    private waitForEthRpcReady;
    private checkEthRpcHealth;
    private startHealthChecks;
    private processNodeOutput;
    private makeLog;
    private bufferLog;
    private killProcess;
    getStatus(): NodeStatus;
    isRunning(): boolean;
    getLogBuffer(): NodeLogLine[];
    private setStatus;
}
//# sourceMappingURL=nodeOrchestrator.d.ts.map