import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { getPlayerInventoryFromFile, getPlayerDetailsFromFile } from '../../services/players.js';

const router = Router();

// GET /api/server/players/:name/file/details - Get player details from saved JSON file
router.get('/:name/file/details', authMiddleware, requirePermission('players.view'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const details = await getPlayerDetailsFromFile(name);
    if (!details) {
      res.status(404).json({
        success: false,
        error: 'Player not found or no saved data available'
      });
      return;
    }
    res.json({
      success: true,
      data: details
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to read player details',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/players/:name/file/inventory - Get player inventory from saved JSON file
router.get('/:name/file/inventory', authMiddleware, requirePermission('players.view'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const inventory = await getPlayerInventoryFromFile(name);
    if (!inventory) {
      res.status(404).json({
        success: false,
        error: 'Player not found or no saved inventory data available'
      });
      return;
    }
    res.json({
      success: true,
      data: inventory
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to read player inventory',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
