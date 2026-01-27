import { Router, Request, Response } from 'express';
import { unlink } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import { logActivity } from '../../services/activityLog.js';
import { isPathSafe, sanitizeFileName } from '../../utils/pathSecurity.js';
import { getModRegistry, checkModUpdate } from '../../services/modStore.js';
import { uploadMod, verifyFileMagic } from './utils.js';
import { readServerDir, getServerFileStats } from '../../utils/fileAccess.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import type { ModInfo } from './types.js';

const router = Router();

async function scanDirectory(dirPath: string): Promise<ModInfo[]> {
  const items: ModInfo[] = [];
  try {
    const entries = await readServerDir(dirPath, 'mods');

    for (const entry of entries) {
      const entryPath = path.posix.join(dirPath, entry);
      try {
        const stats = await getServerFileStats(entryPath, 'mods');
        if (stats) {
          // Check for common mod extensions
          const ext = path.extname(entry).toLowerCase();
          const isValidFile = ['.jar', '.zip', '.js', '.lua', '.dll', '.so'].includes(ext);
          const isDisabled = entry.endsWith('.disabled');

          if (isValidFile || isDisabled) {
            items.push({
              name: entry.replace('.disabled', '').replace(ext, ''),
              filename: entry,
              size: stats.size,
              lastModified: stats.modified.toISOString(),
              enabled: !isDisabled,
            });
          }
        }
      } catch {
        // Skip entries that can't be read
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return items;
}

// GET /api/management/mods
router.get('/mods', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const mods = await scanDirectory(config.hytaleContainerModsPath);

    // Get mod registry to check for updates
    const registry = await getModRegistry();

    // Enrich mods with update info from registry
    const enrichedMods = await Promise.all(mods.map(async (mod) => {
      // Try to match mod to registry entry by filename
      const modNameLower = mod.name.toLowerCase();
      const registryEntry = registry.find(entry =>
        modNameLower.includes(entry.id.toLowerCase()) ||
        modNameLower.includes(entry.name.toLowerCase())
      );

      if (registryEntry) {
        try {
          const updateInfo = await checkModUpdate(registryEntry.id);
          return {
            ...mod,
            storeId: registryEntry.id,
            installedVersion: updateInfo.installedVersion,
            latestVersion: updateInfo.latestVersion,
            hasUpdate: updateInfo.hasUpdate,
          };
        } catch {
          return { ...mod, storeId: registryEntry.id };
        }
      }
      return mod;
    }));

    res.json({ mods: enrichedMods, path: config.hytaleContainerModsPath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read mods' });
  }
});

// PUT /api/management/mods/:filename/toggle
router.put('/mods/:filename/toggle', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;

    // SECURITY: Validate filename to prevent path traversal
    const safeFilename = sanitizeFileName(filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const username = req.user || 'system';
    const filePath = path.join(config.hytaleContainerModsPath, safeFilename);

    // SECURITY: Verify path is within mods directory
    if (!isPathSafe(filePath, [config.hytaleContainerModsPath])) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const isCurrentlyDisabled = safeFilename.endsWith('.disabled');
    const disabledPath = isCurrentlyDisabled
      ? filePath.slice(0, -9)
      : filePath + '.disabled';

    const { rename } = await import('fs/promises');

    if (isCurrentlyDisabled) {
      await rename(filePath, disabledPath);
      await logActivity(username, 'enable_mod', 'mod', true, safeFilename.replace('.disabled', ''));
    } else {
      await rename(filePath, disabledPath);
      await logActivity(username, 'disable_mod', 'mod', true, safeFilename);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle mod' });
  }
});

// POST /api/management/mods/upload
router.post('/mods/upload', authMiddleware, requirePermission('mods.install'), uploadMod.single('file'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const expectedType: 'zip' | 'lua' | 'js' = (ext === '.jar' || ext === '.zip') ? 'zip' : (ext === '.lua' ? 'lua' : 'js');

    // SECURITY: Verify file magic bytes match expected type
    if (!verifyFileMagic(req.file.path, expectedType)) {
      // Delete the uploaded file
      await unlink(req.file.path).catch(() => {});
      console.warn(`[SECURITY] Blocked upload with invalid magic bytes: ${req.file.originalname}`);
      res.status(400).json({ error: 'Invalid file content. File does not match expected format.' });
      return;
    }

    await logActivity(
      req.user || 'unknown',
      'upload_mod',
      'mod',
      true,
      req.file.originalname,
      `Uploaded mod: ${req.file.filename} (original: ${req.file.originalname}, ${(req.file.size / 1024 / 1024).toFixed(2)} MB)`
    );

    res.json({
      success: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (error) {
    // Try to clean up uploaded file on error
    if (req.file?.path) {
      await unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to upload mod' });
  }
});

// DELETE /api/management/mods/:filename
router.delete('/mods/:filename', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;

    // SECURITY: Validate filename to prevent path traversal
    const safeFilename = sanitizeFileName(filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const filePath = path.join(config.hytaleContainerModsPath, safeFilename);

    // SECURITY: Verify path is within mods directory
    if (!isPathSafe(filePath, [config.hytaleContainerModsPath])) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    await unlink(filePath);

    await logActivity(
      req.user || 'unknown',
      'delete_mod',
      'mod',
      true,
      safeFilename,
      `Deleted mod: ${safeFilename}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete mod' });
  }
});

export default router;
