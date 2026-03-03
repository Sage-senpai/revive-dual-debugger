/**
 * SourceMapper — maps EVM bytecode offsets and PVM syscall indices back to
 * Solidity source file locations using compiler-generated source maps.
 *
 * solc source map format:
 *   "s:l:f:j;s:l:f:j;..."
 *   s = byte offset in source, l = length, f = file index, j = jump type (i/o/-)
 *
 * resolc/LLVM source maps follow DWARF conventions for RISC-V; we approximate
 * via the EVM source map when a direct RISC-V DWARF map is unavailable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SourceLocation } from './backendConnector';

// ─── solc Source Map ──────────────────────────────────────────────────────────

export interface SourceMapEntry {
  start: number;    // byte offset in source
  length: number;   // length in bytes
  fileIndex: number;
  jumpType: 'i' | 'o' | '-';  // into/out of/regular
  modifierDepth?: number;
}

export interface CompiledArtifact {
  abi: unknown[];
  bytecode: string;        // hex, no 0x prefix
  deployedBytecode: string;
  sourceMap: string;        // solc encoded source map
  deployedSourceMap: string;
  generatedSources?: GeneratedSource[];
  // resolc additions
  pvmBytecode?: string;
  pvmSourceMap?: string;
}

export interface GeneratedSource {
  ast: unknown;
  contents: string;
  id: number;
  language: string;
  name: string;
}

// ─── Source File Registry ─────────────────────────────────────────────────────

export class SourceMapper {
  /** Map from file index → absolute path */
  private fileIndex: Map<number, string> = new Map();

  /** Parsed source map entries (deployed bytecode) */
  private deployedEntries: SourceMapEntry[] = [];

  /** Source map entries (constructor bytecode) */
  private constructorEntries: SourceMapEntry[] = [];

  /** Raw source content cache */
  private sourceCache: Map<string, string[]> = new Map();

  // ─── Load ──────────────────────────────────────────────────────────────────

  loadFromArtifact(artifact: CompiledArtifact, sourceFiles: Map<number, string>): void {
    this.fileIndex = new Map(sourceFiles);
    this.deployedEntries = parseSourceMap(artifact.deployedSourceMap);
    this.constructorEntries = parseSourceMap(artifact.sourceMap);
  }

  loadSourceFile(fileIndex: number, filePath: string): void {
    this.fileIndex.set(fileIndex, filePath);
    if (!this.sourceCache.has(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        this.sourceCache.set(filePath, content.split('\n'));
      } catch {
        // file not readable, skip
      }
    }
  }

  // ─── Map EVM PC → Source Location ─────────────────────────────────────────

  /**
   * Map an EVM program counter (bytecode index) to a Solidity source location.
   * Uses the deployed bytecode source map.
   */
  pcToSourceLocation(pc: number): SourceLocation | undefined {
    if (pc < 0 || pc >= this.deployedEntries.length) {
      return undefined;
    }
    const entry = this.deployedEntries[pc];
    if (!entry || entry.fileIndex === -1) {
      return undefined;
    }
    const filePath = this.fileIndex.get(entry.fileIndex);
    if (!filePath) {
      return undefined;
    }
    return this.byteOffsetToLocation(filePath, entry.start, entry.length);
  }

  /**
   * Map a constructor bytecode PC to a source location.
   */
  constructorPcToSourceLocation(pc: number): SourceLocation | undefined {
    if (pc < 0 || pc >= this.constructorEntries.length) {
      return undefined;
    }
    const entry = this.constructorEntries[pc];
    if (!entry || entry.fileIndex === -1) {
      return undefined;
    }
    const filePath = this.fileIndex.get(entry.fileIndex);
    if (!filePath) {
      return undefined;
    }
    return this.byteOffsetToLocation(filePath, entry.start, entry.length);
  }

  /**
   * Map a Solidity source file + line number to the nearest bytecode PC.
   * Used for setting breakpoints.
   */
  lineToNearestPc(filePath: string, lineNumber: number): number | undefined {
    const fileIdx = this.getFileIndex(filePath);
    if (fileIdx === undefined) {
      return undefined;
    }
    const lines = this.sourceCache.get(filePath);
    if (!lines) {
      return undefined;
    }

    // Calculate byte offset for the given line
    let byteOffset = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      byteOffset += lines[i].length + 1; // +1 for newline
    }

    // Find the nearest source map entry
    let bestPc = -1;
    let bestDist = Infinity;
    for (let pc = 0; pc < this.deployedEntries.length; pc++) {
      const entry = this.deployedEntries[pc];
      if (entry.fileIndex !== fileIdx) {
        continue;
      }
      const dist = Math.abs(entry.start - byteOffset);
      if (dist < bestDist) {
        bestDist = dist;
        bestPc = pc;
      }
    }
    return bestPc >= 0 ? bestPc : undefined;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private byteOffsetToLocation(
    filePath: string,
    byteOffset: number,
    length: number
  ): SourceLocation {
    const lines = this.getOrLoadLines(filePath);
    let remaining = byteOffset;
    let lineNum = 1;
    let col = 0;

    for (const line of lines) {
      const lineLen = line.length + 1; // +1 for \n
      if (remaining < lineLen) {
        col = remaining;
        break;
      }
      remaining -= lineLen;
      lineNum++;
    }

    return { file: filePath, line: lineNum, column: col, length };
  }

  private getOrLoadLines(filePath: string): string[] {
    if (!this.sourceCache.has(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        this.sourceCache.set(filePath, content.split('\n'));
      } catch {
        this.sourceCache.set(filePath, []);
      }
    }
    return this.sourceCache.get(filePath) ?? [];
  }

  private getFileIndex(filePath: string): number | undefined {
    for (const [idx, fp] of this.fileIndex.entries()) {
      if (path.resolve(fp) === path.resolve(filePath)) {
        return idx;
      }
    }
    return undefined;
  }
}

// ─── Source Map Parser ────────────────────────────────────────────────────────

/**
 * Parse solc-encoded source map string into an array of SourceMapEntry,
 * one per bytecode instruction index.
 *
 * Format: "s:l:f:j[;s:l:f:j...]"
 * Missing fields inherit from the previous entry.
 */
export function parseSourceMap(encoded: string): SourceMapEntry[] {
  if (!encoded) {
    return [];
  }

  const entries: SourceMapEntry[] = [];
  const segments = encoded.split(';');

  let prevStart = 0;
  let prevLength = 0;
  let prevFileIndex = -1;
  let prevJumpType: 'i' | 'o' | '-' = '-';

  for (const segment of segments) {
    const parts = segment.split(':');

    const start = parts[0] ? parseInt(parts[0], 10) : prevStart;
    const length = parts[1] ? parseInt(parts[1], 10) : prevLength;
    const fileIndex = parts[2] ? parseInt(parts[2], 10) : prevFileIndex;
    const rawJump = parts[3] ?? '';
    const jumpType: 'i' | 'o' | '-' =
      rawJump === 'i' ? 'i' : rawJump === 'o' ? 'o' : '-';

    const entry: SourceMapEntry = {
      start: isNaN(start) ? prevStart : start,
      length: isNaN(length) ? prevLength : length,
      fileIndex: isNaN(fileIndex) ? prevFileIndex : fileIndex,
      jumpType
    };

    entries.push(entry);

    prevStart = entry.start;
    prevLength = entry.length;
    prevFileIndex = entry.fileIndex;
    prevJumpType = entry.jumpType;
  }

  return entries;
}

/** Load a solc/resolc JSON artifact file from disk. */
export function loadArtifact(artifactPath: string): CompiledArtifact | null {
  try {
    const raw = fs.readFileSync(artifactPath, 'utf8');
    return JSON.parse(raw) as CompiledArtifact;
  } catch {
    return null;
  }
}
