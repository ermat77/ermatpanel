/**
 * KyuubiSoft API Plugin Service
 *
 * Manages the KyuubiSoft API plugin that provides accurate player data,
 * server statistics, and real-time events via HTTP/WebSocket.
 */

import { config, isDevelopmentMode } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fileAccess from '../utils/fileAccess.js';
import * as dockerService from './docker.js';
import {
  isDemoMode,
  getDemoPerformanceMetrics,
  getDemoJvmMetrics,
  getDemoOnlinePlayers,
  getDemoPlayerDetails,
  getDemoPlayerInventory,
} from './demoData.js';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin version (should match the built JAR version)
export const PLUGIN_VERSION = '1.2.1';
export const PLUGIN_PORT = 18085;
export const PLUGIN_JAR_NAME = `KyuubiSoftAPI-${PLUGIN_VERSION}.jar`;

/**
 * Clean filename by removing control characters and trimming whitespace
 * Docker API sometimes returns filenames with control characters (like \x1D)
 */
function cleanFilename(filename: string): string {
  // Remove control characters (0x00-0x1F) except newline, carriage return, tab
  return filename.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
}

export interface PluginStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  filename: string | null;
  port: number;
  error?: string;
}

export interface PluginApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Check if the KyuubiSoft API plugin is installed in the plugins folder
 * Uses Docker API in dev mode, direct filesystem access in production
 */
export async function isPluginInstalled(): Promise<boolean> {
  // Demo mode: always report plugin as installed
  if (isDemoMode()) {
    return true;
  }

  try {
    const modsPath = config.hytaleContainerModsPath;
    console.log(modsPath);
    const files = await fileAccess.readServerDir(modsPath);
    console.log(`[KyuubiAPI] Found files:`, files);
    // Check for any KyuubiSoftAPI jar file
    return files.some(file => {
      const cleanedFile = cleanFilename(file);
      return cleanedFile.toLowerCase().startsWith('kyuubisoftapi') &&
        cleanedFile.endsWith('.jar') &&
        !cleanedFile.endsWith('.disabled');
    });
  } catch {
    return false;
  }
}

/**
 * Get the installed plugin version
 * Uses Docker API in dev mode, direct filesystem access in production
 */
export async function getInstalledVersion(): Promise<string | null> {
  // Demo mode: return current plugin version
  if (isDemoMode()) {
    return PLUGIN_VERSION;
  }

  try {
    const modsPath = config.hytaleContainerModsPath;
    const files = await fileAccess.readServerDir(modsPath);

    const pluginFile = files.find(file => {
      const cleanedFile = cleanFilename(file);
      return cleanedFile.toLowerCase().startsWith('kyuubisoftapi') &&
        cleanedFile.endsWith('.jar') &&
        !cleanedFile.endsWith('.disabled');
    });

    if (pluginFile) {
      // Extract version from filename: KyuubiSoftAPI-1.0.0.jar
      const cleanedFile = cleanFilename(pluginFile);
      const match = cleanedFile.match(/KyuubiSoftAPI-(\d+\.\d+\.\d+)\.jar/i);
      return match ? match[1] : 'unknown';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the installed plugin filename
 * Uses Docker API in dev mode, direct filesystem access in production
 */
export async function getPluginFilename(): Promise<string | null> {
  // Demo mode: return demo filename
  if (isDemoMode()) {
    return PLUGIN_JAR_NAME;
  }

  try {
    const modsPath = config.hytaleContainerModsPath;
    const files = await fileAccess.readServerDir(modsPath);
    console.log(files);
    const pluginFile = files.find(file => {
      const cleanedFile = cleanFilename(file);
      return cleanedFile.toLowerCase().startsWith('kyuubisoftapi') &&
        cleanedFile.endsWith('.jar') &&
        !cleanedFile.endsWith('.disabled');
    });

    console.log(`[KyuubiAPI] Plugin file: ${pluginFile ? cleanFilename(pluginFile) : pluginFile}`);

    return pluginFile ? cleanFilename(pluginFile) : null;
  } catch {
    return null;
  }
}

/**
 * Get the host for connecting to the plugin API
 * 
 * In development mode (.env.dev):
 *   - Backend runs locally, plugin runs in Docker container
 *   - Use 'localhost' since port 18085 is exposed from container to host
 * 
 * In production mode:
 *   - Backend runs in Docker, plugin runs in same/connected container
 *   - Use container name for Docker network resolution
 */
function getPluginHost(): string {
  // Check if we're in development mode (using .env.dev)
  // In dev mode, backend is local and connects to exposed port on localhost
  // In production, backend is in Docker and uses container name for network resolution
  const backendInDocker = fs.existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER;
  
  if (isDevelopmentMode || !backendInDocker) {
    // Development mode: Backend is local, plugin port is exposed to host
    const host = 'localhost';
    console.log(`[KyuubiAPI] Using plugin host: ${host} (dev mode, port exposed from container)`);
    console.log(`[KyuubiAPI]   Development mode: ${isDevelopmentMode}`);
    console.log(`[KyuubiAPI]   Backend in Docker: ${backendInDocker}`);
    console.log(`[KyuubiAPI]   Plugin URL: http://${host}:${PLUGIN_PORT}`);
    return host;
  }
  
  // Production mode: Backend is in Docker, use container name for network resolution
  const host = config.gameContainerName;
  console.log(`[KyuubiAPI] Using plugin host: ${host} (production, Docker network)`);
  console.log(`[KyuubiAPI]   Development mode: ${isDevelopmentMode}`);
  console.log(`[KyuubiAPI]   Backend in Docker: ${backendInDocker}`);
  console.log(`[KyuubiAPI]   Plugin URL: http://${host}:${PLUGIN_PORT}`);
  return host;
}

/**
 * Check if the KyuubiSoft API plugin is running and responding
 */
export async function isPluginRunning(): Promise<boolean> {
  // Demo mode: always report plugin as running
  if (isDemoMode()) {
    return true;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const host = getPluginHost();
    const url = `http://${host}:${PLUGIN_PORT}/api/server/info`;
    console.log(`[KyuubiAPI] Checking if plugin is running: ${url}`);
    
    const response = await fetch(url, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const isRunning = response.ok;
    console.log(`[KyuubiAPI] Plugin running check: ${isRunning ? '✅ Running' : '❌ Not responding (HTTP ' + response.status + ')'}`);
    return isRunning;
  } catch (error) {
    const host = getPluginHost();
    const url = `http://${host}:${PLUGIN_PORT}/api/server/info`;
    console.error(`[KyuubiAPI] ❌ Plugin running check failed: ${url}`, error);
    return false;
  }
}

/**
 * Get full plugin status
 */
export async function getPluginStatus(): Promise<PluginStatus> {
  const installed = await isPluginInstalled();
  const version = await getInstalledVersion();
  const filename = await getPluginFilename();
  console.log(`[KyuubiAPI] Plugin status:`, { installed, version, filename });
  if (!installed) {
    return {
      installed: false,
      running: false,
      version: null,
      filename: null,
      port: PLUGIN_PORT,
    };
  }

  const running = await isPluginRunning();

  return {
    installed: true,
    running,
    version,
    filename,
    port: PLUGIN_PORT,
  };
}

/**
 * Get data from the KyuubiSoft API plugin
 */
export async function fetchFromPlugin<T>(endpoint: string): Promise<PluginApiResponse & { data?: T }> {
  // Demo mode: return mock data based on endpoint
  if (isDemoMode()) {
    return getDemoPluginResponse<T>(endpoint);
  }

  const host = getPluginHost();
  const url = `http://${host}:${PLUGIN_PORT}${endpoint}`;
  console.log(`[KyuubiAPI] Fetching from plugin: ${url}`);
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      // Handle network errors (ECONNREFUSED, ETIMEDOUT, etc.)
      let errorMessage = 'Network error';
      let errorCode = '';
      
      if (fetchError instanceof Error) {
        errorMessage = fetchError.message;
        // Extract error code if available (Node.js fetch errors)
        if ('code' in fetchError) {
          errorCode = (fetchError as { code?: string }).code || '';
        }
        // Check for common error codes
        if (errorMessage.includes('ECONNREFUSED') || errorCode === 'ECONNREFUSED') {
          errorMessage = 'Connection refused - plugin may not be running or port not exposed';
        } else if (errorMessage.includes('ETIMEDOUT') || errorCode === 'ETIMEDOUT') {
          errorMessage = 'Connection timeout - plugin may not be responding';
        } else if (errorMessage.includes('ENOTFOUND') || errorCode === 'ENOTFOUND') {
          errorMessage = 'Host not found - check container name/host configuration';
        }
      }
      
      console.error(`[KyuubiAPI] ❌ Network error connecting to plugin: ${url}`);
      console.error(`[KyuubiAPI]   Error: ${errorMessage}`);
      if (errorCode) {
        console.error(`[KyuubiAPI]   Error code: ${errorCode}`);
      }
      console.error(`[KyuubiAPI]   Full error:`, fetchError);
      console.error(`[KyuubiAPI]   Troubleshooting:`);
      console.error(`[KyuubiAPI]     - Is the plugin JAR installed in /opt/hytale/plugins?`);
      console.error(`[KyuubiAPI]     - Is the server running?`);
      console.error(`[KyuubiAPI]     - Is port 18085 exposed? (check: docker ps)`);
      console.error(`[KyuubiAPI]     - Is the plugin listening on 0.0.0.0:18085? (not just 127.0.0.1)`);
      
      return {
        success: false,
        error: `Connection failed: ${errorMessage}. Is the plugin running and port 18085 exposed?`
      };
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // Ignore error reading response body
      }
      console.error(`[KyuubiAPI] Plugin API error: HTTP ${response.status} for ${url}`, errorBody ? `Body: ${errorBody.substring(0, 200)}` : '');
      return { 
        success: false, 
        error: `HTTP ${response.status}: ${response.statusText}` 
      };
    }

    let data: T;
    try {
      data = await response.json() as T;
    } catch (parseError) {
      console.error(`[KyuubiAPI] ❌ Failed to parse JSON response from plugin: ${url}`, parseError);
      return {
        success: false,
        error: 'Invalid JSON response from plugin'
      };
    }

    console.log(`[KyuubiAPI] ✅ Successfully fetched from plugin: ${endpoint}`);
    return { success: true, data };
  } catch (error) {
    // Catch any other unexpected errors
    console.error(`[KyuubiAPI] ❌ Unexpected error fetching from plugin: ${url}`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin'
    };
  }
}

/**
 * Demo mode: Generate mock plugin responses
 */
function getDemoPluginResponse<T>(endpoint: string): PluginApiResponse & { data?: T } {
  if (endpoint === '/api/server/info') {
    const metrics = getDemoPerformanceMetrics();
    return {
      success: true,
      data: {
        serverName: 'KyuubiSoft Demo Server',
        version: '1.0.0',
        tps: metrics.tps,
        mspt: metrics.mspt,
        playerCount: metrics.playerCount,
        maxPlayers: 100,
        uptime: metrics.uptime,
        worldTime: metrics.worldTime,
        weather: metrics.weather,
      } as T,
    };
  }

  if (endpoint === '/api/server/memory') {
    const jvm = getDemoJvmMetrics();
    return {
      success: true,
      data: {
        heapUsed: jvm.heapUsed,
        heapMax: jvm.heapMax,
        heapPercent: jvm.heapPercent,
        gcCount: jvm.gcCount,
        gcTime: jvm.gcTime,
        threads: jvm.threads,
        cpuLoad: jvm.cpuLoad,
      } as T,
    };
  }

  if (endpoint === '/api/players') {
    const players = getDemoOnlinePlayers();
    return {
      success: true,
      data: players.map(p => ({
        name: p.name,
        uuid: `demo-uuid-${p.name}`,
        world: 'Orbis',
        online: true,
        joinedAt: p.joined_at,
      })) as T,
    };
  }

  if (endpoint.startsWith('/api/players/') && endpoint.endsWith('/details')) {
    const playerName = endpoint.split('/')[3];
    const details = getDemoPlayerDetails(playerName);
    return {
      success: true,
      data: details as T,
    };
  }

  if (endpoint.startsWith('/api/players/') && endpoint.endsWith('/inventory')) {
    const playerName = endpoint.split('/')[3];
    const inventory = getDemoPlayerInventory(playerName);
    return {
      success: true,
      data: inventory as T,
    };
  }

  return { success: true, data: {} as T };
}

/**
 * POST to the KyuubiSoft API plugin (for actions)
 */
export async function postToPlugin<T>(endpoint: string, body?: unknown): Promise<PluginApiResponse & { data?: T }> {
  // Demo mode: simulate successful actions
  if (isDemoMode()) {
    return { success: true, data: { message: '[DEMO] Action executed successfully' } as T };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const host = getPluginHost();
    const url = `http://${host}:${PLUGIN_PORT}${endpoint}`;
    console.log(`[KyuubiAPI] POSTing to plugin: ${url}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[KyuubiAPI] Plugin API error: HTTP ${response.status} for ${url}`);
    }

    const data = await response.json() as Record<string, unknown>;
    console.log(`[KyuubiAPI] ✅ Successfully posted to plugin: ${endpoint}`);
    return {
      success: response.ok,
      data: data.data as T,
      error: data.error as string | undefined,
    };
  } catch (error) {
    const host = getPluginHost();
    const url = `http://${host}:${PLUGIN_PORT}${endpoint}`;
    console.error(`[KyuubiAPI] ❌ Failed to POST to plugin: ${url}`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin'
    };
  }
}

/**
 * Get players from the plugin API (more accurate than log parsing)
 */
export async function getPlayersFromPlugin(): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/players');
}

/**
 * Get server info from the plugin API
 */
export async function getServerInfoFromPlugin(): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/server/info');
}

/**
 * Get memory stats from the plugin API
 */
export async function getMemoryFromPlugin(): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/server/memory');
}

/**
 * Get Prometheus metrics from the plugin API
 * Returns raw Prometheus text format
 */
export async function getPrometheusMetrics(): Promise<{ success: boolean; data?: string; error?: string }> {
  // Demo mode: return mock Prometheus metrics
  if (isDemoMode()) {
    const metrics = getDemoPerformanceMetrics();
    const jvm = getDemoJvmMetrics();
    const prometheusData = `# HELP hytale_tps Server TPS
# TYPE hytale_tps gauge
hytale_tps ${metrics.tps.toFixed(2)}
# HELP hytale_mspt Server MSPT
# TYPE hytale_mspt gauge
hytale_mspt ${metrics.mspt.toFixed(2)}
# HELP hytale_player_count Online player count
# TYPE hytale_player_count gauge
hytale_player_count ${metrics.playerCount}
# HELP hytale_uptime_seconds Server uptime in seconds
# TYPE hytale_uptime_seconds counter
hytale_uptime_seconds ${metrics.uptime}
# HELP jvm_memory_used_bytes JVM memory used
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes ${jvm.heapUsed * 1024 * 1024}
# HELP jvm_memory_max_bytes JVM memory max
# TYPE jvm_memory_max_bytes gauge
jvm_memory_max_bytes ${jvm.heapMax * 1024 * 1024}
# HELP jvm_threads_current Current thread count
# TYPE jvm_threads_current gauge
jvm_threads_current ${jvm.threads}
`;
    return { success: true, data: prometheusData };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const host = getPluginHost();
    const url = `http://${host}:${PLUGIN_PORT}/metrics`;
    console.log(`[KyuubiAPI] Fetching Prometheus metrics from plugin: ${url}`);
    
    const response = await fetch(url, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[KyuubiAPI] Plugin metrics error: HTTP ${response.status} for ${url}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.text();
    console.log(`[KyuubiAPI] ✅ Successfully fetched Prometheus metrics (${data.length} bytes)`);
    return { success: true, data };
  } catch (error) {
    const host = getPluginHost();
    const url = `http://${host}:${PLUGIN_PORT}/metrics`;
    console.error(`[KyuubiAPI] ❌ Failed to fetch Prometheus metrics: ${url}`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin'
    };
  }
}

/**
 * Get player details from the plugin API
 */
export async function getPlayerDetailsFromPlugin(playerName: string): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/details`);
}

/**
 * Get player inventory from the plugin API
 */
export async function getPlayerInventoryFromPlugin(playerName: string): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/inventory`);
}

/**
 * Get player appearance from the plugin API
 */
export async function getPlayerAppearanceFromPlugin(playerName: string): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/appearance`);
}

/**
 * Heal a player via the plugin API
 */
export async function healPlayerViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/heal`);
}

/**
 * Clear a player's inventory via the plugin API
 */
export async function clearInventoryViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/inventory/clear`);
}

/**
 * Set a player's gamemode via the plugin API
 */
export async function setGamemodeViaPlugin(playerName: string, gamemode: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/gamemode`, { gamemode });
}

/**
 * Kill a player via the plugin API
 */
export async function killPlayerViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/kill`);
}

/**
 * Respawn a player via the plugin API
 */
export async function respawnPlayerViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/respawn`);
}

/**
 * Teleport a player via the plugin API
 */
export async function teleportPlayerViaPlugin(
  playerName: string,
  options: { target?: string; x?: number; y?: number; z?: number }
): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/teleport`, options);
}

/**
 * Check if plugin update is available
 * Uses Docker API in dev mode, direct filesystem access in production
 */
export async function isUpdateAvailable(): Promise<{ available: boolean; currentVersion: string | null; latestVersion: string }> {
  const currentVersion = await getInstalledVersion();

  return {
    available: currentVersion !== null && currentVersion !== PLUGIN_VERSION,
    currentVersion,
    latestVersion: PLUGIN_VERSION,
  };
}

/**
 * Get the path to the bundled plugin JAR
 */
export function getBundledPluginPath(): string {
  // Try multiple possible locations for the plugin JAR
  const possiblePaths = [
    // Relative to module location (works for both src/ and dist/)
    path.join(__dirname, '..', '..', 'assets', 'plugins', PLUGIN_JAR_NAME),
    // Docker container path (/app/assets/plugins/)
    path.join('/app', 'assets', 'plugins', PLUGIN_JAR_NAME),
    // Relative to cwd (fallback for development)
    path.join(process.cwd(), 'assets', 'plugins', PLUGIN_JAR_NAME),
    // Manager backend directory
    path.join(process.cwd(), 'manager', 'backend', 'assets', 'plugins', PLUGIN_JAR_NAME),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Return the first path as default (will trigger proper error in installPlugin)
  return possiblePaths[0];
}

/**
 * Install the KyuubiSoft API plugin
 * Uses Docker API in dev mode, direct filesystem access in production
 */
export async function installPlugin(): Promise<{ success: boolean; error?: string }> {
  console.log('[KyuubiAPI] ========== Starting plugin installation ==========');
  
  try {
    // Get bundled plugin path
    const bundledPath = getBundledPluginPath();
    console.log(`[KyuubiAPI] Bundled plugin path: ${bundledPath}`);
    console.log(`[KyuubiAPI] Bundled path exists: ${fs.existsSync(bundledPath)}`);
    
    // Get target installation path
    // Use hytaleContainerModsPath for container operations
    // Normalize to forward slashes for container paths (handles Windows backslashes)
    let modsPathNormalized = config.hytaleContainerModsPath.trim().replace(/\\/g, '/');
    // Remove any trailing slashes
    modsPathNormalized = modsPathNormalized.replace(/\/+$/, '');
    
    // Log warning if path doesn't look like a container path (doesn't start with /)
    // This indicates a configuration issue, but we'll still try to use it
    if (!modsPathNormalized.startsWith('/')) {
      console.warn(`[KyuubiAPI] ⚠️  hytaleContainerModsPath doesn't start with / (not a container path): ${modsPathNormalized}`);
      console.warn(`[KyuubiAPI]   Expected container path like /opt/hytale/mods`);
      console.warn(`[KyuubiAPI]   This might cause issues when using Docker API`);
    }
    
    // Use posix.join to ensure proper path construction
    const targetPath = path.posix.join(modsPathNormalized, PLUGIN_JAR_NAME);
    // Ensure we have a clean absolute path
    const normalizedTargetPath = path.posix.normalize(targetPath);
    console.log(`[KyuubiAPI] Target installation path: ${normalizedTargetPath}`);
    console.log(`[KyuubiAPI] Target path directory: ${path.posix.dirname(normalizedTargetPath)}`);
    console.log(`[KyuubiAPI] Plugin JAR name: ${PLUGIN_JAR_NAME}`);
    console.log(`[KyuubiAPI] Plugin version: ${PLUGIN_VERSION}`);
    console.log(`[KyuubiAPI] Original hytaleContainerModsPath from config: ${config.hytaleContainerModsPath}`);
    console.log(`[KyuubiAPI] Normalized modsPath: ${modsPathNormalized}`);

    // Check if bundled JAR exists
    if (!fs.existsSync(bundledPath)) {
      console.error(`[KyuubiAPI] ❌ Plugin JAR not found at bundled path: ${bundledPath}`);
      console.error(`[KyuubiAPI]   Current working directory: ${process.cwd()}`);
      console.error(`[KyuubiAPI]   __dirname: ${__dirname}`);
      return { success: false, error: 'Plugin JAR not found in assets' };
    }
    
    // Get file stats for bundled JAR
    try {
      const bundledStats = fs.statSync(bundledPath);
      console.log(`[KyuubiAPI] Bundled JAR file size: ${bundledStats.size} bytes`);
      console.log(`[KyuubiAPI] Bundled JAR modified: ${bundledStats.mtime.toISOString()}`);
    } catch (statError) {
      console.warn(`[KyuubiAPI] ⚠️  Could not get bundled JAR stats:`, statError);
    }

    // Check if we're in local development (backend not in Docker)
    const dockerEnvExists = fs.existsSync('/.dockerenv');
    const dockerContainerEnv = process.env.DOCKER_CONTAINER;
    const backendInDocker = dockerEnvExists || !!dockerContainerEnv;
    const isLocalDev = !backendInDocker;
    
    console.log(`[KyuubiAPI] Environment detection:`);
    console.log(`[KyuubiAPI]   /.dockerenv exists: ${dockerEnvExists}`);
    console.log(`[KyuubiAPI]   DOCKER_CONTAINER env: ${dockerContainerEnv || 'not set'}`);
    console.log(`[KyuubiAPI]   Backend in Docker: ${backendInDocker}`);
    console.log(`[KyuubiAPI]   Is local dev mode: ${isLocalDev}`);

    // Remove old versions
    // Use the normalized path (container path in dev mode)
    const modsPath = modsPathNormalized;
    console.log(`[KyuubiAPI] Plugins directory path: ${modsPath}`);
    
    console.log(`[KyuubiAPI] Reading plugins directory...`);
    const files = await fileAccess.readServerDir(modsPath);
    console.log(`[KyuubiAPI] Found ${files.length} files in plugins directory`);
    console.log(`[KyuubiAPI] Files list:`, files);
    
    let oldVersionsRemoved = 0;
    for (const file of files) {
      const cleanedFile = cleanFilename(file);
      if (cleanedFile.toLowerCase().startsWith('kyuubisoftapi') && cleanedFile.endsWith('.jar')) {
        console.log(`[KyuubiAPI] Found old plugin version: ${cleanedFile}`);
        
        // Use posix.join to ensure forward slashes for container paths
        const oldFilePath = path.posix.join(modsPath, file);
        console.log(`[KyuubiAPI] Old file path (posix): ${oldFilePath}`);
        
        if (isLocalDev) {
          // Dev mode: Use Docker API to delete
          console.log(`[KyuubiAPI] Removing old version via Docker API: ${oldFilePath}`);
          try {
            await dockerService.execCommand(`rm -f "${oldFilePath}"`);
            console.log(`[KyuubiAPI] ✅ Successfully removed old version: ${file}`);
            oldVersionsRemoved++;
          } catch (deleteError) {
            console.error(`[KyuubiAPI] ❌ Failed to remove old version via Docker: ${file}`, deleteError);
            throw deleteError;
          }
        } else {
          // Production: Use direct filesystem access (path.join is fine here as backend is in Docker)
          const fsPath = path.join(modsPath, file);
          console.log(`[KyuubiAPI] Removing old version via filesystem: ${fsPath}`);
          try {
            fs.unlinkSync(fsPath);
            console.log(`[KyuubiAPI] ✅ Successfully removed old version: ${file}`);
            oldVersionsRemoved++;
          } catch (deleteError) {
            console.error(`[KyuubiAPI] ❌ Failed to remove old version via filesystem: ${fsPath}`, deleteError);
            throw deleteError;
          }
        }
      }
    }
    
    if (oldVersionsRemoved === 0) {
      console.log(`[KyuubiAPI] No old plugin versions found to remove`);
    } else {
      console.log(`[KyuubiAPI] Removed ${oldVersionsRemoved} old plugin version(s)`);
    }

    // Copy new version
    console.log(`[KyuubiAPI] Copying new plugin version...`);
    console.log(`[KyuubiAPI]   Source: ${bundledPath}`);
    console.log(`[KyuubiAPI]   Target: ${normalizedTargetPath}`);
    
    if (isLocalDev) {
      // Dev mode: Use Docker API to copy (normalizedTargetPath already normalized in installPlugin)
      console.log(`[KyuubiAPI] Using Docker API to copy file to container`);
      console.log(`[KyuubiAPI]   Source (host): ${bundledPath}`);
      console.log(`[KyuubiAPI]   Target (container): ${normalizedTargetPath}`);
      
      try {
        await dockerService.copyFileToContainer(bundledPath, normalizedTargetPath);
        console.log(`[KyuubiAPI] ✅ Successfully copied plugin via Docker API`);
        
        // Verify the file was copied
        // Use absolute path with forward slashes for the verification command
        const verifyPath = normalizedTargetPath; // Already normalized to absolute path with forward slashes
        console.log(`[KyuubiAPI] Verifying plugin at path: ${verifyPath}`);
        try {
          // Use absolute path starting with / for the command
          const verifyResult = await dockerService.execCommand(`test -f "${verifyPath}" && echo "EXISTS" || echo "NOT_FOUND"`);
          console.log(`[KyuubiAPI] Verification result:`, verifyResult);
          if (verifyResult.output?.includes('EXISTS')) {
            console.log(`[KyuubiAPI] ✅ Verified: Plugin file exists at target path: ${verifyPath}`);
          } else {
            console.warn(`[KyuubiAPI] ⚠️  Warning: Could not verify plugin file at target path: ${verifyPath}`);
            console.warn(`[KyuubiAPI]   Verification output: ${verifyResult.output || 'no output'}`);
          }
        } catch (verifyError) {
          console.warn(`[KyuubiAPI] ⚠️  Could not verify plugin installation:`, verifyError);
        }
      } catch (copyError) {
        console.error(`[KyuubiAPI] ❌ Failed to copy plugin via Docker API:`, copyError);
        throw copyError;
      }
    } else {
      // Production: Use direct filesystem access (path.join is fine here as backend is in Docker)
      console.log(`[KyuubiAPI] Using direct filesystem access to copy file`);
      console.log(`[KyuubiAPI]   Source: ${bundledPath}`);
      console.log(`[KyuubiAPI]   Target: ${normalizedTargetPath}`);
      
      try {
        // Ensure target directory exists
        const targetDir = path.dirname(normalizedTargetPath);
        if (!fs.existsSync(targetDir)) {
          console.log(`[KyuubiAPI] Creating target directory: ${targetDir}`);
          fs.mkdirSync(targetDir, { recursive: true });
        }
        
        fs.copyFileSync(bundledPath, normalizedTargetPath);
        console.log(`[KyuubiAPI] ✅ Successfully copied plugin via filesystem`);
        
        // Verify the file was copied
        if (fs.existsSync(normalizedTargetPath)) {
          const targetStats = fs.statSync(normalizedTargetPath);
          console.log(`[KyuubiAPI] ✅ Verified: Plugin file exists at target path`);
          console.log(`[KyuubiAPI]   Target file size: ${targetStats.size} bytes`);
          console.log(`[KyuubiAPI]   Target file modified: ${targetStats.mtime.toISOString()}`);
          
          // Compare file sizes
          const bundledStats = fs.statSync(bundledPath);
          if (bundledStats.size === targetStats.size) {
            console.log(`[KyuubiAPI] ✅ File sizes match (${bundledStats.size} bytes)`);
          } else {
            console.warn(`[KyuubiAPI] ⚠️  File size mismatch! Source: ${bundledStats.size}, Target: ${targetStats.size}`);
          }
        } else {
          console.error(`[KyuubiAPI] ❌ Verification failed: Target file does not exist after copy`);
        }
      } catch (copyError) {
        console.error(`[KyuubiAPI] ❌ Failed to copy plugin via filesystem:`, copyError);
        throw copyError;
      }
    }

    console.log(`[KyuubiAPI] ========== Plugin installation completed successfully ==========`);
    return { success: true };
  } catch (error) {
    console.error(`[KyuubiAPI] ========== Plugin installation failed ==========`);
    console.error(`[KyuubiAPI] Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
    console.error(`[KyuubiAPI] Error message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(`[KyuubiAPI] Error stack:`, error.stack);
    }
    console.error(`[KyuubiAPI] Full error object:`, error);
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install plugin'
    };
  }
}

/**
 * Get detailed plugin diagnostics
 * Checks plugin installation, port listening, and server logs
 */
export async function getPluginDiagnostics(): Promise<{
  pluginInstalled: boolean;
  pluginFilename: string | null;
  portListening: boolean;
  portCheckError?: string;
  pluginLogsFound: boolean;
  pluginLogMessages: string[];
  serverRunning: boolean;
  containerStatus?: string;
}> {
  const diagnostics = {
    pluginInstalled: false,
    pluginFilename: null as string | null,
    portListening: false,
    portCheckError: undefined as string | undefined,
    pluginLogsFound: false,
    pluginLogMessages: [] as string[],
    serverRunning: false,
    containerStatus: undefined as string | undefined,
  };

  try {
    // Check if plugin is installed
    diagnostics.pluginInstalled = await isPluginInstalled();
    diagnostics.pluginFilename = await getPluginFilename();

    // Check if server/container is running
    try {
      const dockerService = await import('./docker.js');
      const status = await dockerService.getStatus();
      diagnostics.serverRunning = status.running;
      diagnostics.containerStatus = status.status;
    } catch (error) {
      console.error('[Plugin Diagnostics] Failed to check container status:', error);
    }

    // Check if port 18085 is listening (only if server is running)
    if (diagnostics.serverRunning) {
      try {
        const backendInDocker = fs.existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER;
        const isLocalDev = !backendInDocker;

        if (isLocalDev) {
          // Dev mode: Use Docker exec to check port
          const dockerService = await import('./docker.js');
          const portCheckResult = await dockerService.execInContainer(
            'netstat -tlnp 2>/dev/null | grep :18085 || ss -tlnp 2>/dev/null | grep :18085 || echo "PORT_NOT_FOUND"'
          );
          
          if (portCheckResult.success && portCheckResult.output) {
            const output = portCheckResult.output.trim();
            diagnostics.portListening = !output.includes('PORT_NOT_FOUND') && output.length > 0;
            if (!diagnostics.portListening) {
              diagnostics.portCheckError = 'Port 18085 is not listening';
            }
          } else {
            diagnostics.portCheckError = portCheckResult.error || 'Failed to check port';
          }
        } else {
          // Production: Try to connect directly
          try {
            const testResponse = await fetch(`http://localhost:${PLUGIN_PORT}/api/server/info`, {
              signal: AbortSignal.timeout(2000),
            });
            diagnostics.portListening = testResponse.ok;
          } catch {
            diagnostics.portListening = false;
            diagnostics.portCheckError = 'Connection refused';
          }
        }
      } catch (error) {
        diagnostics.portCheckError = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    // Check server logs for plugin messages
    try {
      const dockerService = await import('./docker.js');
      const logs = await dockerService.getLogs(500); // Get last 500 lines
      
      // Search for plugin-related log messages
      const pluginKeywords = [
        'KyuubiSoftAPI',
        'KyuubiSoft API',
        'WebServer bound',
        'API server started',
        'port 18085',
        'KyuubiSoftAPI',
      ];
      
      const logLines = logs.split('\n');
      const pluginLogLines = logLines.filter(line => {
        const lowerLine = line.toLowerCase();
        return pluginKeywords.some(keyword => lowerLine.includes(keyword.toLowerCase()));
      });

      diagnostics.pluginLogsFound = pluginLogLines.length > 0;
      diagnostics.pluginLogMessages = pluginLogLines.slice(-10); // Last 10 plugin log messages
    } catch (error) {
      console.error('[Plugin Diagnostics] Failed to check logs:', error);
    }

    return diagnostics;
  } catch (error) {
    console.error('[Plugin Diagnostics] Error:', error);
    return diagnostics;
  }
}

/**
 * Uninstall the KyuubiSoft API plugin
 * Uses Docker API in dev mode, direct filesystem access in production
 */
export async function uninstallPlugin(): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if we're in local development (backend not in Docker)
    const backendInDocker = fs.existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER;
    const isLocalDev = !backendInDocker;

    const modsPath = config.hytaleContainerModsPath;
    const files = await fileAccess.readServerDir(modsPath);

    let removed = false;
    for (const file of files) {
      const cleanedFile = cleanFilename(file);
      if (cleanedFile.toLowerCase().startsWith('kyuubisoftapi') && cleanedFile.endsWith('.jar')) {
        if (isLocalDev) {
          // Dev mode: Use Docker API to delete (use posix.join for container paths)
          const filePath = path.posix.join(modsPath, file);
          await dockerService.execCommand(`rm -f "${filePath}"`);
        } else {
          // Production: Use direct filesystem access (path.join is fine here as backend is in Docker)
          const filePath = path.join(modsPath, file);
          fs.unlinkSync(filePath);
        }
        removed = true;
      }
    }

    if (!removed) {
      return { success: false, error: 'Plugin not found' };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to uninstall plugin'
    };
  }
}
