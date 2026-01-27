import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { logActivity } from '../../services/activityLog.js';
import {
  searchResources as stackmartSearch,
  getResourceDetails as stackmartGetDetails,
  installResourceFromStackMart,
  uninstallStackMart,
  checkStackMartStatus,
  getCategories as stackmartGetCategories,
  getPopularResources,
  getRecentResources,
  clearStackMartCache,
  isValidResourceId,
  getInstalledStackMartInfo,
  type StackMartSortOption,
  type StackMartCategory,
} from '../../services/stackmart.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

// GET /api/management/stackmart/status - Check StackMart API status
router.get('/stackmart/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const status = await checkStackMartStatus();
    res.json(status);
  } catch {
    res.status(500).json({ error: 'Failed to check StackMart status' });
  }
});

// GET /api/management/stackmart/search - Search resources on StackMart
router.get('/stackmart/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const {
      search,
      page = '1',
      limit = '20',
      sort = 'popular',
      category,
      subcategory,
    } = req.query;

    const result = await stackmartSearch({
      search: search as string | undefined,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      sort: sort as StackMartSortOption | undefined,
      category: category as StackMartCategory | undefined,
      subcategory: subcategory as string | undefined,
    });

    if (!result) {
      res.status(503).json({ error: 'StackMart API unavailable' });
      return;
    }

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to search StackMart' });
  }
});

// GET /api/management/stackmart/resources/:resourceId - Get resource details
router.get('/stackmart/resources/:resourceId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { resourceId } = req.params;

    if (!isValidResourceId(resourceId)) {
      res.status(400).json({ error: 'Invalid resource ID format' });
      return;
    }

    const result = await stackmartGetDetails(resourceId);
    if (!result) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to get resource details' });
  }
});

// POST /api/management/stackmart/install - Install resource from StackMart
router.post('/stackmart/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { resourceId } = req.body;

    if (!resourceId || !isValidResourceId(resourceId)) {
      res.status(400).json({ success: false, error: 'Invalid resource ID' });
      return;
    }

    const result = await installResourceFromStackMart(resourceId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'install_stackmart',
        'mod',
        true,
        result.resourceName || resourceId,
        `Installed ${result.resourceName} v${result.version} from StackMart`
      );
    }

    res.json(result);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to install resource from StackMart' });
  }
});

// GET /api/management/stackmart/popular - Get popular resources
router.get('/stackmart/popular', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const resources = await getPopularResources(limit);
    res.json({ resources });
  } catch {
    res.status(500).json({ error: 'Failed to get popular resources' });
  }
});

// GET /api/management/stackmart/recent - Get recent resources
router.get('/stackmart/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const resources = await getRecentResources(limit);
    res.json({ resources });
  } catch {
    res.status(500).json({ error: 'Failed to get recent resources' });
  }
});

// GET /api/management/stackmart/categories - Get available categories
router.get('/stackmart/categories', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const categories = await stackmartGetCategories();
    res.json({ categories });
  } catch {
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// POST /api/management/stackmart/refresh - Clear StackMart cache
router.post('/stackmart/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    clearStackMartCache();
    res.json({ success: true, message: 'StackMart cache cleared' });
  } catch {
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// GET /api/management/stackmart/installed - Get installed StackMart resources
router.get('/stackmart/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const installed = await getInstalledStackMartInfo();
    res.json({ installed });
  } catch {
    res.status(500).json({ error: 'Failed to get installed resources' });
  }
});

// DELETE /api/management/stackmart/uninstall/:resourceId - Uninstall a StackMart resource
router.delete('/stackmart/uninstall/:resourceId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { resourceId } = req.params;

    if (!isValidResourceId(resourceId)) {
      res.status(400).json({ success: false, error: 'Invalid resource ID format' });
      return;
    }

    const result = await uninstallStackMart(resourceId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'uninstall_stackmart',
        'mod',
        true,
        resourceId,
        `Uninstalled StackMart resource: ${resourceId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('StackMart uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall resource' });
  }
});

export default router;
