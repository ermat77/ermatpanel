import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import {
  downloadServerFiles,
  extractServerFiles,
  getDockerCpCommandIfReady,
} from '../services/serverFileDownloader.js';
import {
  downloadAndExtractGameFiles,
  checkGameFilesInstalled,
} from '../services/gameFilesService.js';

const router = Router();

/**
 * GET /api/server-files/docker-cp-command
 * Get the docker cp helper command when server files are extracted on the manager (for manual copy to game container).
 *
 * Response:
 * { dockerCp: { sourcePath, containerName, containerPath } | null }
 */
router.get('/docker-cp-command', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const dockerCp = getDockerCpCommandIfReady();
    res.json({ dockerCp });
  } catch (error) {
    res.status(500).json({
      dockerCp: null,
      error: error instanceof Error ? error.message : 'Failed to get docker cp command',
    });
  }
});

/**
 * GET /api/server-files/status
 * Check if server files are installed
 *
 * Response:
 * { installed: boolean, hasJar: boolean, hasAssets: boolean }
 */
router.get('/status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const result = await checkGameFilesInstalled();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      installed: false,
      hasJar: false,
      hasAssets: false,
      error: error instanceof Error ? error.message : 'Failed to check server files status',
    });
  }
});

/**
 * POST /api/server-files/download
 * Download server files using hytale-downloader
 *
 * Body (optional):
 * { patchline?: 'release' | 'pre-release' }
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/download', authMiddleware, requirePermission('server.restart'), async (req: Request, res: Response) => {
  try {
    const { patchline } = req.body;
    
    // Validate patchline if provided
    if (patchline && !['release', 'pre-release'].includes(patchline)) {
      res.status(400).json({
        success: false,
        error: 'Invalid patchline. Must be "release" or "pre-release"',
      });
      return;
    }

    const result = await downloadServerFiles(patchline);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download server files',
    });
  }
});

/**
 * POST /api/server-files/extract
 * Extract downloaded server files
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/extract', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    const result = await extractServerFiles();
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to extract server files',
    });
  }
});

/**
 * POST /api/server-files/download-and-extract
 * Download and extract server files (complete process)
 *
 * Body (optional):
 * { patchline?: 'release' | 'pre-release' }
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/download-and-extract', authMiddleware, requirePermission('server.restart'), async (req: Request, res: Response) => {
  try {
    const { patchline } = req.body;
    
    // Validate patchline if provided
    if (patchline && !['release', 'pre-release'].includes(patchline)) {
      res.status(400).json({
        success: false,
        error: 'Invalid patchline. Must be "release" or "pre-release"',
      });
      return;
    }

    const result = await downloadAndExtractGameFiles(patchline);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download and extract server files',
    });
  }
});

export default router;
