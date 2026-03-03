/**
 * DualTracePanel — VS Code WebviewPanel showing the REVM opcode trace
 * side-by-side with the PVM syscall trace, plus the Weight Meter dashboard.
 *
 * Updates in real-time as the debug session advances.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExecutionMetrics, OpcodeStep, SyscallStep } from '../backendConnector';
import { WeightMeter, MetricsSnapshot } from '../weightMeter';

// ─── Message Types (Extension ↔ Webview) ──────────────────────────────────────

export type WebviewMessage =
  | { type: 'updateRevm'; trace: SerializableOpcodeStep[]; metrics: SerializableMetrics }
  | { type: 'updatePvm'; trace: SerializableSyscallStep[]; metrics: SerializableMetrics }
  | { type: 'updateSnapshot'; snapshot: SerializableSnapshot }
  | { type: 'clearTraces' }
  | { type: 'setBackend'; backend: string }
  | { type: 'highlight'; backend: 'revm' | 'pvm'; index: number };

// Serializable versions (bigint → string)
interface SerializableOpcodeStep {
  pc: number;
  op: string;
  gasCost: string;
  gasRemaining: string;
  depth: number;
  stack: string[];
  file?: string;
  line?: number;
}

interface SerializableSyscallStep {
  address: string;
  name: string;
  args: string;
  result?: string;
  isEntry: boolean;
  file?: string;
  line?: number;
}

interface SerializableMetrics {
  gasUsed: string;
  gasLimit: string;
  refTime: string;
  proofSize: string;
  storageDeposit: string;
}

interface SerializableSnapshot {
  gasUsed: string;
  gasPercent: number;
  refTime: string;
  proofSize: string;
  refTimePercent: number;
  proofSizePercent: number;
  storageDeposit: string;
  estimatedFee: string;
  warnings: string[];
  verdict?: string;
}

// ─── DualTracePanel ───────────────────────────────────────────────────────────

export class DualTracePanel {
  private static instance: DualTracePanel | undefined;
  private panel: vscode.WebviewPanel;
  private weightMeter: WeightMeter;
  private extensionUri: vscode.Uri;

  // Trace state
  private revmTrace: OpcodeStep[] = [];
  private pvmTrace: SyscallStep[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    weightMeter: WeightMeter,
    extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.weightMeter = weightMeter;
    this.extensionUri = extensionUri;

    panel.onDidDispose(() => {
      DualTracePanel.instance = undefined;
    });

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage((message: { command: string; data?: unknown }) => {
      switch (message.command) {
        case 'jumpToSource':
          this.handleJumpToSource(message.data as { file: string; line: number });
          break;
        case 'copyTrace':
          this.handleCopyTrace(message.data as { backend: string });
          break;
      }
    });
  }

  // ─── Static Factory ────────────────────────────────────────────────────────

  static createOrShow(
    extensionUri: vscode.Uri,
    weightMeter: WeightMeter
  ): DualTracePanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DualTracePanel.instance) {
      DualTracePanel.instance.panel.reveal(column);
      return DualTracePanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      'reviveDualTrace',
      'Revive Dual-VM Trace',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    DualTracePanel.instance = new DualTracePanel(panel, weightMeter, extensionUri);
    panel.webview.html = DualTracePanel.instance.getHtml();
    return DualTracePanel.instance;
  }

  static getInstance(): DualTracePanel | undefined {
    return DualTracePanel.instance;
  }

  // ─── Public Update Methods ─────────────────────────────────────────────────

  updateRevmTrace(metrics: ExecutionMetrics): void {
    if (!metrics.opcodeTrace) return;
    this.revmTrace = metrics.opcodeTrace;
    const msg: WebviewMessage = {
      type: 'updateRevm',
      trace: this.revmTrace.map(s => ({
        pc: s.pc,
        op: s.op,
        gasCost: s.gasCost.toString(),
        gasRemaining: s.gasRemaining.toString(),
        depth: s.depth,
        stack: s.stack.slice(0, 8),  // top 8 items
        file: s.sourceLocation?.file,
        line: s.sourceLocation?.line
      })),
      metrics: this.serializeMetrics(metrics)
    };
    this.postMessage(msg);
    this.sendSnapshot();
  }

  updatePvmTrace(metrics: ExecutionMetrics): void {
    if (!metrics.syscallTrace) return;
    this.pvmTrace = metrics.syscallTrace;
    const msg: WebviewMessage = {
      type: 'updatePvm',
      trace: this.pvmTrace.map(s => ({
        address: s.address,
        name: s.name,
        args: s.args.slice(0, 200),
        result: s.result,
        isEntry: s.isEntry,
        file: s.sourceLocation?.file,
        line: s.sourceLocation?.line
      })),
      metrics: this.serializeMetrics(metrics)
    };
    this.postMessage(msg);
    this.sendSnapshot();
  }

  clear(): void {
    this.revmTrace = [];
    this.pvmTrace = [];
    this.postMessage({ type: 'clearTraces' });
  }

  highlightStep(backend: 'revm' | 'pvm', index: number): void {
    this.postMessage({ type: 'highlight', backend, index });
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private sendSnapshot(): void {
    const snap = this.weightMeter.getSnapshot();
    const report = this.weightMeter.generateComparisonReport();
    const msg: WebviewMessage = {
      type: 'updateSnapshot',
      snapshot: {
        gasUsed: snap.formatted.gasUsed,
        gasPercent: snap.gasPercent,
        refTime: snap.formatted.refTime,
        proofSize: snap.formatted.proofSize,
        refTimePercent: snap.refTimePercent,
        proofSizePercent: snap.proofSizePercent,
        storageDeposit: snap.formatted.storageDeposit,
        estimatedFee: snap.formatted.estimatedFee,
        warnings: report.warnings,
        verdict: report.verdict
      }
    };
    this.postMessage(msg);
  }

  private serializeMetrics(m: ExecutionMetrics): SerializableMetrics {
    return {
      gasUsed: (m.gasUsed ?? 0n).toString(),
      gasLimit: (m.gasLimit ?? 0n).toString(),
      refTime: (m.refTime ?? 0n).toString(),
      proofSize: (m.proofSize ?? 0n).toString(),
      storageDeposit: (m.storageDeposit ?? 0n).toString()
    };
  }

  private postMessage(msg: WebviewMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private handleJumpToSource(data: { file: string; line: number }): void {
    if (!data.file) return;
    const uri = vscode.Uri.file(data.file);
    vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(data.line - 1, 0, data.line - 1, 0)
    });
  }

  private handleCopyTrace(data: { backend: string }): void {
    const trace = data.backend === 'revm'
      ? this.revmTrace.map(s => `${s.op} @ PC:${s.pc} (gas: ${s.gasCost})`).join('\n')
      : this.pvmTrace.map(s => `${s.isEntry ? '→' : '←'} ${s.name}(${s.args})`).join('\n');
    vscode.env.clipboard.writeText(trace);
    vscode.window.showInformationMessage(`${data.backend.toUpperCase()} trace copied to clipboard`);
  }

  // ─── HTML Generation ───────────────────────────────────────────────────────

  private getHtml(): string {
    // Try to load from file, fall back to inline
    const htmlPath = path.join(
      this.extensionUri.fsPath, 'src', 'webview', 'dualTrace.html'
    );
    if (fs.existsSync(htmlPath)) {
      return fs.readFileSync(htmlPath, 'utf8');
    }
    return this.getInlineHtml();
  }

  private getInlineHtml(): string {
    return getDualTraceHtml();
  }

  dispose(): void {
    this.panel.dispose();
    DualTracePanel.instance = undefined;
  }
}

// ─── Inline HTML (fallback) ───────────────────────────────────────────────────

export function getDualTraceHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Revive Dual-VM Trace</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Header ─────────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      background: var(--vscode-titleBar-activeBackground, #2d2d2d);
      border-bottom: 1px solid var(--vscode-panel-border, #404040);
      gap: 12px;
      flex-shrink: 0;
    }
    .header h1 {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-titleBar-activeForeground, #ccc);
    }
    .badge {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-revm { background: #1a4080; color: #7ec8ff; }
    .badge-pvm  { background: #3d1a4a; color: #c47eff; }

    /* ── Metrics Bar ─────────────────────────── */
    .metrics-bar {
      display: flex;
      gap: 16px;
      padding: 6px 12px;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #404040);
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .metric-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 100px;
    }
    .metric-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground, #888);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .metric-value {
      font-size: 13px;
      font-weight: 600;
    }
    .metric-value.revm { color: #7ec8ff; }
    .metric-value.pvm  { color: #c47eff; }
    .progress-wrap {
      height: 3px;
      background: var(--vscode-progressBar-background, #333);
      border-radius: 2px;
      margin-top: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .progress-fill.revm { background: #7ec8ff; }
    .progress-fill.pvm  { background: #c47eff; }
    .progress-fill.warn { background: #f0c040; }
    .progress-fill.danger { background: #f04040; }

    /* ── Main split layout ───────────────────── */
    .main {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1px;
      flex: 1;
      overflow: hidden;
      background: var(--vscode-panel-border, #404040);
    }
    .pane {
      display: flex;
      flex-direction: column;
      background: var(--vscode-editor-background, #1e1e1e);
      overflow: hidden;
    }
    .pane-header {
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      border-bottom: 1px solid var(--vscode-panel-border, #404040);
      flex-shrink: 0;
    }
    .pane-header.revm {
      background: #152035;
      color: #7ec8ff;
      border-left: 3px solid #7ec8ff;
    }
    .pane-header.pvm {
      background: #1e0f2a;
      color: #c47eff;
      border-left: 3px solid #c47eff;
    }
    .pane-body {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }

    /* ── Trace Rows ──────────────────────────── */
    .trace-row {
      display: grid;
      padding: 3px 12px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.1s;
      align-items: center;
    }
    .trace-row.revm { grid-template-columns: 60px 80px 80px 1fr; }
    .trace-row.pvm  { grid-template-columns: 20px 120px 1fr; }
    .trace-row:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .trace-row.active {
      background: var(--vscode-list-activeSelectionBackground, #094771);
      border-left-color: #7ec8ff;
    }
    .trace-row.pvm.entry  { border-left-color: transparent; }
    .trace-row.pvm.exit   { opacity: 0.7; }
    .trace-row.pvm.active { border-left-color: #c47eff; }

    .col-pc     { color: var(--vscode-descriptionForeground, #888); font-size: 11px; }
    .col-op     { color: #dcdcaa; font-weight: 600; }
    .col-gas    { color: #b5cea8; font-size: 11px; text-align: right; }
    .col-stack  { color: #9cdcfe; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .col-dir    { color: var(--vscode-descriptionForeground, #888); }
    .col-name   { color: #dcdcaa; font-weight: 600; }
    .col-args   { color: #9cdcfe; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .col-result-ok  { color: #4ec9b0; font-size: 11px; }
    .col-result-err { color: #f44747; font-size: 11px; }
    .source-hint { color: var(--vscode-descriptionForeground, #555); font-size: 10px; margin-left: 4px; }

    /* ── Verdict Bar ─────────────────────────── */
    .verdict-bar {
      padding: 6px 12px;
      background: var(--vscode-editorWidget-background, #252526);
      border-top: 1px solid var(--vscode-panel-border, #404040);
      font-size: 11px;
      flex-shrink: 0;
    }
    .verdict-bar.warn { color: #f0c040; }
    .verdict-bar.ok   { color: #4ec9b0; }

    /* ── Empty State ─────────────────────────── */
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground, #888);
      font-size: 12px;
      text-align: center;
      padding: 20px;
    }

    /* ── Scrollbar ───────────────────────────── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #777; }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <h1>ReviveDualDebugger</h1>
    <span class="badge badge-revm">REVM</span>
    <span class="badge badge-pvm">PolkaVM</span>
    <span id="status" style="margin-left:auto;font-size:11px;color:#888;">Waiting for debug session...</span>
  </div>

  <!-- Metrics Bar -->
  <div class="metrics-bar">
    <div class="metric-item">
      <div class="metric-label">EVM Gas Used</div>
      <div class="metric-value revm" id="m-gas-used">—</div>
      <div class="progress-wrap">
        <div class="progress-fill revm" id="p-gas" style="width:0%"></div>
      </div>
    </div>
    <div class="metric-item">
      <div class="metric-label">EVM Gas Limit</div>
      <div class="metric-value revm" id="m-gas-limit">—</div>
    </div>
    <div class="metric-item">
      <div class="metric-label">PVM ref_time</div>
      <div class="metric-value pvm" id="m-ref-time">—</div>
      <div class="progress-wrap">
        <div class="progress-fill pvm" id="p-ref-time" style="width:0%"></div>
      </div>
    </div>
    <div class="metric-item">
      <div class="metric-label">PVM proof_size</div>
      <div class="metric-value pvm" id="m-proof-size">—</div>
      <div class="progress-wrap">
        <div class="progress-fill pvm" id="p-proof-size" style="width:0%"></div>
      </div>
    </div>
    <div class="metric-item">
      <div class="metric-label">Storage Deposit</div>
      <div class="metric-value pvm" id="m-storage">—</div>
    </div>
    <div class="metric-item">
      <div class="metric-label">Est. Fee</div>
      <div class="metric-value pvm" id="m-fee">—</div>
    </div>
  </div>

  <!-- Split Panes -->
  <div class="main">
    <!-- REVM Pane -->
    <div class="pane">
      <div class="pane-header revm">REVM — EVM Opcodes</div>
      <div class="pane-body" id="revm-body">
        <div class="empty-state">Start a debug session to see EVM opcode trace</div>
      </div>
    </div>

    <!-- PVM Pane -->
    <div class="pane">
      <div class="pane-header pvm">PolkaVM — Host Function Syscalls</div>
      <div class="pane-body" id="pvm-body">
        <div class="empty-state">Start a debug session to see PVM syscall trace</div>
      </div>
    </div>
  </div>

  <!-- Verdict Bar -->
  <div class="verdict-bar ok" id="verdict-bar">Ready</div>

  <script>
    const vscode = acquireVsCodeApi();
    let revmTrace = [], pvmTrace = [];
    let activeRevmIdx = -1, activePvmIdx = -1;

    // ── Message Handler ──────────────────────────────────────────────────────
    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'updateRevm':
          revmTrace = msg.trace;
          renderRevmTrace();
          updateMetrics(msg.metrics, null);
          setStatus('Tracing REVM...');
          break;
        case 'updatePvm':
          pvmTrace = msg.trace;
          renderPvmTrace();
          updateMetrics(null, msg.metrics);
          setStatus('Tracing PVM...');
          break;
        case 'updateSnapshot':
          renderSnapshot(msg.snapshot);
          break;
        case 'clearTraces':
          revmTrace = []; pvmTrace = [];
          renderRevmTrace(); renderPvmTrace();
          setStatus('Cleared');
          break;
        case 'highlight':
          if (msg.backend === 'revm') { activeRevmIdx = msg.index; renderRevmTrace(); }
          else { activePvmIdx = msg.index; renderPvmTrace(); }
          break;
      }
    });

    // ── Render REVM ──────────────────────────────────────────────────────────
    function renderRevmTrace() {
      const body = document.getElementById('revm-body');
      if (revmTrace.length === 0) {
        body.innerHTML = '<div class="empty-state">No REVM trace data</div>';
        return;
      }
      body.innerHTML = revmTrace.map((s, i) => {
        const active = i === activeRevmIdx ? ' active' : '';
        const stackTop = s.stack.length > 0 ? s.stack[s.stack.length - 1].slice(-16) : '';
        const srcHint = s.line ? \`<span class="source-hint">:\${s.line}</span>\` : '';
        return \`<div class="trace-row revm\${active}" onclick="rowClick('revm', \${i}, '\${escHtml(s.file||'')}', \${s.line||0})">
          <span class="col-pc">\${s.pc}</span>
          <span class="col-op">\${escHtml(s.op)}\${srcHint}</span>
          <span class="col-gas">\${s.gasCost}</span>
          <span class="col-stack">\${stackTop ? '▲ ' + stackTop : ''}</span>
        </div>\`;
      }).join('');
      if (activeRevmIdx >= 0) scrollTo('revm-body', activeRevmIdx);
    }

    // ── Render PVM ───────────────────────────────────────────────────────────
    function renderPvmTrace() {
      const body = document.getElementById('pvm-body');
      if (pvmTrace.length === 0) {
        body.innerHTML = '<div class="empty-state">No PVM trace data</div>';
        return;
      }
      body.innerHTML = pvmTrace.map((s, i) => {
        const active = i === activePvmIdx ? ' active' : '';
        const exitClass = !s.isEntry ? ' exit' : ' entry';
        const dir = s.isEntry ? '→' : '←';
        const resultClass = s.result && s.result.startsWith('Ok') ? 'col-result-ok' : 'col-result-err';
        const srcHint = s.line ? \`<span class="source-hint">:\${s.line}</span>\` : '';
        const argsShort = (s.args || '').slice(0, 60) + ((s.args||'').length > 60 ? '…' : '');
        return \`<div class="trace-row pvm\${exitClass}\${active}" onclick="rowClick('pvm', \${i}, '\${escHtml(s.file||'')}', \${s.line||0})">
          <span class="col-dir">\${dir}</span>
          <span class="col-name">\${escHtml(s.name)}\${srcHint}</span>
          <span class="\${s.result ? resultClass : 'col-args'}">\${escHtml(s.result || argsShort)}</span>
        </div>\`;
      }).join('');
      if (activePvmIdx >= 0) scrollTo('pvm-body', activePvmIdx);
    }

    // ── Metrics ──────────────────────────────────────────────────────────────
    function updateMetrics(evm, pvm) {
      if (evm) {
        setText('m-gas-used', formatBig(evm.gasUsed));
        setText('m-gas-limit', formatBig(evm.gasLimit));
      }
      if (pvm) {
        setText('m-ref-time', formatWeight(BigInt(pvm.refTime)));
        setText('m-proof-size', formatWeight(BigInt(pvm.proofSize)));
        setText('m-storage', formatWeight(BigInt(pvm.storageDeposit)));
      }
    }

    function renderSnapshot(s) {
      setBar('p-gas', s.gasPercent);
      setBar('p-ref-time', s.refTimePercent);
      setBar('p-proof-size', s.proofSizePercent);
      if (s.estimatedFee) setText('m-fee', s.estimatedFee);

      const verdictBar = document.getElementById('verdict-bar');
      if (s.warnings && s.warnings.length > 0) {
        verdictBar.className = 'verdict-bar warn';
        verdictBar.textContent = '⚠ ' + s.warnings[0];
      } else if (s.verdict) {
        verdictBar.className = 'verdict-bar ok';
        verdictBar.textContent = s.verdict;
      }
    }

    function setBar(id, pct) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.width = Math.min(100, pct) + '%';
      el.className = 'progress-fill ' +
        (id.includes('gas') ? 'revm' : 'pvm') +
        (pct > 80 ? ' danger' : pct > 50 ? ' warn' : '');
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function rowClick(backend, idx, file, line) {
      if (backend === 'revm') activeRevmIdx = idx;
      else activePvmIdx = idx;
      if (file && line) {
        vscode.postMessage({ command: 'jumpToSource', data: { file, line } });
      }
      if (backend === 'revm') renderRevmTrace();
      else renderPvmTrace();
    }

    function scrollTo(containerId, idx) {
      const container = document.getElementById(containerId);
      const rows = container.querySelectorAll('.trace-row');
      if (rows[idx]) {
        rows[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function setText(id, val) {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    }

    function setStatus(msg) {
      setText('status', msg);
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function formatBig(n) {
      const v = BigInt(n || 0);
      if (v < 1000n) return v.toString();
      if (v < 1_000_000n) return (Number(v)/1000).toFixed(1) + 'K';
      return (Number(v)/1_000_000).toFixed(2) + 'M';
    }

    function formatWeight(n) {
      if (n === 0n) return '0';
      if (n < 1_000n) return n.toString() + ' ps';
      if (n < 1_000_000n) return (Number(n)/1_000).toFixed(2) + ' ns';
      if (n < 1_000_000_000n) return (Number(n)/1_000_000).toFixed(2) + ' μs';
      return (Number(n)/1_000_000_000).toFixed(2) + ' ms';
    }
  </script>
</body>
</html>`;
}
