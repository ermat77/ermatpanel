/**
 * World Service
 * 
 * Handles world config and file operations using Docker API file access
 */

import path from 'path';
import { config } from '../config.js';
import * as fileAccess from '../utils/fileAccess.js';

// Possible world paths to check - only actual world directories
// Always use container paths
export function getWorldsPaths(): string[] {
  return [
    path.posix.join(config.hytaleContainerServerPath, 'worlds'),                    // /opt/hytale/server/worlds
    path.posix.join(config.hytaleContainerServerPath, 'universe', 'worlds'),            // /opt/hytale/server/universe/worlds (fallback)
  ];
}

/**
 * Read world config file
 * Tries multiple possible paths and returns the first found
 */
export async function getWorldConfig(worldName: string): Promise<{ path: string; content: any } | null> {
  // Security: validate world name

  if (!worldName || worldName.includes('..') || worldName.includes('/') || worldName.includes('\\')) {
    return null;
  }

  const possiblePaths = getWorldsPaths().map(wp => path.posix.join(wp, worldName, 'config.json'));
  for (const tryPath of possiblePaths) {
    try {
      const content = await fileAccess.readServerFile(tryPath);
      console.log('content:', content);
      const parsed = JSON.parse(content);
      return { path: tryPath, content: parsed };
    } catch {
      // Try next path
      continue;
    }
  }

  return null;
}

/**
 * Write world config file
 * Uses the same path where the config was read from
 */
export async function writeWorldConfig(worldName: string, configPath: string, configData: any): Promise<void> {
  // Security: validate world name
  if (!worldName || worldName.includes('..') || worldName.includes('/') || worldName.includes('\\')) {
    throw new Error('Invalid world name');
  }

  const content = JSON.stringify(configData, null, 2);
  await fileAccess.writeServerFile(configPath, content);
}

/**
 * Read a JSON file from a world directory
 * Tries multiple possible paths and returns the first found
 */
export async function getWorldFile(worldName: string, filePath: string): Promise<{ path: string; content: any; raw: string } | null> {
  // Security: validate world name
  if (!worldName || worldName.includes('..') || worldName.includes('\\')) {
    return null;
  }

  // Security: validate file path
  if (!filePath || filePath.includes('..') || !filePath.endsWith('.json')) {
    return null;
  }

  // Only allow files in root or resources folder
  const pathParts = filePath.split('/');
  if (pathParts.length > 2 || (pathParts.length === 2 && pathParts[0] !== 'resources')) {
    return null;
  }

  const possiblePaths = getWorldsPaths().map(wp => path.posix.join(wp, worldName, filePath));

  for (const tryPath of possiblePaths) {
    try {
      const content = await fileAccess.readServerFile(tryPath);
      const parsed = JSON.parse(content);
      return { path: tryPath, content: parsed, raw: content };
    } catch {
      // Try next path
      continue;
    }
  }

  return null;
}

/**
 * Write a JSON file to a world directory
 * Uses the same path where the file was read from
 */
export async function writeWorldFile(worldName: string, filePath: string, targetPath: string, content: string): Promise<void> {
  // Security: validate world name
  if (!worldName || worldName.includes('..') || worldName.includes('\\')) {
    throw new Error('Invalid world name');
  }

  // Security: validate file path
  if (!filePath || filePath.includes('..') || !filePath.endsWith('.json')) {
    throw new Error('Invalid file path');
  }

  // Only allow files in root or resources folder
  const pathParts = filePath.split('/');
  if (pathParts.length > 2 || (pathParts.length === 2 && pathParts[0] !== 'resources')) {
    throw new Error('Invalid file path structure');
  }

  // Validate JSON
  JSON.parse(content);

  await fileAccess.writeServerFile(targetPath, content);
}

/**
 * Check if a world file exists
 */
export async function worldFileExists(worldName: string, filePath: string): Promise<string | null> {
  // Security: validate world name
  if (!worldName || worldName.includes('..') || worldName.includes('\\')) {
    return null;
  }

  // Security: validate file path
  if (!filePath || filePath.includes('..') || !filePath.endsWith('.json')) {
    return null;
  }

  const possiblePaths = getWorldsPaths().map(wp => path.posix.join(wp, worldName, filePath));

  for (const tryPath of possiblePaths) {
    try {
      const stats = await fileAccess.getServerFileStats(tryPath);
      if (stats) {
        return tryPath;
      }
    } catch {
      // Try next path
      continue;
    }
  }

  return null;
}
