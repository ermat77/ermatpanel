import { Router, Request, Response } from 'express';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { getWorldsPaths } from '../../services/worlds.js';
import * as fileAccess from '../../utils/fileAccess.js';
import type { WorldInfo, WorldFileInfo } from './types.js';

const router = Router();

async function scanWorldFiles(worldPath: string): Promise<WorldFileInfo[]> {
  const files: WorldFileInfo[] = [];
  console.log(`[Worlds] scanWorldFiles: Scanning files in: ${worldPath}`);
  
  // Scan root level JSON files (config.json, etc.)
  try {
    const rootEntries = await fileAccess.readServerDir(worldPath);
    console.log(`[Worlds] scanWorldFiles: Found ${rootEntries.length} entries in root`);
    
    for (const entryName of rootEntries) {
      if (!entryName.endsWith('.json') || entryName.endsWith('.bak')) {
        continue;
      }
      
      const filePath = path.posix.join(worldPath, entryName);
      try {
        const stats = await fileAccess.getServerFileStats(filePath);
        if (stats) {
          files.push({
            name: entryName,
            path: entryName,
            size: stats.size,
            lastModified: stats.modified.toISOString(),
          });
          console.log(`[Worlds] scanWorldFiles: Found file: ${entryName} (${stats.size} bytes)`);
        }
      } catch (error) {
        console.log(`[Worlds] scanWorldFiles: Could not get stats for ${entryName}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.log(`[Worlds] scanWorldFiles: Error reading root directory:`, error instanceof Error ? error.message : String(error));
  }

  // Scan resources folder
  const resourcesPath = path.posix.join(worldPath, 'resources');
  try {
    const resourceEntries = await fileAccess.readServerDir(resourcesPath);
    console.log(`[Worlds] scanWorldFiles: Found ${resourceEntries.length} entries in resources`);
    
    for (const entryName of resourceEntries) {
      if (!entryName.endsWith('.json') || entryName.endsWith('.bak')) {
        continue;
      }
      
      const filePath = path.posix.join(resourcesPath, entryName);
      try {
        const stats = await fileAccess.getServerFileStats(filePath);
        if (stats) {
          files.push({
            name: entryName,
            path: `resources/${entryName}`,
            size: stats.size,
            lastModified: stats.modified.toISOString(),
          });
          console.log(`[Worlds] scanWorldFiles: Found resource file: ${entryName} (${stats.size} bytes)`);
        }
      } catch (error) {
        console.log(`[Worlds] scanWorldFiles: Could not get stats for resources/${entryName}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.log(`[Worlds] scanWorldFiles: Resources folder doesn't exist or can't be read:`, error instanceof Error ? error.message : String(error));
  }

  console.log(`[Worlds] scanWorldFiles: Total files found: ${files.length}`);
  return files;
}

async function scanWorldsInPath(worldsPath: string, seenRealPaths: Set<string>): Promise<WorldInfo[]> {
  const worlds: WorldInfo[] = [];
  console.log(`[Worlds] scanWorldsInPath: Starting scan for path: ${worldsPath}`);
  
  try {
    console.log(`[Worlds] scanWorldsInPath: Attempting to read directory via Docker API: ${worldsPath}`);
    const entries = await fileAccess.readServerDir(worldsPath);
    console.log(`[Worlds] scanWorldsInPath: Found ${entries.length} entries in ${worldsPath}`);

    for (const entryName of entries) {
      console.log(`[Worlds] scanWorldsInPath: Processing entry: ${entryName}`);
      
      const entryPath = path.posix.join(worldsPath, entryName);
      console.log(`[Worlds] scanWorldsInPath: Full path: ${entryPath}`);
      
      try {
        // Check if this is a directory by trying to read it as a directory
        // If it succeeds, it's a directory; if it fails, it's a file
        let isDirectory = false;
        try {
          await fileAccess.readServerDir(entryPath);
          isDirectory = true;
          console.log(`[Worlds] scanWorldsInPath: ${entryName} is a directory`);
        } catch (dirError) {
          console.log(`[Worlds] scanWorldsInPath: ${entryName} is not a directory (or can't be read):`, dirError instanceof Error ? dirError.message : String(dirError));
          continue;
        }

        // Use the entry path as the "real" path (Docker API handles symlinks)
        // For symlink detection, we'll use a simpler approach - just track by entryPath
        const realEntryPath = entryPath;
        
        // Skip if we've already seen this path (prevents duplicates)
        if (seenRealPaths.has(realEntryPath)) {
          console.log(`[Worlds] scanWorldsInPath: Skipping ${entryName} - already seen path: ${realEntryPath}`);
          continue;
        }
        seenRealPaths.add(realEntryPath);
        console.log(`[Worlds] scanWorldsInPath: Added ${realEntryPath} to seenRealPaths`);

        console.log(`[Worlds] scanWorldsInPath: Getting stats for: ${entryPath}`);
        const stats = await fileAccess.getServerFileStats(entryPath);
        if (!stats) {
          console.log(`[Worlds] scanWorldsInPath: Could not get stats for ${entryName}, skipping`);
          continue;
        }
        console.log(`[Worlds] scanWorldsInPath: Stats for ${entryPath}: size=${stats.size}, modified=${stats.modified.toISOString()}`);

        // Check if this is a real world by looking for config.json
        const configPath = path.posix.join(entryPath, 'config.json');
        console.log(`[Worlds] scanWorldsInPath: Checking for config.json at: ${configPath}`);
        let hasConfig = false;
        try {
          const configStats = await fileAccess.getServerFileStats(configPath);
          if (configStats) {
            hasConfig = true;
            console.log(`[Worlds] scanWorldsInPath: Found config.json for ${entryName}`);
          } else {
            console.log(`[Worlds] scanWorldsInPath: No config.json found for ${entryName} (stats returned null)`);
          }
        } catch (configError) {
          console.log(`[Worlds] scanWorldsInPath: No config.json found for ${entryName}: ${configError instanceof Error ? configError.message : String(configError)}`);
        }

        // Scan all JSON files in this world
        console.log(`[Worlds] scanWorldsInPath: Scanning files in: ${entryPath}`);
        const files = await scanWorldFiles(entryPath);
        console.log(`[Worlds] scanWorldsInPath: Found ${files.length} JSON files in ${entryName}`);

        // Calculate total size
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        console.log(`[Worlds] scanWorldsInPath: Total size for ${entryName}: ${totalSize} bytes`);

        // Only include directories that have config.json (actual worlds)
        if (hasConfig) {
          console.log(`[Worlds] scanWorldsInPath: Adding world: ${entryName} (path: ${entryPath}, size: ${totalSize}, files: ${files.length})`);
          worlds.push({
            name: entryName,
            path: entryPath,
            size: totalSize,
            lastModified: stats.modified.toISOString(),
            hasConfig: true,
            files,
          });
        } else {
          console.log(`[Worlds] scanWorldsInPath: Skipping ${entryName} - no config.json found`);
        }
      } catch (entryError) {
        console.error(`[Worlds] scanWorldsInPath: Error processing entry ${entryName}:`, entryError instanceof Error ? entryError.message : String(entryError));
        if (entryError instanceof Error && 'code' in entryError) {
          console.error(`[Worlds] scanWorldsInPath: Error code: ${(entryError as NodeJS.ErrnoException).code}`);
        }
      }
    }
    
    console.log(`[Worlds] scanWorldsInPath: Completed scan for ${worldsPath}, found ${worlds.length} worlds`);
  } catch (error) {
    console.error(`[Worlds] scanWorldsInPath: Error reading directory ${worldsPath}:`, error instanceof Error ? error.message : String(error));
    if (error instanceof Error && 'code' in error) {
      console.error(`[Worlds] scanWorldsInPath: Error code: ${(error as NodeJS.ErrnoException).code}`);
    }
  }
  
  console.log(`[Worlds] scanWorldsInPath: Returning ${worlds.length} worlds from ${worldsPath}`);
  return worlds;
}

// GET /api/management/worlds
router.get('/worlds', authMiddleware, requirePermission('worlds.view'), async (_req: Request, res: Response) => {
  try {
    console.log('[Worlds] GET /worlds: Starting world scan');
    let worlds: WorldInfo[] = [];
    const checkedPaths: string[] = [];
    const seenRealPaths = new Set<string>(); // Track real paths to prevent symlink duplicates

    const worldPaths = getWorldsPaths();
    console.log(`[Worlds] GET /worlds: Checking ${worldPaths.length} possible world paths:`, worldPaths);

    // Check all possible world paths
    for (const worldsPath of worldPaths) {
      console.log(`[Worlds] GET /worlds: Checking path: ${worldsPath}`);
      checkedPaths.push(worldsPath);
      const found = await scanWorldsInPath(worldsPath, seenRealPaths);
      console.log(`[Worlds] GET /worlds: Found ${found.length} worlds in ${worldsPath}`);
      worlds.push(...found);
    }

    // Deduplicate worlds by name (same world might appear in multiple paths)
    const worldMap = new Map<string, WorldInfo>();
    for (const world of worlds) {
      if (!worldMap.has(world.name)) {
        worldMap.set(world.name, world);
      } else {
        // If duplicate found, keep the one with more files (more complete)
        const existing = worldMap.get(world.name)!;
        if (world.files.length > existing.files.length) {
          worldMap.set(world.name, world);
        }
      }
    }
    const uniqueWorlds = Array.from(worldMap.values());

    console.log(`[Worlds] GET /worlds: Total worlds found: ${worlds.length}, unique: ${uniqueWorlds.length}`);
    res.json({ worlds: uniqueWorlds, checkedPaths });
  } catch (error) {
    console.error('[Worlds] GET /worlds: Error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to read worlds' });
  }
});

export default router;
