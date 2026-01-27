import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { logActivity } from '../../services/activityLog.js';
import { getAvailableMods, installMod, uninstallMod, updateMod, getLatestRelease, refreshRegistry, getRegistryInfo } from '../../services/modStore.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

// GET /api/management/modstore
router.get('/modstore', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const mods = await getAvailableMods();
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get mod store' });
  }
});

// GET /api/management/modstore/:modId/release
router.get('/modstore/:modId/release', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { modId } = req.params;
    const mods = await getAvailableMods();
    const mod = mods.find((m) => m.id === modId);

    if (!mod) {
      res.status(404).json({ error: 'Mod not found' });
      return;
    }

    // Check if mod has GitHub source
    if (!mod.github) {
      // For direct download mods, return version from registry
      res.json({
        version: mod.version || 'unknown',
        name: mod.name,
        publishedAt: null,
        assets: [],
        source: 'direct',
      });
      return;
    }

    const release = await getLatestRelease(mod.github);
    if (!release) {
      res.status(500).json({ error: 'Failed to fetch release info' });
      return;
    }

    res.json({
      version: release.tag_name,
      name: release.name,
      publishedAt: release.published_at,
      assets: release.assets.map((a) => ({
        name: a.name,
        size: a.size,
      })),
      source: 'github',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get release info' });
  }
});

// POST /api/management/modstore/:modId/install
router.post('/modstore/:modId/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modId } = req.params;
    const result = await installMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'install_mod',
        'mod',
        true,
        result.filename,
        `Installed ${modId} v${result.version} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to install mod' });
  }
});

// DELETE /api/management/modstore/:modId/uninstall
router.delete('/modstore/:modId/uninstall', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modId } = req.params;
    const result = await uninstallMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'uninstall_mod',
        'mod',
        true,
        modId,
        `Uninstalled ${modId} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// POST /api/management/modstore/:modId/update
router.post('/modstore/:modId/update', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modId } = req.params;
    const result = await updateMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'update_mod',
        'mod',
        true,
        result.filename,
        `Updated ${modId} to ${result.version} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update mod' });
  }
});

// POST /api/management/modstore/refresh - Refresh the external mod registry
router.post('/modstore/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    refreshRegistry();
    const mods = await getAvailableMods();
    res.json({ success: true, modCount: mods.length, registry: getRegistryInfo() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to refresh registry' });
  }
});

// GET /api/management/modstore/info - Get registry info
router.get('/modstore/info', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    res.json(getRegistryInfo());
  } catch (error) {
    res.status(500).json({ error: 'Failed to get registry info' });
  }
});

export default router;
