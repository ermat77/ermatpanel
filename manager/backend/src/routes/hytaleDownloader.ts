import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import {
  isDownloaderInstalled,
  installDownloader,
  downloadDownloader,
  extractDownloader,
} from '../services/hytaleDownloader.js';

const router = Router();

/**
 * GET /api/hytale-downloader/status
 * Check if hytale-downloader is installed
 *
 * Response:
 * { installed: boolean, binaryPath?: string, error?: string }
 */
router.get('/status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const result = await isDownloaderInstalled();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      installed: false,
      error: error instanceof Error ? error.message : 'Failed to check downloader status',
    });
  }
});

/**
 * POST /api/hytale-downloader/install
 * Install hytale-downloader (download and extract)
 *
 * Response:
 * { success: boolean, binaryPath?: string, error?: string }
 */
router.post('/install', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    const result = await installDownloader();
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install downloader',
    });
  }
});

/**
 * POST /api/hytale-downloader/download
 * Download hytale-downloader.zip (without extracting)
 *
 * Response:
 * { success: boolean, tempPath?: string, error?: string }
 */
router.post('/download', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    const result = await downloadDownloader();
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download downloader',
    });
  }
});

/**
 * POST /api/hytale-downloader/extract
 * Extract hytale-downloader.zip
 *
 * Body:
 * { zipPath: string }
 *
 * Response:
 * { success: boolean, binaryPath?: string, error?: string }
 */
router.post('/extract', authMiddleware, requirePermission('server.restart'), async (req: Request, res: Response) => {
  try {
    const { zipPath } = req.body;
    if (!zipPath || typeof zipPath !== 'string') {
      res.status(400).json({
        success: false,
        error: 'zipPath is required',
      });
      return;
    }

    const result = await extractDownloader(zipPath);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to extract downloader',
    });
  }
});

export default router;
