import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { config } from '../config.js';
import type { BackupInfo, StorageInfo, ActionResponse } from '../types/index.js';
import { isValidBackupName } from '../utils/sanitize.js';
import { isPathSafe } from '../utils/pathSecurity.js';
import { readServerDir, getServerFileStats } from '../utils/fileAccess.js';
import * as dockerService from './docker.js';

// SECURITY: Validate backup ID to prevent path traversal
function validateBackupId(backupId: string): boolean {
  if (!backupId || typeof backupId !== 'string') return false;
  // Only allow alphanumeric, underscore, hyphen, and dot
  const safePattern = /^[a-zA-Z0-9_.-]+$/;
  return safePattern.test(backupId) && !backupId.includes('..');
}

export async function listBackups(): Promise<BackupInfo[]> {
  const backups: BackupInfo[] = [];

  // Check if directory exists by trying to read it
  let files: string[] = [];
  try {
    files = await readServerDir(config.hytaleContainerBackupsPath, 'backups');
  } catch {
    return backups;
  }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    // Support common backup extensions and Hytale server backup format
    const isBackupFile = ['.gz', '.tar', '.zip', '.bak', '.backup'].includes(ext) ||
                         file.endsWith('.tar.gz') ||
                         file.startsWith('backup_') ||
                         file.startsWith('hytale_');
    if (!isBackupFile) {
      continue;
    }

    const filePath = path.posix.join(config.hytaleContainerBackupsPath, file);
    try {
      const stats = await getServerFileStats(filePath, 'backups');

      // Skip if stats is null (not a file or doesn't exist)
      if (!stats) {
        continue;
      }

      // Extract ID from filename
      let id = file;
      if (file.endsWith('.tar.gz')) {
        id = file.replace('.tar.gz', '');
      } else if (ext) {
        id = path.basename(file, ext);
      }

      // Calculate size - show at least 0.01 MB for small files
      const sizeMb = stats.size / (1024 * 1024);
      const displaySizeMb = stats.size > 0 ? Math.max(0.01, Math.round(sizeMb * 100) / 100) : 0;

      // Determine type: auto if includes 'auto', 'scheduled', or created by Hytale server
      const isAuto = file.includes('auto') ||
                     file.includes('scheduled') ||
                     file.startsWith('backup_'); // Hytale server format

      backups.push({
        id,
        filename: file,
        size_bytes: stats.size,
        size_mb: displaySizeMb,
        created_at: stats.modified.toISOString(),
        type: isAuto ? 'auto' : 'manual',
      });
    } catch (err) {
      // Skip files that can't be read (permission issues, etc.)
      console.warn(`[Backup] Could not read file ${file}:`, err);
      continue;
    }
  }

  // Sort by creation time (newest first)
  backups.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return backups;
}

export async function getBackup(backupId: string): Promise<BackupInfo | null> {
  const backups = await listBackups();
  return backups.find((b) => b.id === backupId) || null;
}

export function getBackupPath(backupId: string): string | null {
  // SECURITY: Validate backup ID
  if (!validateBackupId(backupId)) {
    return null;
  }

  const extensions = ['.tar.gz', '.tar', '.zip'];

  for (const ext of extensions) {
    const filePath = path.join(config.hytaleContainerBackupsPath, `${backupId}${ext}`);

    // SECURITY: Verify path is within backups directory
    if (!isPathSafe(filePath, [config.hytaleContainerBackupsPath])) {
      return null;
    }

    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

export async function createBackup(name?: string): Promise<ActionResponse & { backup?: BackupInfo }> {
  // SECURITY: Validate name if provided
  if (name && !isValidBackupName(name)) {
    return { success: false, error: 'Invalid backup name. Use only letters, numbers, underscores and hyphens.' };
  }

  // Generate backup name
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
  const backupName = name ? `manual_${name}_${timestamp}` : `manual_${timestamp}`;
  const backupFile = path.posix.join(config.hytaleContainerBackupsPath, `${backupName}.tar.gz`);

  // SECURITY: Double-check path is safe
  if (!isPathSafe(backupFile, [config.hytaleContainerBackupsPath])) {
    return { success: false, error: 'Invalid backup path' };
  }

  try {
    // Ensure backups directory exists inside the container
    const mkdirResult = await dockerService.execInGameServerContainer(
      `mkdir -p '${config.hytaleContainerBackupsPath}'`
    );
    if (!mkdirResult.success) {
      console.warn(`[Backup] Failed to create backups directory: ${mkdirResult.error}`);
    }

    // Create tarball using tar command inside the container
    // Use posix paths for container paths
    const dataPath = config.hytaleContainerDataPath;
    const tarCommand = `tar -czf '${backupFile}' -C '${dataPath}' .`;
    
    console.log(`[Backup] Creating backup: ${backupName}`);
    console.log(`[Backup] Command: tar -czf '${backupFile}' -C '${dataPath}' .`);
    
    const result = await dockerService.execInGameServerContainer(tarCommand);
    
    if (!result.success) {
      return { success: false, error: result.error || 'Backup command failed' };
    }

    // Get file stats from inside the container
    const statCommand = `stat -c '%s' '${backupFile}' 2>/dev/null || stat -f '%z' '${backupFile}' 2>/dev/null || echo '0'`;
    const statResult = await dockerService.execInGameServerContainer(statCommand);
    
    if (!statResult.success || !statResult.output) {
      return { success: false, error: 'Failed to get backup file size' };
    }

    const sizeBytes = parseInt(statResult.output.trim(), 10) || 0;
    const sizeMb = sizeBytes > 0 ? Math.max(0.01, Math.round(sizeBytes / (1024 * 1024) * 100) / 100) : 0;

    return {
      success: true,
      backup: {
        id: backupName,
        filename: `${backupName}.tar.gz`,
        size_bytes: sizeBytes,
        size_mb: sizeMb,
        created_at: new Date().toISOString(),
        type: name === 'auto' || name === 'scheduled_restart' ? 'auto' : 'manual',
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Backup failed' };
  }
}

export function deleteBackup(backupId: string): ActionResponse {
  // SECURITY: Validate backup ID first
  if (!validateBackupId(backupId)) {
    return { success: false, error: 'Invalid backup ID' };
  }

  const filePath = getBackupPath(backupId);

  if (!filePath) {
    return { success: false, error: 'Backup not found' };
  }

  // SECURITY: Verify path is safe before deletion
  if (!isPathSafe(filePath, [config.hytaleContainerBackupsPath])) {
    return { success: false, error: 'Invalid backup path' };
  }

  try {
    fs.unlinkSync(filePath);
    return { success: true, message: `Backup ${backupId} deleted` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Delete failed' };
  }
}

export async function restoreBackup(backupId: string): Promise<ActionResponse> {
  // SECURITY: Validate backup ID first
  if (!validateBackupId(backupId)) {
    return { success: false, error: 'Invalid backup ID' };
  }

  // Get backup file path inside the container
  // Try different extensions to find the backup file
  const extensions = ['.tar.gz', '.tar', '.zip'];
  let backupFile: string | null = null;
  
  for (const ext of extensions) {
    const testPath = path.posix.join(config.hytaleContainerBackupsPath, `${backupId}${ext}`);
    
    // SECURITY: Verify path is safe
    if (!isPathSafe(testPath, [config.hytaleContainerBackupsPath])) {
      continue;
    }
    
    // Check if file exists in container
    const checkResult = await dockerService.execInGameServerContainer(
      `test -f '${testPath}' && echo 'EXISTS' || echo 'NOT_FOUND'`
    );
    
    if (checkResult.success && checkResult.output?.trim() === 'EXISTS') {
      backupFile = testPath;
      break;
    }
  }

  if (!backupFile) {
    return { success: false, error: 'Backup not found' };
  }

  try {
    // Create a pre-restore backup
    await createBackup('pre_restore');

    // Use posix paths for container operations
    const tempDir = path.posix.join(config.hytaleContainerBackupsPath, '_restore_temp');
    const dataPath = config.hytaleContainerDataPath;

    console.log(`[Backup] Starting restore from: ${backupFile}`);
    console.log(`[Backup] Temp directory: ${tempDir}`);
    console.log(`[Backup] Data path: ${dataPath}`);

    // Remove temp directory if it exists, then create it
    const cleanupResult = await dockerService.execInGameServerContainer(
      `rm -rf '${tempDir}' && mkdir -p '${tempDir}'`
    );
    if (!cleanupResult.success) {
      return { success: false, error: `Failed to create temp directory: ${cleanupResult.error}` };
    }

    // Extract backup inside the container
    console.log(`[Backup] Extracting backup...`);
    const extractCommand = `tar -xzf '${backupFile}' -C '${tempDir}'`;
    const extractResult = await dockerService.execInGameServerContainer(extractCommand);
    
    if (!extractResult.success) {
      return { success: false, error: `Failed to extract backup: ${extractResult.error || 'Unknown error'}` };
    }

    // Remove current data directory
    console.log(`[Backup] Removing current data directory...`);
    const removeResult = await dockerService.execInGameServerContainer(
      `rm -rf '${dataPath}'`
    );
    if (!removeResult.success) {
      console.warn(`[Backup] Warning: Failed to remove old data directory: ${removeResult.error}`);
      // Continue anyway - mv will overwrite
    }

    // Move temp directory to data path
    console.log(`[Backup] Moving restored data to data directory...`);
    const moveResult = await dockerService.execInGameServerContainer(
      `mv '${tempDir}' '${dataPath}'`
    );
    
    if (!moveResult.success) {
      return { success: false, error: `Failed to move restored data: ${moveResult.error || 'Unknown error'}` };
    }

    console.log(`[Backup] Restore completed successfully`);

    return {
      success: true,
      message: `Restored from backup ${backupId}. Server restart required.`,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Restore failed' };
  }
}

export async function getStorageInfo(): Promise<StorageInfo> {
  let totalSize = 0;
  let count = 0;

  // Check if directory exists by trying to read it
  let files: string[] = [];
  try {
    files = await readServerDir(config.hytaleContainerBackupsPath, 'backups');
  } catch {
    return {
      total_size_bytes: 0,
      total_size_mb: 0,
      backup_count: 0,
    };
  }

  for (const file of files) {
    const filePath = path.posix.join(config.hytaleContainerBackupsPath, file);
    try {
      const stats = await getServerFileStats(filePath, 'backups');
      if (stats) {
        totalSize += stats.size;
        count++;
      }
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  return {
    total_size_bytes: totalSize,
    total_size_mb: Math.round(totalSize / (1024 * 1024) * 100) / 100,
    backup_count: count,
  };
}
