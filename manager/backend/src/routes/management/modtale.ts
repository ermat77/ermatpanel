import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { logActivity } from '../../services/activityLog.js';
import {
  searchMods as modtaleSearch,
  getModDetails as modtaleGetDetails,
  installModFromModtale,
  uninstallModtale,
  checkModtaleStatus,
  getTags as modtaleGetTags,
  getClassifications as modtaleGetClassifications,
  getGameVersions as modtaleGetGameVersions,
  getFeaturedMods,
  getRecentMods,
  clearModtaleCache,
  isValidProjectId,
  isValidVersion,
  getInstalledModtaleInfo,
  type ModtaleSortOption,
  type ModtaleClassification,
} from '../../services/modtale.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

// GET /api/management/modtale/status - Check Modtale API status
router.get('/modtale/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const status = await checkModtaleStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check Modtale status' });
  }
});

// GET /api/management/modtale/search - Search mods on Modtale
router.get('/modtale/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const {
      search,
      page,
      size,
      sort,
      classification,
      tags,
      gameVersion,
      author,
    } = req.query;

    const result = await modtaleSearch({
      search: search as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      size: size ? parseInt(size as string, 10) : undefined,
      sort: sort as ModtaleSortOption | undefined,
      classification: classification as ModtaleClassification | undefined,
      tags: tags ? (tags as string).split(',') : undefined,
      gameVersion: gameVersion as string | undefined,
      author: author as string | undefined,
    });

    if (!result) {
      res.status(503).json({ error: 'Modtale API unavailable' });
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to search Modtale' });
  }
});

// GET /api/management/modtale/projects/:projectId - Get project details
router.get('/modtale/projects/:projectId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    // Security: Validate projectId format
    if (!isValidProjectId(projectId)) {
      res.status(400).json({ error: 'Invalid project ID format' });
      return;
    }

    const project = await modtaleGetDetails(projectId);

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get project details' });
  }
});

// POST /api/management/modtale/install - Install mod from Modtale
router.post('/modtale/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, versionId } = req.body;

    if (!projectId) {
      res.status(400).json({ error: 'projectId required' });
      return;
    }

    // Security: Validate projectId format
    if (!isValidProjectId(projectId)) {
      res.status(400).json({ error: 'Invalid project ID format' });
      return;
    }

    // Security: Validate versionId format if provided
    if (versionId && !isValidVersion(versionId)) {
      res.status(400).json({ error: 'Invalid version ID format' });
      return;
    }

    const result = await installModFromModtale(projectId, versionId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'install_mod',
        'mod',
        true,
        result.filename,
        `Installed ${result.projectTitle} v${result.version} from Modtale`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to install mod from Modtale' });
  }
});

// GET /api/management/modtale/featured - Get featured/popular mods
router.get('/modtale/featured', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const mods = await getFeaturedMods(limit);
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get featured mods' });
  }
});

// GET /api/management/modtale/recent - Get recently updated mods
router.get('/modtale/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const mods = await getRecentMods(limit);
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get recent mods' });
  }
});

// GET /api/management/modtale/tags - Get available tags
router.get('/modtale/tags', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const tags = await modtaleGetTags();
    res.json({ tags });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tags' });
  }
});

// GET /api/management/modtale/classifications - Get available classifications
router.get('/modtale/classifications', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const classifications = await modtaleGetClassifications();
    res.json({ classifications });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get classifications' });
  }
});

// GET /api/management/modtale/game-versions - Get supported game versions
router.get('/modtale/game-versions', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const gameVersions = await modtaleGetGameVersions();
    res.json({ gameVersions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get game versions' });
  }
});

// POST /api/management/modtale/refresh - Clear Modtale cache
router.post('/modtale/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    clearModtaleCache();
    res.json({ success: true, message: 'Modtale cache cleared' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to refresh cache' });
  }
});

// GET /api/management/modtale/installed - Get installed Modtale mods
router.get('/modtale/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const installed = await getInstalledModtaleInfo();
    res.json({ installed });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get installed mods' });
  }
});

// DELETE /api/management/modtale/uninstall/:projectId - Uninstall a Modtale mod
router.delete('/modtale/uninstall/:projectId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;

    if (!projectId || !isValidProjectId(projectId)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    const result = await uninstallModtale(projectId);

    if (result.success) {
      // Log the uninstall activity
      await logActivity(
        req.user || 'Admin',
        'uninstall_modtale',
        'mod',
        true,
        projectId,
        `Uninstalled Modtale mod: ${projectId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('Modtale uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

export default router;
