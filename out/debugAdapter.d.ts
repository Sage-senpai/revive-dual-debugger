#!/usr/bin/env node
/**
 * ReviveDebugSession — the Debug Adapter Protocol implementation.
 *
 * This file is the entry point for the debug adapter process (runs as a
 * separate Node.js subprocess, launched by VS Code via package.json "program").
 *
 * Implements the DAP for:
 *   - REVM backend: opcode-level stepping via debug_traceTransaction
 *   - PVM backend:  syscall-level stepping via strace log parsing
 *   - BOTH:         runs both connectors simultaneously for comparison
 */
import { LoggingDebugSession } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { BackendType } from './backendConnector';
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    contractFile: string;
    backend: BackendType;
    ethRpcUrl: string;
    substrateUrl: string;
    nodePath: string;
    ethRpcPath: string;
    resolcPath: string;
    solcPath: string;
    constructorArgs: unknown[];
    autoStartNode: boolean;
    trace: boolean;
}
export declare class ReviveDebugSession extends LoggingDebugSession {
    private currentBackend;
    private orchestrator;
    private revmConnector;
    private pvmConnector;
    private sourceMapper;
    private weightMeter;
    private deployer;
    private launchArgs;
    private breakpointMap;
    private nextBreakpointId;
    private stoppedThread;
    constructor();
    protected initializeRequest(response: DebugProtocol.InitializeResponse, _args: DebugProtocol.InitializeRequestArguments): void;
    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): Promise<void>;
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, _args: DebugProtocol.ConfigurationDoneArguments): void;
    protected setBreakpointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void>;
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void;
    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void>;
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void;
    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void>;
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void>;
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void>;
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void>;
    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void>;
    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void>;
    protected customRequest(command: string, response: DebugProtocol.Response, args: Record<string, unknown>): void;
    protected terminateRequest(response: DebugProtocol.TerminateResponse, _args: DebugProtocol.TerminateArguments): Promise<void>;
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, _args: DebugProtocol.DisconnectArguments): Promise<void>;
    private startNode;
    private initializeConnectors;
    private compileAndDeploy;
    private sendStopped;
    private sendWeightUpdate;
    private log;
    private cleanupSession;
}
export {};
//# sourceMappingURL=debugAdapter.d.ts.map