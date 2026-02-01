import { Router, Request, Response } from 'express';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import * as fileAccess from '../../utils/fileAccess.js';
import * as dockerService from '../../services/docker.js';
import {
  CONFIG_EXTENSIONS,
  QuickSettings,
  readPanelConfig,
  writePanelConfig,
  PanelConfig,
} from './utils.js';

const router = Router();

// GET /api/server/quick-settings - Get quick settings from config.json
router.get('/quick-settings', authMiddleware, requirePermission('config.view'), async (_req: Request, res: Response) => {
  try {
    const configPath = path.posix.join(config.hytaleContainerServerPath, 'config.json');
    console.log(`[Quick Settings] Reading config from: ${configPath}`);
    
    let content: string;
    try {
      content = await fileAccess.readServerFile(configPath, 'server');
    } catch (fileError) {
      console.error(`[Quick Settings] Failed to read config file: ${configPath}`, fileError);
      return res.status(404).json({
        error: 'Config file not found',
        message: fileError instanceof Error ? fileError.message : `Failed to read ${configPath}`
      });
    }

    let configData: Record<string, unknown>;
    try {
      configData = JSON.parse(content);
    } catch (parseError) {
      console.error(`[Quick Settings] Failed to parse config JSON: ${configPath}`, parseError);
      return res.status(500).json({
        error: 'Invalid config file format',
        message: parseError instanceof Error ? parseError.message : 'Failed to parse JSON'
      });
    }

    const quickSettings: QuickSettings = {
      serverName: configData.ServerName as string || 'Hytale Server',
      motd: configData.MOTD as string || '',
      password: configData.Password as string || '',
      maxPlayers: (configData.MaxPlayers as number) || 100,
      maxViewRadius: (configData.MaxViewRadius as number) || 32,
      defaultGameMode: (configData.Defaults as { GameMode?: string })?.GameMode || 'Adventure',
    };

    console.log(`[Quick Settings] ✅ Successfully loaded quick settings`);
    res.json(quickSettings);
  } catch (error) {
    console.error(`[Quick Settings] Unexpected error:`, error);
    res.status(500).json({
      error: 'Failed to load quick settings',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/quick-settings - Save quick settings to config.json
router.put('/quick-settings', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  try {
    const { serverName, motd, password, maxPlayers, maxViewRadius, defaultGameMode } = req.body;

    const configPath = path.posix.join(config.hytaleContainerServerPath, 'config.json');
    const content = await fileAccess.readServerFile(configPath, 'server');
    const configData = JSON.parse(content);

    // Update only the quick settings fields
    if (serverName !== undefined) configData.ServerName = serverName;
    if (motd !== undefined) configData.MOTD = motd;
    if (password !== undefined) configData.Password = password;
    if (maxPlayers !== undefined) configData.MaxPlayers = Number(maxPlayers);
    if (maxViewRadius !== undefined) configData.MaxViewRadius = Number(maxViewRadius);
    if (defaultGameMode !== undefined) {
      if (!configData.Defaults) configData.Defaults = {};
      configData.Defaults.GameMode = defaultGameMode;
    }

    await fileAccess.writeServerFile(configPath, JSON.stringify(configData, null, 2), 'server');
    res.json({ success: true, message: 'Quick settings saved' });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save quick settings',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/patchline - Get current patchline setting
router.get('/patchline', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const panelConfig = await readPanelConfig();
    res.json({
      patchline: panelConfig.patchline,
      options: ['release', 'pre-release']
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get patchline setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/patchline - Set patchline setting
router.put('/patchline', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  try {
    const { patchline } = req.body;

    if (!patchline || !['release', 'pre-release'].includes(patchline)) {
      res.status(400).json({ error: 'Invalid patchline. Must be "release" or "pre-release"' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldPatchline = panelConfig.patchline;
    const patchlineChanged = oldPatchline !== patchline;

    // Update config
    panelConfig.patchline = patchline;
    await writePanelConfig(panelConfig);

    // If patchline changed, delete server files to force redownload on restart
    if (patchlineChanged) {
      const serverJar = path.join(config.hytaleContainerServerPath, 'HytaleServer.jar');
      const assetsZip = path.join(config.hytaleContainerServerPath, 'Assets.zip');
      const versionFile = path.join(config.hytaleContainerServerPath, '.hytale-version');

      // Delete via container exec to ensure proper permissions
      await dockerService.execInGameServerContainer(
        `rm -f "${serverJar}" "${assetsZip}" "${versionFile}" 2>/dev/null || true`
      );

      res.json({
        success: true,
        patchline,
        changed: true,
        message: `Patchline changed from ${oldPatchline} to ${patchline}. Server files deleted. Restart to download the new version.`
      });
    } else {
      res.json({
        success: true,
        patchline,
        changed: false,
        message: 'Patchline unchanged.'
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set patchline',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/accept-early-plugins - Get current acceptEarlyPlugins setting
router.get('/accept-early-plugins', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const panelConfig = await readPanelConfig();
    res.json({
      acceptEarlyPlugins: panelConfig.acceptEarlyPlugins,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get accept early plugins setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/accept-early-plugins - Set acceptEarlyPlugins setting
router.put('/accept-early-plugins', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  try {
    const { acceptEarlyPlugins } = req.body;

    if (typeof acceptEarlyPlugins !== 'boolean') {
      res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldValue = panelConfig.acceptEarlyPlugins;
    const valueChanged = oldValue !== acceptEarlyPlugins;

    // Update config
    panelConfig.acceptEarlyPlugins = acceptEarlyPlugins;
    await writePanelConfig(panelConfig);

    res.json({
      success: true,
      acceptEarlyPlugins,
      changed: valueChanged,
      message: valueChanged
        ? `Accept early plugins ${acceptEarlyPlugins ? 'enabled' : 'disabled'}. Restart the server to apply changes.`
        : 'Setting unchanged.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set accept early plugins',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/disable-sentry - Get current disableSentry setting
router.get('/disable-sentry', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const panelConfig = await readPanelConfig();
    res.json({
      disableSentry: panelConfig.disableSentry,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get disable sentry setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/disable-sentry - Set disableSentry setting
router.put('/disable-sentry', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  try {
    const { disableSentry } = req.body;

    if (typeof disableSentry !== 'boolean') {
      res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldValue = panelConfig.disableSentry;
    const valueChanged = oldValue !== disableSentry;

    // Update config
    panelConfig.disableSentry = disableSentry;
    await writePanelConfig(panelConfig);

    res.json({
      success: true,
      disableSentry,
      changed: valueChanged,
      message: valueChanged
        ? `Sentry crash reporting ${disableSentry ? 'disabled' : 'enabled'}. Restart the server to apply changes.`
        : 'Setting unchanged.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set disable sentry',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/allow-op - Get current allowOp setting
router.get('/allow-op', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const panelConfig = await readPanelConfig();
    res.json({
      allowOp: panelConfig.allowOp,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get allow op setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/allow-op - Set allowOp setting
router.put('/allow-op', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  try {
    const { allowOp } = req.body;

    if (typeof allowOp !== 'boolean') {
      res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldValue = panelConfig.allowOp;
    const valueChanged = oldValue !== allowOp;

    // Update config
    panelConfig.allowOp = allowOp;
    await writePanelConfig(panelConfig);

    res.json({
      success: true,
      allowOp,
      changed: valueChanged,
      message: valueChanged
        ? `OP commands ${allowOp ? 'enabled' : 'disabled'}. Restart the server to apply changes.`
        : 'Setting unchanged.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set allow op',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/config/files - List config files
router.get('/config/files', authMiddleware, requirePermission('config.view'), async (_req: Request, res: Response) => {
  try {
    const files = await fileAccess.readServerDir('', 'server');
    const configFiles = files.filter(f =>
      CONFIG_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext))
    );

    const fileInfos = await Promise.all(configFiles.map(async (filename) => {
      try {
        const filePath = path.posix.join(config.hytaleContainerServerPath, filename);
        const stats = await fileAccess.getServerFileStats(filePath);
        if (stats) {
          return {
            name: filename,
            size: stats.size,
            modified: stats.modified.toISOString(),
          };
        } else {
          return { name: filename, size: 0, modified: null };
        }
      } catch {
        return { name: filename, size: 0, modified: null };
      }
    }));

    res.json({ files: fileInfos });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list config files',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/config/:filename - Read config file
router.get('/config/:filename', authMiddleware, requirePermission('config.view'), async (req: Request, res: Response) => {
  const { filename } = req.params;

  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  // Check extension
  if (!CONFIG_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext))) {
    res.status(400).json({ error: 'File type not allowed' });
    return;
  }

  try {
    const filePath = path.join(config.gameDataPath, filename);
    const content = await fileAccess.readServerFile(filePath);
    res.json({ filename, content });
  } catch (error) {
    res.status(404).json({
      error: 'File not found',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/config/:filename - Write config file
router.put('/config/:filename', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  const { filename } = req.params;
  const { content } = req.body;

  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  // Check extension
  if (!CONFIG_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext))) {
    res.status(400).json({ error: 'File type not allowed' });
    return;
  }

  if (typeof content !== 'string') {
    res.status(400).json({ error: 'Content must be a string' });
    return;
  }

  try {
    const filePath = path.join(config.gameDataPath, filename);
    await fileAccess.writeServerFile(filePath, content);
    res.json({ success: true, message: 'Config saved' });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save config',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
