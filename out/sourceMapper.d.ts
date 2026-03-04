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
import { SourceLocation } from './backendConnector';
export interface SourceMapEntry {
    start: number;
    length: number;
    fileIndex: number;
    jumpType: 'i' | 'o' | '-';
    modifierDepth?: number;
}
export interface CompiledArtifact {
    abi: unknown[];
    bytecode: string;
    deployedBytecode: string;
    sourceMap: string;
    deployedSourceMap: string;
    generatedSources?: GeneratedSource[];
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
export declare class SourceMapper {
    /** Map from file index → absolute path */
    private fileIndex;
    /** Parsed source map entries (deployed bytecode) */
    private deployedEntries;
    /** Source map entries (constructor bytecode) */
    private constructorEntries;
    /** Raw source content cache */
    private sourceCache;
    loadFromArtifact(artifact: CompiledArtifact, sourceFiles: Map<number, string>): void;
    loadSourceFile(fileIndex: number, filePath: string): void;
    /**
     * Map an EVM program counter (bytecode index) to a Solidity source location.
     * Uses the deployed bytecode source map.
     */
    pcToSourceLocation(pc: number): SourceLocation | undefined;
    /**
     * Map a constructor bytecode PC to a source location.
     */
    constructorPcToSourceLocation(pc: number): SourceLocation | undefined;
    /**
     * Map a Solidity source file + line number to the nearest bytecode PC.
     * Used for setting breakpoints.
     */
    lineToNearestPc(filePath: string, lineNumber: number): number | undefined;
    private byteOffsetToLocation;
    private getOrLoadLines;
    private getFileIndex;
}
/**
 * Parse solc-encoded source map string into an array of SourceMapEntry,
 * one per bytecode instruction index.
 *
 * Format: "s:l:f:j[;s:l:f:j...]"
 * Missing fields inherit from the previous entry.
 */
export declare function parseSourceMap(encoded: string): SourceMapEntry[];
/** Load a solc/resolc JSON artifact file from disk. */
export declare function loadArtifact(artifactPath: string): CompiledArtifact | null;
//# sourceMappingURL=sourceMapper.d.ts.map