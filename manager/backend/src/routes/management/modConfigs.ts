import { Router, Request, Response } from 'express';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import { logActivity } from '../../services/activityLog.js';
import { getRealPathIfSafe } from '../../utils/pathSecurity.js';
import { extractBaseModName, findConfigDirs } from './utils.js';
import { readServerDir } from '../../utils/fileAccess.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

// GET /api/management/mods/:filename/configs
router.get('/mods/:filename/configs', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const modName = filename.replace(/\.(jar|zip|disabled)$/i, '');
    const baseModName = extractBaseModName(filename);

    console.log(`Looking for configs for mod: ${filename}, baseName: ${baseModName}`);

    // Priority search locations (mods directory first!)
    const configPaths: string[] = [];

    // 1. First search in mods directory (highest priority)
    const modsMatches = await findConfigDirs(config.hytaleContainerModsPath, baseModName);
    configPaths.push(...modsMatches);
    console.log(`Found in modsPath (${config.hytaleContainerModsPath}):`, modsMatches);

    // 2. Exact matches in common locations
    configPaths.push(
      path.posix.join(config.hytaleContainerModsPath, modName),
      path.posix.join(config.hytaleContainerModsPath, baseModName),
      path.posix.join(config.hytaleContainerModsPath, 'config', modName),
      path.posix.join(config.hytaleContainerModsPath, 'config', baseModName),
      path.posix.join(config.hytaleContainerServerPath, 'config', modName),
      path.posix.join(config.hytaleContainerServerPath, 'config', baseModName),
      path.posix.join(config.hytaleContainerDataPath, 'config', modName),
      path.posix.join(config.hytaleContainerDataPath, 'config', baseModName),
    );

    // 3. Also search in server/config and data/config for fuzzy matches
    const serverConfigMatches = await findConfigDirs(path.posix.join(config.hytaleContainerServerPath, 'config'), baseModName);
    const dataConfigMatches = await findConfigDirs(path.posix.join(config.hytaleContainerDataPath, 'config'), baseModName);
    configPaths.push(...serverConfigMatches, ...dataConfigMatches);

    // Deduplicate paths
    const uniquePaths = [...new Set(configPaths)];

    const configs: { name: string; path: string }[] = [];

    // Helper to determine basePath from config path
    const getBasePath = (configPath: string): 'mods' | 'server' | 'data' => {
      if (configPath.startsWith(config.hytaleContainerModsPath)) {
        return 'mods';
      } else if (configPath.startsWith(config.hytaleContainerServerPath)) {
        return 'server';
      } else if (configPath.startsWith(config.hytaleContainerDataPath)) {
        return 'data';
      }
      return 'mods'; // default
    };

    for (const configPath of uniquePaths) {
      try {
        const basePath = getBasePath(configPath);
        const entries = await readServerDir(configPath, basePath);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (['.json', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.properties'].includes(ext)) {
            const fullPath = path.posix.join(configPath, entry);
            // Avoid duplicates
            if (!configs.some(c => c.path === fullPath)) {
              configs.push({
                name: entry,
                path: fullPath,
              });
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    console.log(`Found ${configs.length} config files for ${filename}:`, configs.map(c => c.path));
    res.json({ configs });
  } catch (error) {
    console.error('Failed to get mod configs:', error);
    res.status(500).json({ error: 'Failed to get mod configs' });
  }
});

// GET /api/management/config/read
router.get('/config/read', authMiddleware, requirePermission('config.view'), async (req: Request, res: Response) => {
  try {
    const configPath = req.query.path as string;
    if (!configPath) {
      res.status(400).json({ error: 'Path required' });
      return;
    }

    // SECURITY: Use proper path validation to prevent traversal attacks
    const allowedDirectories = [config.hytaleContainerModsPath, config.hytaleContainerModsPath, config.hytaleContainerServerPath, config.hytaleContainerDataPath];
    const safePath = getRealPathIfSafe(configPath, allowedDirectories);

    if (!safePath) {
      console.warn(`[SECURITY] Blocked path traversal attempt: ${configPath}`);
      res.status(403).json({ error: 'Access denied - invalid path' });
      return;
    }

    const content = await readFile(safePath, 'utf-8');
    res.json({ content, path: safePath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read config' });
  }
});

// PUT /api/management/config/write
router.put('/config/write', authMiddleware, requirePermission('config.edit'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { path: configPath, content } = req.body;
    if (!configPath || content === undefined) {
      res.status(400).json({ error: 'Path and content required' });
      return;
    }

    // SECURITY: Use proper path validation to prevent traversal attacks
    const allowedDirectories = [config.hytaleContainerModsPath, config.hytaleContainerModsPath, config.hytaleContainerServerPath, config.hytaleContainerDataPath];
    const safePath = getRealPathIfSafe(configPath, allowedDirectories);

    if (!safePath) {
      console.warn(`[SECURITY] Blocked path traversal attempt (write): ${configPath}`);
      res.status(403).json({ error: 'Access denied - invalid path' });
      return;
    }

    await writeFile(safePath, content, 'utf-8');

    await logActivity(
      req.user || 'unknown',
      'edit_config',
      'config',
      true,
      path.basename(safePath),
      `Edited config: ${safePath}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to write config' });
  }
});

export default router;
