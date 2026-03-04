/**
 * ContractDeployer — compiles and deploys Solidity contracts to the local
 * Revive dev node using both EVM (solc) and PVM (resolc) toolchains.
 *
 * Automates:
 *   1. EVM compilation:  solc --combined-json abi,bin,bin-runtime,srcmap,srcmap-runtime
 *   2. PVM compilation:  resolc --bin --abi (outputs RISC-V bytecode)
 *   3. Deployment via Ethereum JSON-RPC (eth_sendTransaction)
 */
import { CompiledArtifact } from './sourceMapper';
import { BackendType } from './backendConnector';
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
    bytecode: string;
    abi: unknown[];
    contractName: string;
}
export interface DeployResult {
    backend: BackendType;
    txHash: string;
    contractAddress: string;
    gasUsed?: bigint;
}
export declare class ContractDeployer {
    private config;
    private rpcId;
    constructor(config: DeployerConfig);
    compile(contractFile: string): Promise<CompileResult>;
    private compileWithSolc;
    private compileWithResolc;
    deploy(artifact: CompiledArtifact | PvmArtifact, backend: BackendType, constructorArgs?: unknown[]): Promise<DeployResult>;
    private extractContractName;
    private rpcCall;
    /**
     * Encode a function call selector (first 4 bytes of keccak256 of signature).
     * Minimal implementation — for production use viem or ethers.js.
     */
    static encodeFunctionSelector(signature: string): string;
}
//# sourceMappingURL=contractDeployer.d.ts.map