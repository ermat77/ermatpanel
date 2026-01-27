/**
 * File Access Utilities
 * 
 * Unified file access - always uses Docker API to access files in the Hytale server container.
 * The Hytale server is ALWAYS in Docker, regardless of whether the backend is local or containerized.
 * 
 * Always use container paths (HYTALE_CONTAINER_*_PATH) when accessing files via Docker API.
 */

import path from 'path';
import { config } from '../config.js';
import * as dockerService from '../services/docker.js';

/**
 * Sanitize file content read from Docker
 * Removes BOM, control characters, and other problematic characters that Docker streams may add
 */
function sanitizeFileContent(content: string): string {
  if (typeof content !== 'string') {
    return '';
  }

  // If content is empty, return as-is
  if (content.length === 0) {
    return content;
  }

  let cleaned = content;

  // Remove replacement character (U+FFFD) only if it's at the very beginning
  // This character appears when Docker has encoding issues
  if (cleaned.charCodeAt(0) === 0xFFFD) {
    cleaned = cleaned.substring(1);
  }

  // Remove BOM (Byte Order Mark) - U+FEFF, only at the start
  if (cleaned.charCodeAt(0) === 0xFEFF) {
    cleaned = cleaned.substring(1);
  }

  // Remove other problematic Unicode characters (zero-width characters, invisible formatting)
  // But be careful - only remove these specific characters, not all non-printable
  cleaned = cleaned.replace(/[\u200B-\u200D\u00AD]/g, '');

  // Remove control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');

  // Only trim if there's actual content - don't remove all whitespace if that's the content
  // But we should still remove leading/trailing whitespace for JSON/text files
  if (cleaned.length > 0) {
    cleaned = cleaned.trim();
  }

  return cleaned;
}

/**
 * Base path types for container file access
 */
export type ContainerBasePath = 'server' | 'data' | 'backups' | 'mods' | 'assets';

/**
 * Get the container base path for a given type
 */
function getContainerBasePath(basePath: ContainerBasePath): string {
  const basePathMap: Record<ContainerBasePath, string> = {
    server: config.hytaleContainerServerPath,
    data: config.hytaleContainerDataPath,
    backups: config.hytaleContainerBackupsPath,
    mods: config.hytaleContainerModsPath,
    assets: config.hytaleContainerAssetsPath,
  };
  return basePathMap[basePath];
}

/**
 * Read directory contents from container
 * Always uses Docker API with container paths
 * 
 * @param filePath - Container path (absolute starting with /) or relative path
 * @param basePath - Base path type if filePath is relative (default: 'data')
 */
export async function readServerDir(
  filePath: string,
  basePath: ContainerBasePath = 'data'
): Promise<string[]> {
  // If path is absolute (starts with /), use it directly as container path
  // Otherwise, treat as relative to basePath
  const containerPath = filePath.startsWith('/')
    ? filePath
    : path.posix.join(getContainerBasePath(basePath), filePath);
  return await dockerService.readContainerDir(containerPath);
}

/**
 * Read file content from container
 * Always uses Docker API with container paths
 * 
 * @param filePath - Container path (absolute starting with /) or relative path
 * @param basePath - Base path type if filePath is relative (default: 'data')
 */
export async function readServerFile(
  filePath: string,
  basePath: ContainerBasePath = 'data'
): Promise<string> {
  // If path is absolute (starts with /), use it directly as container path
  // Otherwise, treat as relative to basePath
  const containerPath = filePath.startsWith('/')
    ? filePath
    : path.posix.join(getContainerBasePath(basePath), filePath);
  const rawContent = await dockerService.readContainerFile(containerPath);
  const sanitized = sanitizeFileContent(rawContent);
  return sanitized;
}

/**
 * Write file content to container
 * Always uses Docker API with container paths
 * 
 * @param filePath - Container path (absolute starting with /) or relative path
 * @param content - File content to write
 * @param basePath - Base path type if filePath is relative (default: 'data')
 */
export async function writeServerFile(
  filePath: string,
  content: string,
  basePath: ContainerBasePath = 'data'
): Promise<void> {
  // If path is absolute (starts with /), use it directly as container path
  // Otherwise, treat as relative to basePath
  const containerPath = filePath.startsWith('/')
    ? filePath
    : path.posix.join(getContainerBasePath(basePath), filePath);
  return await dockerService.writeContainerFile(containerPath, content);
}

/**
 * Get file stats from container
 * Always uses Docker API with container paths
 * 
 * @param filePath - Container path (absolute starting with /) or relative path
 * @param basePath - Base path type if filePath is relative (default: 'data')
 */
export async function getServerFileStats(
  filePath: string,
  basePath: ContainerBasePath = 'data'
): Promise<{ size: number; modified: Date } | null> {
  // If path is absolute (starts with /), use it directly as container path
  // Otherwise, treat as relative to basePath
  const containerPath = filePath.startsWith('/')
    ? filePath
    : path.posix.join(getContainerBasePath(basePath), filePath);
  return await dockerService.getContainerFileStats(containerPath);
}
