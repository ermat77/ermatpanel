import { Router } from 'express';

// Import sub-routers
import whitelistRoutes from './management/whitelist.js';
import bansRoutes from './management/bans.js';
import permissionsRoutes from './management/permissions.js';
import worldsRoutes from './management/worlds.js';
import worldConfigRoutes from './management/worldConfig.js';
import modsRoutes from './management/mods.js';
import modConfigsRoutes from './management/modConfigs.js';
import activityRoutes from './management/activity.js';
import modStoreRoutes from './management/modStore.js';
import modtaleRoutes from './management/modtale.js';
import stackmartRoutes from './management/stackmart.js';
import statsRoutes, { addStatsEntry } from './management/stats.js';

// Re-export logActivity for backward compatibility (used by other routes)
export { logActivity } from '../services/activityLog.js';

// Re-export addStatsEntry for use by other modules
export { addStatsEntry };

const router = Router();

// Mount all sub-routers
router.use('/', whitelistRoutes);
router.use('/', bansRoutes);
router.use('/', permissionsRoutes);
router.use('/', worldsRoutes);
router.use('/', worldConfigRoutes);
router.use('/', modsRoutes);
router.use('/', modConfigsRoutes);
router.use('/', activityRoutes);
router.use('/', modStoreRoutes);
router.use('/', modtaleRoutes);
router.use('/', stackmartRoutes);
router.use('/', statsRoutes);

export default router;
