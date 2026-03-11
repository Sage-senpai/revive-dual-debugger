/**
 * binaryResolver.ts — resolves paths to external binaries.
 *
 * Resolution order:
 *   1. User-provided path (if absolute or explicitly set)
 *   2. Bundled binary in extension's bin/<platform>/ directory
 *   3. Fall back to the bare name (relies on system PATH)
 */

import * as fs from 'fs';
import * as path from 'path';

/** Platform subfolder matching Node's process.platform */
type Platform = 'linux' | 'darwin' | 'win32';

/** Map of bare binary names to their actual filenames per platform */
const BINARY_NAMES: Record<string, Record<Platform, string>> = {
  'revive-dev-node': {
    linux: 'revive-dev-node',
    darwin: 'revive-dev-node',
    win32: 'revive-dev-node.exe'
  },
  'eth-rpc': {
    linux: 'eth-rpc',
    darwin: 'eth-rpc',
    win32: 'eth-rpc.exe'
  },
  'solc': {
    linux: 'solc',
    darwin: 'solc',
    win32: 'solc.exe'
  },
  'resolc': {
    linux: 'resolc',
    darwin: 'resolc',
    win32: 'resolc.exe'
  }
};

/**
 * Resolve a binary path with bundled-binary fallback.
 *
 * @param name       Bare binary name (e.g. "revive-dev-node", "eth-rpc")
 * @param userPath   User-configured path from settings/launch config
 * @param extensionDir  Root directory of the extension (extensionPath or __dirname parent)
 * @returns Resolved path — either the bundled binary or the original userPath/name
 */
export function resolveBinaryPath(
  name: string,
  userPath: string | undefined,
  extensionDir: string
): string {
  // If user provided an absolute path, trust it
  if (userPath && path.isAbsolute(userPath)) {
    return userPath;
  }

  // Try bundled binary: bin/<platform>/<binaryName>
  const platform = process.platform as Platform;
  const binEntry = BINARY_NAMES[name];
  if (binEntry && binEntry[platform]) {
    const bundled = path.join(extensionDir, 'bin', platform, binEntry[platform]);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }

  // Fall back to user path or bare name (system PATH)
  return userPath || name;
}
