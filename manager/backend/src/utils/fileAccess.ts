/**
 * File Access Utilities
 */

import * as fs from 'fs';
import path from 'path';
import { config } from '../config.js';

/**
 * Server root path for direct fs access.
 * Dev: host path (bind mount source). Prod: path in manager container where volume is mounted.
 */
function getServerRoot(): string {
  return (config.gameDataPath ?? process.env.GAME_SERVER_DATA_PATH);
}

/**
 * Subdirectory names relative to server root (same layout as container).
 */
const BASE_PATH_SUBDIRS: Record<ContainerBasePath, string> = {
  server: '',
  backups: 'backups',
  mods: 'mods',
  assets: 'assets',
};

/**
 * Base path types for server file access (same API as before).
 */
export type ContainerBasePath = 'server' | 'backups' | 'mods' | 'assets';

/**
 * Resolve filePath + basePath to a local filesystem path under server root.
 * Rejects path traversal outside server root.
 */
function resolveToLocalPath(
  filePath: string,
  basePath: ContainerBasePath
): string {
  const serverRoot = getServerRoot();
  const containerBase = (config.hytaleContainerServerPath || '/opt/hytale/server').replace(/\\/g, '/');
  const normalizedInput = filePath.replace(/\\/g, '/').trim();

  let relative: string;
  if (normalizedInput.startsWith(containerBase)) {
    relative = normalizedInput.slice(containerBase.length).replace(/^\//, '') || '.';
  } else if (normalizedInput.startsWith('/')) {
    relative = normalizedInput.replace(/^\//, '');
  } else {
    const subdir = BASE_PATH_SUBDIRS[basePath];
    relative = subdir ? path.join(subdir, filePath) : filePath;
  }

  const resolved = path.resolve(serverRoot, relative);
  const rootResolved = path.resolve(serverRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

/**
 * Sanitize file content read from disk (BOM, control chars, etc.)
 */
function sanitizeFileContent(content: string): string {
  if (typeof content !== 'string') return '';
  if (content.length === 0) return content;

  let cleaned = content;
  if (cleaned.charCodeAt(0) === 0xfffd) cleaned = cleaned.substring(1);
  if (cleaned.charCodeAt(0) === 0xfeff) cleaned = cleaned.substring(1);
  cleaned = cleaned.replace(/[\u200b-\u200d\u00ad]/g, '');
  cleaned = cleaned.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, '');
  if (cleaned.length > 0) cleaned = cleaned.trim();
  return cleaned;
}

/**
 * Read directory contents (direct fs).
 *
 * @param filePath - Path relative to basePath, or absolute container path
 * @param basePath - Base path type if filePath is relative (default: 'server')
 */
export async function readServerDir(
  filePath: string,
  basePath: ContainerBasePath = 'server'
): Promise<string[]> {
  const localPath = resolveToLocalPath(filePath, basePath);
  try {
    const entries = await fs.promises.readdir(localPath);
    return entries.filter((n) => n.length > 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

/**
 * Read file content (direct fs).
 *
 * @param filePath - Path relative to basePath, or absolute container path
 * @param basePath - Base path type if filePath is relative (default: 'server')
 */
export async function readServerFile(
  filePath: string,
  basePath: ContainerBasePath = 'server'
): Promise<string> {
  const localPath = resolveToLocalPath(filePath, basePath);
  const raw = await fs.promises.readFile(localPath, 'utf-8');
  return sanitizeFileContent(raw);
}

/**
 * Write file content (direct fs).
 *
 * @param filePath - Path relative to basePath, or absolute container path
 * @param content - File content to write
 * @param basePath - Base path type if filePath is relative (default: 'server')
 */
export async function writeServerFile(
  filePath: string,
  content: string,
  basePath: ContainerBasePath = 'server'
): Promise<void> {
  const localPath = resolveToLocalPath(filePath, basePath);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fs.promises.writeFile(localPath, content, 'utf-8');
}

/**
 * Get file stats (direct fs).
 *
 * @param filePath - Path relative to basePath, or absolute container path
 * @param basePath - Base path type if filePath is relative (default: 'server')
 */
export async function getServerFileStats(
  filePath: string,
  basePath: ContainerBasePath = 'server'
): Promise<{ size: number; modified: Date } | null> {
  const localPath = resolveToLocalPath(filePath, basePath);
  try {
    const stat = await fs.promises.stat(localPath);
    return { size: stat.size, modified: stat.mtime };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}
