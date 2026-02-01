import { Router, Request, Response } from 'express';
import { unlink } from 'fs/promises';
import * as fs from 'fs';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as kyuubiApiService from '../../services/kyuubiApi.js';
import { config } from '../../config.js';
import * as fileAccess from '../../utils/fileAccess.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import {
  verifyJarFile,
  uploadApiPlugin,
  parsePrometheusMetrics,
  parseTpsMetrics,
} from './utils.js';

const router = Router();

// GET /api/server/plugin/status - Get KyuubiSoft API plugin status
router.get('/status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const status = await kyuubiApiService.getPluginStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get plugin status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/diagnostics - Get detailed plugin diagnostics
router.get('/diagnostics', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const diagnostics = await kyuubiApiService.getPluginDiagnostics();
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get plugin diagnostics',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/update-check - Check if plugin update is available
router.get('/update-check', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const updateInfo = await kyuubiApiService.isUpdateAvailable();
    res.json(updateInfo);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check for plugin updates',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/plugin/install - Install or update the KyuubiSoft API plugin
router.post('/install', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.installPlugin();
    if (!result.success) {
      res.status(500).json(result);
      return;
    }
    res.json({
      success: true,
      message: 'Plugin installed successfully. Restart the server to activate.',
      version: kyuubiApiService.PLUGIN_VERSION
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install plugin'
    });
  }
});

// DELETE /api/server/plugin/uninstall - Uninstall the KyuubiSoft API plugin
router.delete('/uninstall', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.uninstallPlugin();
    if (!result.success) {
      res.status(500).json(result);
      return;
    }
    res.json({
      success: true,
      message: 'Plugin uninstalled successfully. Restart the server to complete removal.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to uninstall plugin'
    });
  }
});

// POST /api/server/plugin/upload - Upload the KyuubiSoft API plugin JAR file
router.post('/upload', authMiddleware, requirePermission('mods.install'), uploadApiPlugin.single('file'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate plugin upload

  const tempFilePath = req.file?.path;
  const targetFilename = req.file?.filename;

  try {
    if (!req.file || !tempFilePath || !targetFilename) {
      console.error(`[Plugin Upload] ❌ Missing file information`);
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Verify temp file exists
    if (!fs.existsSync(tempFilePath)) {
      console.error(`[Plugin Upload] ❌ Temp file does not exist: ${tempFilePath}`);
      res.status(400).json({ error: 'Uploaded file not found' });
      return;
    }
    console.log(`[Plugin Upload] ✅ Temp file exists: ${tempFilePath}`);

    // SECURITY: Verify file magic bytes match JAR format
    console.log(`[Plugin Upload] 🔍 Verifying JAR file format...`);
    if (!verifyJarFile(tempFilePath)) {
      // Delete the uploaded file
      await unlink(tempFilePath).catch(() => {});
      console.warn(`[Plugin Upload] ⚠️  [SECURITY] Blocked upload with invalid magic bytes: ${req.file.originalname}`);
      res.status(400).json({ error: 'Invalid file content. File does not match JAR format.' });
      return;
    }
    console.log(`[Plugin Upload] ✅ JAR file format verified`);

    // Manager and Hytale server share the same volume (hytale-server-data at /opt/hytale/server).
    // Use fileAccess to read the mods dir and fs to write (binary JAR) to the same path.
    const hostModsPath = path.join(config.gameDataPath, 'mods');
    const finalPath = path.join(hostModsPath, targetFilename);
    console.log(`[Plugin Upload] 📁 Mods path (shared volume): ${hostModsPath}`);

    // Ensure mods directory exists
    if (!fs.existsSync(hostModsPath)) {
      console.log(`[Plugin Upload]   Creating mods directory...`);
      fs.mkdirSync(hostModsPath, { recursive: true });
    }

    // Remove old versions of the plugin (use fileAccess to list mods dir)
    console.log(`[Plugin Upload] 🧹 Cleaning up old plugin versions...`);
    try {
      const files = await fileAccess.readServerDir('', 'mods');
      let removedCount = 0;
      for (const file of files) {
        if (file.toLowerCase().startsWith('kyuubisoftapi') &&
            file.endsWith('.jar') &&
            file !== targetFilename &&
            !file.endsWith('.disabled')) {
          const oldFilePath = path.join(hostModsPath, file);
          try {
            await unlink(oldFilePath);
            removedCount++;
          } catch (err) {
            console.warn(`[Plugin Upload]   ⚠️  Failed to remove ${file}:`, err);
          }
        }
      }
      if (removedCount > 0) {
        console.log(`[Plugin Upload]   Removed ${removedCount} old plugin version(s)`);
      }
    } catch (err) {
      console.warn(`[Plugin Upload]   ⚠️  Error cleaning up old versions:`, err);
    }

    // Copy uploaded file to mods dir
    console.log(`[Plugin Upload] 📤 Copying file to mods...`);
    fs.copyFileSync(tempFilePath, finalPath);
    console.log(`[Plugin Upload] ✅ File copied to ${finalPath}`);

    if (fs.existsSync(finalPath)) {
      const stats = fs.statSync(finalPath);
      console.log(`[Plugin Upload] ✅ Verified: ${stats.size} bytes`);
    } else {
      console.error(`[Plugin Upload] ❌ File NOT found after copy: ${finalPath}`);
    }

    // Clean up temp file
    console.log(`[Plugin Upload] 🧹 Cleaning up temp file...`);
    await unlink(tempFilePath).catch((err) => {
      console.warn(`[Plugin Upload] ⚠️  Failed to delete temp file:`, err);
    });

    res.json({
      success: true,
      message: 'Plugin uploaded successfully. Restart the server to activate.',
      filename: targetFilename,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (error) {
    // Try to clean up uploaded file on error
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }
    console.error('[Plugin Upload] Error:', error);
    res.status(500).json({ 
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload plugin' 
    });
  }
});

// GET /api/server/plugin/players - Get players from plugin API (more accurate)
router.get('/players', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getPlayersFromPlugin();
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get players from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/info - Get server info from plugin API
router.get('/info', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    console.log(`[Plugin Info] Fetching server info from plugin...`);
    const result = await kyuubiApiService.getServerInfoFromPlugin();
    if (!result.success) {
      // Return 503 (Service Unavailable) when plugin is not available
      // This is more appropriate than 502 (Bad Gateway) for service unavailability
      console.warn(`[Plugin Info] Plugin unavailable: ${result.error}`);
      res.status(503).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('[Plugin Info] Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get server info from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/memory - Get memory stats from plugin API
router.get('/memory', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getMemoryFromPlugin();
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get memory stats from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/metrics - Get Prometheus metrics from plugin API
router.get('/metrics', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getPrometheusMetrics();
    if (!result.success) {
      res.status(503).json({ success: false, error: result.error });
      return;
    }

    // Parse Prometheus text format into structured data
    const raw = result.data || '';
    const parsed = parsePrometheusMetrics(raw);

    res.json({
      success: true,
      data: {
        raw,
        parsed
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get Prometheus metrics from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/tps - Get extended TPS metrics from plugin API
router.get('/tps', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getPrometheusMetrics();
    if (!result.success) {
      res.status(503).json({ success: false, error: result.error });
      return;
    }

    const raw = result.data || '';
    const tpsMetrics = parseTpsMetrics(raw);

    res.json({
      success: true,
      data: tpsMetrics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get TPS metrics from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/players/:name/details - Get player details from plugin API
router.get('/players/:name/details', authMiddleware, requirePermission('server.view_status'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const result = await kyuubiApiService.getPlayerDetailsFromPlugin(name);
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get player details from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/players/:name/inventory - Get player inventory from plugin API
router.get('/players/:name/inventory', authMiddleware, requirePermission('server.view_status'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const result = await kyuubiApiService.getPlayerInventoryFromPlugin(name);
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get player inventory from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/players/:name/appearance - Get player appearance from plugin API
router.get('/players/:name/appearance', authMiddleware, requirePermission('server.view_status'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const result = await kyuubiApiService.getPlayerAppearanceFromPlugin(name);
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get player appearance from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
