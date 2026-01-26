/**
 * File Access Utilities
 * 
 * Handles file access for both development and production modes:
 * - Development (.env.dev): Uses Docker API to access container files
 * - Production (.env): Uses direct filesystem access (volume mounts)
 */

import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { isDevelopmentMode } from '../config.js';
import * as dockerService from '../services/docker.js';

/**
 * Read directory contents
 * In dev: Uses Docker API
 * In production: Uses direct filesystem access
 */
export async function readServerDir(dirPath: string): Promise<string[]> {
  if (isDevelopmentMode) {
    // Development: Use Docker API
    let files = await dockerService.readContainerDir(dirPath);
    console.log(`[FileAccess] [Dev] Files: ${files} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    return files;
  } else {
    // Production: Use direct filesystem access (volume mounts)
    console.log(`[FileAccess] [Prod] Reading directory via filesystem: ${dirPath}`);
    return await readdir(dirPath);
  }
}

/**
 * Read file content
 * In dev: Uses Docker API
 * In production: Uses direct filesystem access
 */
export async function readServerFile(filePath: string): Promise<string> {
  if (isDevelopmentMode) {
    // Development: Use Docker API
    console.log(`[FileAccess] [Dev] Reading file via Docker API: ${filePath}`);
    return await dockerService.readContainerFile(filePath);
  } else {
    // Production: Use direct filesystem access (volume mounts)
    console.log(`[FileAccess] [Prod] Reading file via filesystem: ${filePath}`);
    return await readFile(filePath, 'utf-8');
  }
}

/**
 * Write file content
 * In dev: Uses Docker API
 * In production: Uses direct filesystem access
 */
export async function writeServerFile(filePath: string, content: string): Promise<void> {
  if (isDevelopmentMode) {
    // Development: Use Docker API
    console.log(`[FileAccess] [Dev] Writing file via Docker API: ${filePath}`);
    return await dockerService.writeContainerFile(filePath, content);
  } else {
    // Production: Use direct filesystem access (volume mounts)
    console.log(`[FileAccess] [Prod] Writing file via filesystem: ${filePath}`);
    return await writeFile(filePath, content, 'utf-8');
  }
}

/**
 * Get file stats
 * In dev: Uses Docker API
 * In production: Uses direct filesystem access
 */
export async function getServerFileStats(filePath: string): Promise<{ size: number; modified: Date } | null> {
  if (isDevelopmentMode) {
    // Development: Use Docker API
    console.log(`[FileAccess] [Dev] Getting file stats via Docker API: ${filePath}`);
    return await dockerService.getContainerFileStats(filePath);
  } else {
    // Production: Use direct filesystem access (volume mounts)
    try {
      console.log(`[FileAccess] [Prod] Getting file stats via filesystem: ${filePath}`);
      const stats = await stat(filePath);
      return {
        size: stats.size,
        modified: stats.mtime,
      };
    } catch {
      return null;
    }
  }
}
