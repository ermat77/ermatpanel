import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import type { StatsEntry } from './types.js';

const router = Router();

const statsHistory: StatsEntry[] = [];
const MAX_STATS_HISTORY = 60; // Keep 60 entries (e.g., 1 hour at 1 per minute)

export function addStatsEntry(entry: Omit<StatsEntry, 'timestamp'>): void {
  statsHistory.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  // Keep only the last MAX_STATS_HISTORY entries
  while (statsHistory.length > MAX_STATS_HISTORY) {
    statsHistory.shift();
  }
}

// GET /api/management/stats/history
router.get('/stats/history', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  res.json({ history: statsHistory });
});

export default router;
