import * as fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { config } from '../../config.js';
import { readServerDir } from '../../utils/fileAccess.js';

// SECURITY: Magic bytes for file type verification
export const FILE_SIGNATURES = {
  // ZIP/JAR files (PK\x03\x04 or PK\x05\x06 for empty)
  zip: [
    [0x50, 0x4B, 0x03, 0x04],
    [0x50, 0x4B, 0x05, 0x06],
    [0x50, 0x4B, 0x07, 0x08],
  ],
  // Lua script files start with -- or specific patterns
  lua: null, // Text file, check extension only
  // JavaScript files are text
  js: null, // Text file, check extension only
};

// SECURITY: Verify file magic bytes match expected type
export function verifyFileMagic(filePath: string, expectedType: 'zip' | 'lua' | 'js'): boolean {
  try {
    const signatures = FILE_SIGNATURES[expectedType];
    if (!signatures) {
      // Text files - verify they don't contain binary data
      const buffer = Buffer.alloc(512);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, 512, 0);
      fs.closeSync(fd);
      // Check for null bytes (binary indicator)
      for (let i = 0; i < Math.min(buffer.length, 512); i++) {
        if (buffer[i] === 0) return false;
      }
      return true;
    }

    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);

    return signatures.some(sig =>
      sig.every((byte, i) => buffer[i] === byte)
    );
  } catch {
    return false;
  }
}

// SECURITY: Generate safe filename with unique prefix
export function generateSafeFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  // Sanitize the base name
  const safeName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .substring(0, 100);
  // Add unique prefix to prevent overwrites
  const uniqueId = crypto.randomBytes(4).toString('hex');
  return `${safeName}_${uniqueId}${ext}`;
}

// SECURITY: Allowed file extensions for uploads
// Removed .dll and .so as they are native executables
export const ALLOWED_MOD_EXTENSIONS = ['.jar', '.zip', '.js', '.lua'];
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit (reduced from 100MB)

// Configure multer for file uploads with security improvements
const modsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.hytaleContainerModsPath);
  },
  filename: (_req, file, cb) => {
    // SECURITY: Generate safe filename to prevent path traversal and overwrites
    cb(null, generateSafeFilename(file.originalname));
  },
});

export const uploadMod = multer({
  storage: modsStorage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // SECURITY: Only allow safe extensions
    if (ALLOWED_MOD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${ALLOWED_MOD_EXTENSIONS.join(', ')}`));
    }
  },
});

// Helper: Extract base mod name without version (e.g., "EasyWebMap-v1.0.9" -> "EasyWebMap")
export function extractBaseModName(filename: string): string {
  // Remove extension first
  let name = filename.replace(/\.(jar|zip|disabled)$/i, '');
  // Remove version patterns like -v1.0.0, -1.0.0, _v1.0.0
  name = name.replace(/[-_]v?\d+(\.\d+)*$/i, '');
  return name;
}

// Helper: Determine basePath from directory path
function getBasePathFromDir(dirPath: string): 'mods' | 'server' | 'data' {
  if (dirPath.startsWith(config.hytaleContainerModsPath)) {
    return 'mods';
  } else if (dirPath.startsWith(config.hytaleContainerServerPath)) {
    return 'server';
  } else if (dirPath.startsWith(config.hytaleContainerDataPath)) {
    return 'data';
  }
  // Default to mods if can't determine
  return 'mods';
}

// Helper: Find config directories matching mod name (fuzzy search)
export async function findConfigDirs(baseDir: string, modName: string): Promise<string[]> {
  const result: string[] = [];
  const modNameLower = modName.toLowerCase();
  const basePath = getBasePathFromDir(baseDir);

  try {
    const entries = await readServerDir(baseDir, basePath);
    for (const entry of entries) {
      const entryPath = path.posix.join(baseDir, entry);
      // Check if this is a directory by trying to read it as a directory
      let isDirectory = false;
      try {
        await readServerDir(entryPath, basePath);
        isDirectory = true;
      } catch {
        // Not a directory or can't be read
      }

      if (isDirectory) {
        const entryLower = entry.toLowerCase();
        const entryNormalized = entryLower.replace(/[_-]/g, '');
        const modNameNormalized = modNameLower.replace(/[_-]/g, '');

        // Match patterns:
        // 1. Folder contains mod name: "cryptobench_EasyWebMap" contains "easywebmap"
        // 2. Mod name contains folder name
        // 3. Pattern: author_modname (e.g., cryptobench_EasyWebMap)
        // 4. Normalized comparison (ignoring _ and -)
        if (
          entryLower.includes(modNameLower) ||
          modNameLower.includes(entryLower) ||
          entryNormalized.includes(modNameNormalized) ||
          modNameNormalized.includes(entryNormalized) ||
          entryLower.endsWith('_' + modNameLower) ||
          entryLower.startsWith(modNameLower + '_')
        ) {
          result.push(entryPath);
        }
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
    console.log(`findConfigDirs: Could not read ${baseDir}:`, e);
  }

  return result;
}
