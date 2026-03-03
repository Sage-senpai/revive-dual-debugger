/**
 * extension.ts — VS Code extension entry point.
 *
 * Registers commands, the debug adapter factory, and the status bar item.
 * Manages the NodeOrchestrator and DualTracePanel lifecycle.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { NodeOrchestrator, NodeOrchestratorConfig } from './nodeOrchestrator';
import { DualTracePanel } from './webview/dualTracePanel';
import { WeightMeter } from './weightMeter';

// Shared orchestrator instance (persists across debug sessions)
let orchestrator: NodeOrchestrator | null = null;
let statusBarItem: vscode.StatusBarItem;
let weightMeter: WeightMeter;

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  weightMeter = new WeightMeter();

  // ── Status Bar ────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'revive.openDualTrace';
  updateStatusBar('idle');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── Debug Adapter Factory ─────────────────────────────────────────────────
  const factory = new ReviveDebugAdapterFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('revive', factory)
  );

  // ── Debug Session Lifecycle ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      if (session.type === 'revive') {
        updateStatusBar('running');
        DualTracePanel.createOrShow(context.extensionUri, weightMeter);
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      if (session.type === 'revive') {
        updateStatusBar('idle');
      }
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
      if (event.session.type !== 'revive') return;
      handleCustomEvent(event, context);
    })
  );

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('revive.openDualTrace', () => {
      DualTracePanel.createOrShow(context.extensionUri, weightMeter);
    }),

    vscode.commands.registerCommand('revive.startNode', async () => {
      await startNodeCommand(context);
    }),

    vscode.commands.registerCommand('revive.stopNode', async () => {
      await stopNodeCommand();
    }),

    vscode.commands.registerCommand('revive.switchToREVM', async () => {
      await switchBackendCommand('REVM');
    }),

    vscode.commands.registerCommand('revive.switchToPVM', async () => {
      await switchBackendCommand('PVM');
    }),

    vscode.commands.registerCommand('revive.deployAndDebug', async () => {
      await deployAndDebugCommand(context);
    }),

    vscode.commands.registerCommand('revive.compileContract', async () => {
      await compileContractCommand();
    })
  );

  // ── Output Channel ────────────────────────────────────────────────────────
  const outputChannel = vscode.window.createOutputChannel('ReviveDualDebugger');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('ReviveDualDebugger activated');
  outputChannel.appendLine('Use F5 with a "revive" launch configuration to start debugging');
  outputChannel.appendLine('Run "Revive: Start Local Dev Node" to start the substrate node');
}

// ─── Deactivation ─────────────────────────────────────────────────────────────

export async function deactivate(): Promise<void> {
  await orchestrator?.stop();
  orchestrator = null;
}

// ─── Debug Adapter Factory ────────────────────────────────────────────────────

class ReviveDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    // Point VS Code to the compiled debug adapter bundle
    const adapterPath = path.join(__dirname, 'debugAdapter.js');
    return new vscode.DebugAdapterExecutable('node', [adapterPath]);
  }
}

// ─── Command Implementations ──────────────────────────────────────────────────

async function startNodeCommand(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('revive');

  if (orchestrator?.isRunning()) {
    vscode.window.showInformationMessage('ReviveDevNode is already running');
    return;
  }

  const orchConfig: NodeOrchestratorConfig = {
    nodePath: config.get('nodePath', 'revive-dev-node'),
    ethRpcPath: config.get('ethRpcPath', 'pallet-revive-eth-rpc'),
    ethRpcUrl: `http://localhost:${config.get('ethRpcPort', 8545)}`,
    substrateUrl: `ws://localhost:${config.get('substratePort', 9944)}`,
    enableStrace: true,
    trace: false
  };

  orchestrator = new NodeOrchestrator(orchConfig);

  const outputChannel = vscode.window.createOutputChannel('Revive Node');
  context.subscriptions.push(outputChannel);

  orchestrator.on('log', line => {
    outputChannel.appendLine(`[${line.source}] ${line.message}`);
  });

  orchestrator.on('ready', () => {
    updateStatusBar('running');
    vscode.window.showInformationMessage(
      'Revive dev node is running',
      'Open Trace View'
    ).then(choice => {
      if (choice === 'Open Trace View') {
        vscode.commands.executeCommand('revive.openDualTrace');
      }
    });
  });

  orchestrator.on('error', (err: Error) => {
    updateStatusBar('error');
    vscode.window.showErrorMessage(`Revive node error: ${err.message}`);
  });

  updateStatusBar('starting');

  try {
    await orchestrator.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to start Revive node: ${message}`);
    updateStatusBar('error');
    orchestrator = null;
  }
}

async function stopNodeCommand(): Promise<void> {
  if (!orchestrator) {
    vscode.window.showInformationMessage('No Revive node is running');
    return;
  }
  await orchestrator.stop();
  orchestrator = null;
  updateStatusBar('idle');
  vscode.window.showInformationMessage('Revive dev node stopped');
}

async function switchBackendCommand(backend: 'REVM' | 'PVM'): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== 'revive') {
    vscode.window.showWarningMessage(
      'No active Revive debug session. Start debugging first.'
    );
    return;
  }

  await session.customRequest('switchBackend', { backend });

  const panel = DualTracePanel.getInstance();
  if (panel) {
    panel.clear();
  }

  vscode.window.showInformationMessage(`Switched to ${backend} backend`);
  updateStatusBar('running', backend);
}

async function deployAndDebugCommand(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.sol')) {
    vscode.window.showErrorMessage('Open a Solidity (.sol) file to deploy and debug');
    return;
  }

  const config = vscode.workspace.getConfiguration('revive');
  const defaultBackend = config.get<string>('defaultBackend', 'BOTH');

  const launchConfig: vscode.DebugConfiguration = {
    type: 'revive',
    request: 'launch',
    name: 'Deploy & Debug',
    contractFile: editor.document.fileName,
    backend: defaultBackend,
    autoStartNode: true
  };

  await vscode.debug.startDebugging(undefined, launchConfig);
  DualTracePanel.createOrShow(context.extensionUri, weightMeter);
}

async function compileContractCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.sol')) {
    vscode.window.showErrorMessage('Open a Solidity (.sol) file to compile');
    return;
  }

  const file = editor.document.fileName;
  const config = vscode.workspace.getConfiguration('revive');

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(flame) EVM (solc)', value: 'REVM', description: 'Compile for EVM compatibility' },
      { label: '$(circuit-board) PolkaVM (resolc)', value: 'PVM', description: 'Compile for RISC-V native' },
      { label: '$(split-horizontal) Both', value: 'BOTH', description: 'Compile for both backends' }
    ],
    { placeHolder: 'Select compilation target' }
  );

  if (!choice) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Compiling...', cancellable: false },
    async () => {
      try {
        const { ContractDeployer } = await import('./contractDeployer');
        const deployer = new ContractDeployer({
          solcPath: config.get('solcPath', 'solc'),
          resolcPath: config.get('resolcPath', 'resolc'),
          backend: choice.value as 'REVM' | 'PVM' | 'BOTH',
          ethRpcUrl: `http://localhost:${config.get('ethRpcPort', 8545)}`
        });
        const result = await deployer.compile(file);
        vscode.window.showInformationMessage(
          `Compiled ${result.contractName} successfully` +
          (result.evm ? ' [EVM]' : '') +
          (result.pvm ? ' [PVM]' : '')
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Compilation failed: ${message}`);
      }
    }
  );
}

// ─── Custom Event Handler ─────────────────────────────────────────────────────

function handleCustomEvent(
  event: vscode.DebugSessionCustomEvent,
  _context: vscode.ExtensionContext
): void {
  const panel = DualTracePanel.getInstance();
  if (!panel) return;

  // Debug adapter sends telemetry events with metric snapshots
  if (event.event === 'output' && event.body?.category === 'telemetry') {
    // The DAP sends metric updates via OutputEvent; parse them in the extension
    // For production, use a proper custom event via DebugSession.customRequest
  }
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

function updateStatusBar(
  state: 'idle' | 'starting' | 'running' | 'error',
  backend?: string
): void {
  switch (state) {
    case 'idle':
      statusBarItem.text = '$(circuit-board) Revive';
      statusBarItem.tooltip = 'ReviveDualDebugger — Click to open trace view';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'starting':
      statusBarItem.text = '$(loading~spin) Revive: Starting...';
      statusBarItem.tooltip = 'ReviveDualDebugger — Starting dev node';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'running':
      const backendLabel = backend ? ` [${backend}]` : '';
      statusBarItem.text = `$(debug-alt) Revive${backendLabel}`;
      statusBarItem.tooltip = 'ReviveDualDebugger — Debug session active';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
    case 'error':
      statusBarItem.text = '$(error) Revive: Error';
      statusBarItem.tooltip = 'ReviveDualDebugger — Node error (click for trace)';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
  }
}
