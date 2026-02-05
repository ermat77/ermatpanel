import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { pipeline } from 'stream/promises';
import { config } from '../config.js';
import type { BackupInfo, StorageInfo, ActionResponse } from '../types/index.js';
import { isValidBackupName } from '../utils/sanitize.js';
import { isPathSafe } from '../utils/pathSecurity.js';
import { readServerDir, getServerFileStats } from '../utils/fileAccess.js';
import * as tarStream from 'tar-stream';

/** Effective backups directory for direct fs access (shared volume in dev/prod). */
function getBackupsDir(): string {
  return config.effectiveBackupsPath ?? path.join(config.gameDataPath, 'backups');
}

/** Paths relative to game data root to exclude from backups (files and folders). */
const BACKUP_EXCLUDED_RELATIVE_PATHS: string[] = [
  'Assets.zip',
  'assets',
  'backups',
  'HytaleServer.jar',
  '.cache',
  '.ssh',
  '.ssh_host_keys'
];

function isExcludedFromBackup(rel: string, excludedRelative: string[]): boolean {
  const normalized = rel.replace(/\\/g, '/');
  for (const ex of excludedRelative) {
    const exNorm = ex.replace(/\\/g, '/');
    if (normalized === exNorm || normalized.startsWith(exNorm + '/')) return true;
  }
  return false;
}

/** Recursively add directory contents to a tar pack (excludes excludePath and excludedRelative). */
async function addDirToPack(
  pack: ReturnType<typeof tarStream.pack>,
  dirPath: string,
  basePath: string,
  excludePath: string,
  excludedRelative: string[] = []
): Promise<void> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dirPath, e.name);
    if (path.resolve(full) === path.resolve(excludePath)) continue;
    const rel = path.relative(basePath, full).replace(/\\/g, '/');
    if (isExcludedFromBackup(rel, excludedRelative)) continue;
    if (e.isDirectory()) {
      pack.entry({ name: rel + '/', type: 'directory' });
      await addDirToPack(pack, full, basePath, excludePath, excludedRelative);
    } else {
      const buf = await fs.promises.readFile(full);
      pack.entry({ name: rel, size: buf.length, type: 'file' }, buf);
    }
  }
}

/** Create a .tar.gz archive of a directory (pure Node, no system tar). */
async function createTarGzFromDir(
  sourceDir: string,
  archivePath: string,
  excludedRelative: string[] = []
): Promise<void> {
  const pack = tarStream.pack();
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(archivePath);
  pack.pipe(gzip).pipe(out);

  await addDirToPack(pack, sourceDir, sourceDir, archivePath, excludedRelative);
  pack.finalize();

  await new Promise<void>((resolve, reject) => {
    out.once('finish', () => resolve());
    out.once('error', reject);
    pack.once('error', reject);
    gzip.once('error', reject);
  });
}

/** Extract a .tar.gz archive to a directory (pure Node, no system tar). */
async function extractTarGzToDir(archivePath: string, destDir: string): Promise<void> {
  const extract = tarStream.extract();
  const destResolved = path.resolve(destDir);

  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const name = header.name.replace(/\\/g, '/').replace(/\/$/, '');
      const dest = path.join(destDir, name);
      const resolved = path.resolve(dest);
      if (resolved !== destResolved && !resolved.startsWith(destResolved + path.sep)) {
        stream.resume();
        next();
        return;
      }
      if (header.type === 'directory' || name === '' || header.name.endsWith('/')) {
        fs.mkdirSync(dest, { recursive: true });
        stream.on('end', next);
        stream.resume();
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const w = fs.createWriteStream(dest);
      stream.pipe(w);
      w.on('finish', next);
      w.on('error', (err) => {
        stream.destroy();
        next(err);
      });
    });
    extract.on('finish', resolve);
    extract.on('error', reject);

    fs.createReadStream(archivePath)
      .pipe(zlib.createGunzip())
      .pipe(extract);
  });
}

/** Create a .zip archive of a directory; contents at root. Excludes excludePath and excludedRelative. */
async function createZipFromDir(
  sourceDir: string,
  archivePath: string,
  excludedRelative: string[] = []
): Promise<void> {
  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(sourceDir, e.name);
      if (path.resolve(full) === path.resolve(archivePath)) continue;
      const rel = path.relative(sourceDir, full).replace(/\\/g, '/');
      if (isExcludedFromBackup(rel, excludedRelative)) continue;
      if (e.isDirectory()) {
        archive.directory(full + path.sep, e.name);
      } else {
        archive.file(full, { name: e.name });
      }
    }

    archive.finalize();
  });
}

/** Extract a .zip archive to a directory (entries at root). */
async function extractZipToDir(archivePath: string, destDir: string): Promise<void> {
  const destResolved = path.resolve(destDir);
  const directory = await unzipper.Open.file(archivePath);

  for (const entry of directory.files) {
    const name = entry.path.replace(/\\/g, '/').replace(/\/$/, '');
    if (!name) continue;
    const dest = path.join(destDir, name);
    const resolved = path.resolve(dest);
    if (resolved !== destResolved && !resolved.startsWith(destResolved + path.sep)) continue;

    if (entry.type === 'Directory') {
      fs.mkdirSync(dest, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const readStream = entry.stream();
      const writeStream = fs.createWriteStream(dest, { flags: 'w' });
      await pipeline(readStream, writeStream);
    }
  }
}

// SECURITY: Validate backup ID to prevent path traversal
function validateBackupId(backupId: string): boolean {
  if (!backupId || typeof backupId !== 'string') return false;
  // Only allow alphanumeric, underscore, hyphen, and dot
  const safePattern = /^[a-zA-Z0-9_.-]+$/;
  return safePattern.test(backupId) && !backupId.includes('..');
}

export async function listBackups(): Promise<BackupInfo[]> {
  const backups: BackupInfo[] = [];
  const listPath = config.hytaleContainerBackupsPath;
  console.log('[Backup] listBackups: reading directory', listPath);

  // Check if directory exists by trying to read it
  let files: string[] = [];
  try {
    files = await readServerDir(listPath, 'backups');
    console.log('[Backup] listBackups: directory read ok, files count:', files.length, 'entries:', files.slice(0, 20).join(', ') + (files.length > 20 ? '...' : ''));
  } catch (err) {
    console.warn('[Backup] listBackups: failed to read directory', listPath, err);
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

  const backupsDir = getBackupsDir();
  const extensions = ['.zip', '.tar.gz', '.tar'];

  for (const ext of extensions) {
    const filePath = path.join(backupsDir, `${backupId}${ext}`);

    // SECURITY: Verify path is within backups directory
    if (!isPathSafe(filePath, [backupsDir])) {
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
  const backupsDir = getBackupsDir();
  const backupFile = path.join(backupsDir, `${backupName}.zip`);

  console.log('[Backup] createBackup: backups directory path:', backupsDir);
  console.log('[Backup] createBackup: backup file path:', backupFile);

  // SECURITY: Double-check path is safe
  if (!isPathSafe(backupFile, [backupsDir])) {
    return { success: false, error: 'Invalid backup path' };
  }

  try {
    // Ensure backups directory exists (direct fs on shared volume)
    await fs.promises.mkdir(backupsDir, { recursive: true });

    // Create zip of full game data (folders/files at root); exclude archive + BACKUP_EXCLUDED_RELATIVE_PATHS
    console.log(`[Backup] Creating backup: ${backupName}`);
    await createZipFromDir(config.gameDataPath, backupFile, BACKUP_EXCLUDED_RELATIVE_PATHS);

    const stat = await fs.promises.stat(backupFile);
    const sizeBytes = stat.size;
    const sizeMb = sizeBytes > 0 ? Math.max(0.01, Math.round(sizeBytes / (1024 * 1024) * 100) / 100) : 0;

    return {
      success: true,
      backup: {
        id: backupName,
        filename: `${backupName}.zip`,
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
  if (!isPathSafe(filePath, [getBackupsDir()])) {
    return { success: false, error: 'Invalid backup path' };
  }

  try {
    fs.unlinkSync(filePath);
    return { success: true, message: `Backup ${backupId} deleted` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Delete failed' };
  }
}

/** Move contents of srcDir into destDir (direct fs). destDir must exist. */
function moveDirContents(srcDir: string, destDir: string): void {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      moveDirContents(srcPath, destPath);
      fs.rmdirSync(srcPath);
    } else {
      fs.renameSync(srcPath, destPath);
    }
  }
}

export async function restoreBackup(backupId: string): Promise<ActionResponse> {
  // SECURITY: Validate backup ID first
  if (!validateBackupId(backupId)) {
    return { success: false, error: 'Invalid backup ID' };
  }

  const backupFile = getBackupPath(backupId);
  if (!backupFile) {
    return { success: false, error: 'Backup not found' };
  }

  const tempDir = path.join(config.gameDataPath, '_restore_temp');

  try {
    // Create a pre-restore backup
    await createBackup('pre_restore');

    console.log(`[Backup] Starting restore from: ${backupFile}`);
    console.log(`[Backup] Temp directory: ${tempDir}`);
    console.log(`[Backup] Game data path: ${config.gameDataPath}`);

    // Create temp dir outside backups (so we don't delete it when clearing backups)
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Extract backup (full game data at root)
    console.log(`[Backup] Extracting backup...`);
    if (backupFile.toLowerCase().endsWith('.zip')) {
      await extractZipToDir(backupFile, tempDir);
    } else {
      await extractTarGzToDir(backupFile, tempDir);
    }

    // Replace game data root with extracted content
    console.log(`[Backup] Replacing game data with restored content...`);
    const gameDataPath = config.gameDataPath;
    fs.mkdirSync(gameDataPath, { recursive: true });
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(tempDir, entry.name);
      const destPath = path.join(gameDataPath, entry.name);
      if (entry.isDirectory()) {
        fs.rmSync(destPath, { recursive: true, force: true });
        fs.renameSync(srcPath, destPath);
      } else {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        fs.renameSync(srcPath, destPath);
      }
    }

    // Remove temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });

    console.log(`[Backup] Restore completed successfully`);

    return {
      success: true,
      message: `Restored from backup ${backupId}. Server restart required.`,
    };
  } catch (error) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
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
