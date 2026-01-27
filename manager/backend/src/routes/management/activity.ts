import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { logActivity, getActivityLog, clearActivityLog, type ActivityLogEntry } from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

// GET /api/management/activity
router.get('/activity', authMiddleware, requirePermission('activity.view'), async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as ActivityLogEntry['category'] | undefined;
    const user = req.query.user as string | undefined;

    const result = getActivityLog({ limit, offset, category, user });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get activity log' });
  }
});

// DELETE /api/management/activity
router.delete('/activity', authMiddleware, requirePermission('activity.clear'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await clearActivityLog();

    await logActivity(
      req.user || 'unknown',
      'clear_activity_log',
      'system',
      true,
      undefined,
      'Cleared activity log'
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear activity log' });
  }
});

export default router;
