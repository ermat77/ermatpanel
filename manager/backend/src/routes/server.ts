import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';

// Import sub-routers
import managementRoutes from './server/management.js';
import configRoutes from './server/config.js';
import pluginRoutes from './server/plugin.js';
import playerFilesRoutes from './server/playerFiles.js';
import downloaderRoutes from './server/downloader.js';
import updatesRoutes from './server/updates.js';

const router = Router();

// Mount sub-routers
router.use('/', managementRoutes);
router.use('/', configRoutes);
router.use('/plugin', pluginRoutes);
router.use('/players', playerFilesRoutes);
router.use('/', downloaderRoutes); // Mounted at root to handle both /downloader/* and /check-update
router.use('/', updatesRoutes);

export default router;
