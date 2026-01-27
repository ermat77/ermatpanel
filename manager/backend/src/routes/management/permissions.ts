import { Router, Request, Response } from 'express';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import { logActivity } from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import type {
  HytalePermissionsData,
  PermissionUser,
  PermissionGroup,
  PermissionsDisplayData,
  PermissionsNameMapping,
} from './types.js';

const router = Router();

async function getPermissionsPath(): Promise<string> {
  return path.posix.join(config.hytaleContainerServerPath, 'permissions.json');
}

async function getPermissionsNameMappingPath(): Promise<string> {
  return path.posix.join(config.hytaleContainerServerPath, 'permissions-names.json');
}

async function readPermissionsNameMapping(): Promise<PermissionsNameMapping> {
  try {
    const content = await readFile(await getPermissionsNameMappingPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writePermissionsNameMapping(mapping: PermissionsNameMapping): Promise<void> {
  await writeFile(await getPermissionsNameMappingPath(), JSON.stringify(mapping, null, 2), 'utf-8');
}

async function readHytalePermissions(): Promise<HytalePermissionsData> {
  try {
    const content = await readFile(await getPermissionsPath(), 'utf-8');
    const data = JSON.parse(content);
    return {
      users: data.users || {},
      groups: data.groups || {},
    };
  } catch {
    return { users: {}, groups: {} };
  }
}

async function writeHytalePermissions(data: HytalePermissionsData): Promise<void> {
  await writeFile(await getPermissionsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// Convert Hytale format to display format
async function readPermissionsDisplay(): Promise<PermissionsDisplayData> {
  const hytale = await readHytalePermissions();
  const mapping = await readPermissionsNameMapping();

  const users: PermissionUser[] = Object.entries(hytale.users).map(([uuid, userData]) => ({
    uuid,
    name: mapping[uuid] || uuid.substring(0, 8) + '...',
    groups: userData.groups || [],
  }));

  const groups: PermissionGroup[] = Object.entries(hytale.groups).map(([name, permissions]) => ({
    name,
    permissions: permissions || [],
  }));

  return { users, groups };
}

// GET /api/management/permissions
router.get('/permissions', authMiddleware, requirePermission('players.permissions'), async (_req: Request, res: Response) => {
  try {
    const data = await readPermissionsDisplay();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read permissions' });
  }
});

// POST /api/management/permissions/users
router.post('/permissions/users', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, uuid, groups } = req.body;
    const username = req.user || 'system';
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }

    const hytale = await readHytalePermissions();
    const mapping = await readPermissionsNameMapping();

    // If UUID provided, use it; otherwise we need to get it from the server
    let targetUuid = uuid;

    if (!targetUuid) {
      // Try to find existing UUID for this player name in mapping
      const existingEntry = Object.entries(mapping).find(([, n]) => n === name);
      if (existingEntry) {
        targetUuid = existingEntry[0];
      } else {
        // Generate a placeholder - the server will use the correct UUID when the player joins
        // For now, store the name as a temporary key
        targetUuid = `name:${name}`;
      }
    }

    // Update Hytale permissions
    hytale.users[targetUuid] = { groups: groups || [] };
    await writeHytalePermissions(hytale);

    // Update name mapping
    mapping[targetUuid] = name;
    await writePermissionsNameMapping(mapping);

    await logActivity(username, 'permissions_user_update', 'user', true, name, `Groups: ${(groups || []).join(', ') || 'none'}`);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, users: displayData.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user permissions' });
  }
});

// DELETE /api/management/permissions/users/:identifier (can be UUID or name)
router.delete('/permissions/users/:identifier', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { identifier } = req.params;
    const username = req.user || 'system';
    const hytale = await readHytalePermissions();
    const mapping = await readPermissionsNameMapping();

    // Try to find the UUID - identifier could be UUID or name
    let targetUuid = identifier;
    let displayName = identifier;
    if (!hytale.users[identifier]) {
      // Not a UUID, try to find by name
      const entry = Object.entries(mapping).find(([, name]) => name === identifier);
      if (entry) {
        targetUuid = entry[0];
        displayName = entry[1];
      }
    } else {
      displayName = mapping[identifier] || identifier;
    }

    // Remove from Hytale permissions
    delete hytale.users[targetUuid];
    await writeHytalePermissions(hytale);

    await logActivity(username, 'permissions_user_remove', 'user', true, displayName);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, users: displayData.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// POST /api/management/permissions/groups
router.post('/permissions/groups', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, permissions } = req.body;
    const username = req.user || 'system';
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }

    const hytale = await readHytalePermissions();

    // Update group permissions (Hytale format: groups are objects with permission arrays)
    hytale.groups[name] = permissions || [];
    await writeHytalePermissions(hytale);

    await logActivity(username, 'permissions_group_update', 'user', true, name, `Permissions: ${(permissions || []).length} entries`);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, groups: displayData.groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// DELETE /api/management/permissions/groups/:name
router.delete('/permissions/groups/:name', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.params;
    const username = req.user || 'system';
    const hytale = await readHytalePermissions();

    // Remove group from Hytale permissions
    delete hytale.groups[name];
    await writeHytalePermissions(hytale);

    await logActivity(username, 'permissions_group_remove', 'user', true, name);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, groups: displayData.groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove group' });
  }
});

export default router;
