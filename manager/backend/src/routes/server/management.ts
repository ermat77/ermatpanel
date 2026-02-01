import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';

const router = Router();

// GET /api/server/status
router.get('/status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  const status = await dockerService.getStatus();
  res.json(status);
});

// GET /api/server/stats
router.get('/stats', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  const stats = await dockerService.getStats();
  res.json(stats);
});

// GET /api/server/memory - Get detailed memory stats from server command
router.get('/memory', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  try {
    const result = await dockerService.execCommand('/server stats memory');

    if (!result.success || !result.output) {
      res.json({
        available: false,
        error: result.error || 'Command not available',
      });
      return;
    }

    // Parse the output:
    // Total Physical Memory: 62.7 GiB
    // Free Physical Memory: 5.8 GiB
    // Total Swap Memory: 7.6 GiB
    // Free Swap Memory: 5.5 GiB
    // Heap Memory Usage:
    // Init: 4.0 GiB
    // Used: 1.2 GiB
    // Committed: 4.0 GiB
    // Max: 16.0 GiB

    const output = result.output;

    const parseValue = (pattern: RegExp): number | null => {
      const match = output.match(pattern);
      if (match) {
        return parseFloat(match[1]);
      }
      return null;
    };

    const memoryStats = {
      available: true,
      physical: {
        total: parseValue(/Total Physical Memory:\s*([\d.]+)\s*GiB/i),
        free: parseValue(/Free Physical Memory:\s*([\d.]+)\s*GiB/i),
      },
      swap: {
        total: parseValue(/Total Swap Memory:\s*([\d.]+)\s*GiB/i),
        free: parseValue(/Free Swap Memory:\s*([\d.]+)\s*GiB/i),
      },
      heap: {
        init: parseValue(/Init:\s*([\d.]+)\s*GiB/i),
        used: parseValue(/Used:\s*([\d.]+)\s*GiB/i),
        committed: parseValue(/Committed:\s*([\d.]+)\s*GiB/i),
        max: parseValue(/Max:\s*([\d.]+)\s*GiB/i),
      },
      raw: output,
    };

    res.json(memoryStats);
  } catch (error) {
    res.status(500).json({
      available: false,
      error: error instanceof Error ? error.message : 'Failed to get memory stats',
    });
  }
});

// POST /api/server/start
router.post('/start', authMiddleware, requirePermission('server.start'), async (_req: Request, res: Response) => {
  const result = await dockerService.startContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/stop
router.post('/stop', authMiddleware, requirePermission('server.stop'), async (_req: Request, res: Response) => {
  const result = await dockerService.stopContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/restart
router.post('/restart', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  const result = await dockerService.restartContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

export default router;
