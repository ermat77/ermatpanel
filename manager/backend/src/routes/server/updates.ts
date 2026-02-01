import { Router, Request, Response } from 'express';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import * as dockerService from '../../services/docker.js';
import * as fileAccess from '../../utils/fileAccess.js';
import {
  UpdateConfig,
  getDefaultUpdateConfig,
  NativeUpdateStatus,
  parseUpdateStatusOutput,
} from './utils.js';

const router = Router();

// GET /api/server/update-config - Get native update configuration
router.get('/update-config', authMiddleware, requirePermission('updates.view'), async (_req: Request, res: Response) => {
  try {
    const configPath = path.join(config.gameDataPath, 'config.json');

    try {
      const serverConfig = JSON.parse(await fileAccess.readServerFile(configPath));
      const updateConfig = serverConfig.updateConfig || getDefaultUpdateConfig();
      res.json(updateConfig);
    } catch {
      // Config doesn't exist yet, return defaults
      res.json(getDefaultUpdateConfig());
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to read update config',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/update-config - Update native update configuration
router.put('/update-config', authMiddleware, requirePermission('updates.config'), async (req: Request, res: Response) => {
  try {
    const {
      enabled,
      checkIntervalSeconds,
      notifyPlayersOnAvailable,
      patchline,
      runBackupBeforeUpdate,
      backupConfigBeforeUpdate,
      autoApplyMode,
      autoApplyDelayMinutes
    } = req.body;

    // Validation
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Field "enabled" must be boolean' });
    }
    if (checkIntervalSeconds !== undefined && (!Number.isInteger(checkIntervalSeconds) || checkIntervalSeconds < 60)) {
      return res.status(400).json({ error: 'Field "checkIntervalSeconds" must be integer >= 60' });
    }
    if (patchline !== undefined && !['release', 'pre-release'].includes(patchline)) {
      return res.status(400).json({ error: 'Field "patchline" must be "release" or "pre-release"' });
    }
    if (autoApplyMode !== undefined && !['DISABLED', 'WHEN_EMPTY', 'SCHEDULED'].includes(autoApplyMode)) {
      return res.status(400).json({ error: 'Field "autoApplyMode" must be DISABLED, WHEN_EMPTY, or SCHEDULED' });
    }
    if (autoApplyDelayMinutes !== undefined && (!Number.isInteger(autoApplyDelayMinutes) || autoApplyDelayMinutes < 1)) {
      return res.status(400).json({ error: 'Field "autoApplyDelayMinutes" must be integer >= 1' });
    }

    const configPath = path.join(config.gameDataPath, 'config.json');

    // Read existing config or create new
    let serverConfig: Record<string, unknown> = {};
    try {
      serverConfig = JSON.parse(await fileAccess.readServerFile(configPath));
    } catch {
      // Config doesn't exist, will create new
    }

    // Merge with existing updateConfig
    const currentUpdateConfig = (serverConfig.updateConfig as UpdateConfig) || getDefaultUpdateConfig();
    serverConfig.updateConfig = {
      ...currentUpdateConfig,
      ...(enabled !== undefined && { enabled }),
      ...(checkIntervalSeconds !== undefined && { checkIntervalSeconds }),
      ...(notifyPlayersOnAvailable !== undefined && { notifyPlayersOnAvailable }),
      ...(patchline !== undefined && { patchline }),
      ...(runBackupBeforeUpdate !== undefined && { runBackupBeforeUpdate }),
      ...(backupConfigBeforeUpdate !== undefined && { backupConfigBeforeUpdate }),
      ...(autoApplyMode !== undefined && { autoApplyMode }),
      ...(autoApplyDelayMinutes !== undefined && { autoApplyDelayMinutes }),
    };

    await fileAccess.writeServerFile(configPath, JSON.stringify(serverConfig, null, 2));

    res.json({
      success: true,
      message: 'Update config saved',
      data: serverConfig.updateConfig
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save update config',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/update-status - Get native update status
router.get('/update-status', authMiddleware, requirePermission('updates.view'), async (_req: Request, res: Response) => {
  try {
    const result = await dockerService.execCommand('/update status');

    if (!result.success) {
      return res.status(503).json({
        error: 'Server not responding',
        message: 'Cannot query update status. Is the server running?'
      });
    }

    const status = parseUpdateStatusOutput(result.message || '');
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get update status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-check - Check for updates
router.post('/update-check', authMiddleware, requirePermission('updates.check'), async (_req: Request, res: Response) => {
  try {
    const result = await dockerService.execCommand('/update check');

    if (!result.success) {
      return res.status(503).json({
        success: false,
        error: result.error || 'Update check failed',
        message: 'Server may be offline or not responding'
      });
    }

    // Give server time to process and get status
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResult = await dockerService.execCommand('/update status');
    const status = parseUpdateStatusOutput(statusResult.message || '');

    res.json({
      success: true,
      message: 'Update check completed',
      data: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Update check failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-download - Download available update
router.post('/update-download', authMiddleware, requirePermission('updates.download'), async (_req: Request, res: Response) => {
  try {
    const result = await dockerService.execCommand('/update download');

    if (!result.success) {
      return res.status(503).json({
        success: false,
        error: result.error || 'Download failed',
        message: 'Server may be offline or not responding'
      });
    }

    res.json({
      success: true,
      message: 'Update download started. Check status for progress.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Download failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-apply - Apply downloaded update (restarts server)
router.post('/update-apply', authMiddleware, requirePermission('updates.apply'), async (_req: Request, res: Response) => {
  try {
    // Check if update is ready
    const statusResult = await dockerService.execCommand('/update status');
    const status = parseUpdateStatusOutput(statusResult.message || '');

    if (status.state !== 'READY') {
      return res.status(400).json({
        success: false,
        error: 'No update ready to apply',
        message: 'Download an update first using /update download'
      });
    }

    // Apply update (server will restart with exit code 8)
    const result = await dockerService.execCommand('/update apply');

    res.json({
      success: true,
      message: 'Update applied. Server is restarting...',
      warning: 'Server will restart shortly. Players will be disconnected.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Apply update failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-cancel - Cancel ongoing download
router.post('/update-cancel', authMiddleware, requirePermission('updates.download'), async (_req: Request, res: Response) => {
  try {
    const result = await dockerService.execCommand('/update cancel');

    res.json({
      success: true,
      message: 'Update download cancelled'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Cancel failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
