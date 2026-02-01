import * as fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import os from 'os';
import { access, constants } from 'fs/promises';
import * as dockerService from '../../services/docker.js';
import { config } from '../../config.js';
import * as fileAccess from '../../utils/fileAccess.js';

// Allowed config file extensions
export const CONFIG_EXTENSIONS = ['.json', '.properties', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini'];

// SECURITY: Magic bytes for JAR file verification
export const JAR_SIGNATURES = [
  [0x50, 0x4B, 0x03, 0x04], // ZIP/JAR files (PK\x03\x04)
  [0x50, 0x4B, 0x05, 0x06], // Empty ZIP
  [0x50, 0x4B, 0x07, 0x08], // Spanned ZIP
];

// SECURITY: Verify file magic bytes match JAR format
export function verifyJarFile(filePath: string): boolean {
  try {
    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);

    return JAR_SIGNATURES.some(sig =>
      sig.every((byte, i) => buffer[i] === byte)
    );
  } catch {
    return false;
  }
}

// SECURITY: Generate safe filename for plugin upload
export function generateSafePluginFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  // Sanitize the base name
  const safeName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .substring(0, 100);
  // For API plugin, preserve the original name format if it matches KyuubiSoftAPI pattern
  if (safeName.toLowerCase().startsWith('kyuubisoftapi')) {
    return `${safeName}${ext}`;
  }
  // Otherwise add unique prefix to prevent overwrites
  const uniqueId = crypto.randomBytes(4).toString('hex');
  return `${safeName}_${uniqueId}${ext}`;
}

// Configure multer for API plugin uploads
// Use temp directory - we'll copy to container in dev mode or move to modsPath in production
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit
const tempDir = os.tmpdir();
const apiPluginStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // Always use temp directory first
    cb(null, tempDir);
  },
  filename: (_req, file, cb) => {
    // SECURITY: Generate safe filename
    cb(null, generateSafePluginFilename(file.originalname));
  },
});

export const uploadApiPlugin = multer({
  storage: apiPluginStorage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // SECURITY: Only allow JAR files
    if (ext === '.jar') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only .jar files are allowed.'));
    }
  },
});

// Quick settings interface
export interface QuickSettings {
  serverName: string;
  motd: string;
  password: string;
  maxPlayers: number;
  maxViewRadius: number;
  defaultGameMode: string;
}

// Panel config file path (for patchline setting)
export const PANEL_CONFIG_PATH = '/opt/hytale/data/panel-config.json';

// Panel config interface
export interface PanelConfig {
  patchline: string;
  acceptEarlyPlugins: boolean;
  disableSentry: boolean;
  allowOp: boolean;
}

// Helper to read panel config
export async function readPanelConfig(): Promise<PanelConfig> {
  try {
    const content = await fileAccess.readServerFile(PANEL_CONFIG_PATH);
    const configData = JSON.parse(content);
    // Ensure all fields have defaults
    return {
      patchline: configData.patchline || process.env.HYTALE_PATCHLINE || 'release',
      acceptEarlyPlugins: configData.acceptEarlyPlugins ?? false,
      disableSentry: configData.disableSentry ?? false,
      allowOp: configData.allowOp ?? false,
    };
  } catch {
    // Return defaults if file doesn't exist
    return {
      patchline: process.env.HYTALE_PATCHLINE || 'release',
      acceptEarlyPlugins: false,
      disableSentry: false,
      allowOp: false,
    };
  }
}

// Helper to write panel config
export async function writePanelConfig(configData: PanelConfig): Promise<void> {
  await fileAccess.writeServerFile(PANEL_CONFIG_PATH, JSON.stringify(configData, null, 2));
}

// Helper to check if downloader credentials exist
export async function checkDownloaderCredentials(): Promise<{ exists: boolean; error?: string }> {
  // Check multiple possible locations for downloader credentials
  const credentialPaths = [
    '/opt/hytale/downloader/.hytale-downloader-credentials.json',
    '/opt/hytale/auth/credentials.json',
    '/opt/hytale/auth/oauth_credentials.json',
  ];

  for (const credPath of credentialPaths) {
    try {
      await access(credPath, constants.R_OK);
      console.log(`[Server] Found downloader credentials at: ${credPath}`);
      return { exists: true };
    } catch {
      // Continue checking
    }
  }

  console.log('[Server] No downloader credentials found');
  return { exists: false, error: 'Downloader credentials not found. Re-authentication required.' };
}

// Helper to get latest version for a patchline
// SECURITY: Defense-in-depth validation - even though callers use hardcoded values
const VALID_PATCHLINES = ['release', 'pre-release'] as const;

export interface VersionCheckResult {
  version: string;
  authRequired?: boolean;
  error?: string;
}

export async function getLatestVersion(patchline: string): Promise<VersionCheckResult> {
  // SECURITY: Validate patchline to prevent command injection
  if (!VALID_PATCHLINES.includes(patchline as typeof VALID_PATCHLINES[number])) {
    console.error(`Invalid patchline attempted: ${patchline}`);
    return { version: 'unknown', error: 'Invalid patchline' };
  }

  // Run downloader and capture both stdout and stderr to detect auth issues
  const checkResult = await dockerService.execInGameServerContainer(
    `cd /opt/hytale/downloader && ./hytale-downloader-linux-amd64 -patchline ${patchline} -print-version 2>&1`
  );

  if (!checkResult.success) {
    console.error('[Server] Downloader exec failed:', checkResult.error);
    return { version: 'unknown', error: checkResult.error };
  }

  const output = checkResult.output || '';

  // Check for authentication errors in output
  const authErrorPatterns = [
    /unauthorized/i,
    /authentication.*required/i,
    /invalid.*token/i,
    /token.*expired/i,
    /login.*required/i,
    /401/,
    /403/,
    /no.*credentials/i,
    /credentials.*not.*found/i,
    /please.*authenticate/i,
  ];

  for (const pattern of authErrorPatterns) {
    if (pattern.test(output)) {
      console.log('[Server] Downloader auth error detected:', output.substring(0, 200));
      return { version: 'unknown', authRequired: true, error: 'Authentication required' };
    }
  }

  // Extract version number from output
  const versionMatch = output.match(/[0-9]+\.[0-9]+\.[0-9]+/);
  if (versionMatch) {
    return { version: versionMatch[0] };
  }

  // If no version found but also no auth error, credentials might be missing
  // Check if credentials exist
  const credCheck = await checkDownloaderCredentials();
  if (!credCheck.exists) {
    return { version: 'unknown', authRequired: true, error: credCheck.error };
  }

  // No version found, but credentials exist - might be a network issue
  console.log('[Server] No version found in output:', output.substring(0, 200));
  return { version: 'unknown', error: 'Could not fetch version. Check network connection.' };
}

// Helper function to parse Prometheus text format
export function parsePrometheusMetrics(raw: string): Record<string, unknown> {
  const lines = raw.split('\n').filter(line => line && !line.startsWith('#'));
  const metrics: Record<string, number> = {};
  const labeledMetrics: Record<string, Record<string, number>> = {};

  for (const line of lines) {
    // Match metrics with labels: metric_name{label="value"} 123.45
    const labelMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\{([^}]+)\}\s+([\d.eE+-]+)/);
    if (labelMatch) {
      const metricName = labelMatch[1];
      const labelStr = labelMatch[2];
      const value = parseFloat(labelMatch[3]);

      // Parse label (e.g., pool="G1 Eden Space" or gc="G1 Young Generation")
      const labelValueMatch = labelStr.match(/(?:pool|gc|world)="([^"]+)"/);
      if (labelValueMatch) {
        if (!labeledMetrics[metricName]) {
          labeledMetrics[metricName] = {};
        }
        labeledMetrics[metricName][labelValueMatch[1]] = value;
      }
      continue;
    }

    // Match simple metrics: metric_name 123.45
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+([\d.eE+-]+)/);
    if (match) {
      metrics[match[1]] = parseFloat(match[2]);
    }
  }

  // Parse memory pools
  const memoryPools: Array<{ name: string; used: number; max: number; percent: number }> = [];
  const poolUsed = labeledMetrics['jvm_memory_pool_used_bytes'] || {};
  const poolMax = labeledMetrics['jvm_memory_pool_max_bytes'] || {};
  for (const poolName of Object.keys(poolUsed)) {
    const used = poolUsed[poolName] || 0;
    const max = poolMax[poolName] || 0;
    memoryPools.push({
      name: poolName,
      used,
      max,
      percent: max > 0 ? (used / max) * 100 : 0,
    });
  }

  // Parse GC stats
  const gcStats: Array<{ name: string; count: number; timeSeconds: number }> = [];
  const gcCount = labeledMetrics['jvm_gc_collection_count_total'] || {};
  const gcTime = labeledMetrics['jvm_gc_collection_time_seconds_total'] || {};
  for (const gcName of Object.keys(gcCount)) {
    gcStats.push({
      name: gcName,
      count: gcCount[gcName] || 0,
      timeSeconds: gcTime[gcName] || 0,
    });
  }

  // Parse players per world
  const playersPerWorld: Record<string, number> = labeledMetrics['hytale_players_world'] || {};

  return {
    tps: {
      current: metrics['hytale_tps_current'] ?? 20,
      average: metrics['hytale_tps_average'] ?? 20,
      min: metrics['hytale_tps_min'] ?? 20,
      max: metrics['hytale_tps_max'] ?? 20,
      target: metrics['hytale_tps_target'] ?? 20,
      msptCurrent: metrics['hytale_mspt_current'] ?? 50,
      msptAverage: metrics['hytale_mspt_average'] ?? 50,
    },
    players: {
      online: metrics['hytale_players_online'] ?? 0,
      max: metrics['hytale_players_max'] ?? 100,
      joins: metrics['hytale_player_joins_total'] ?? 0,
      leaves: metrics['hytale_player_leaves_total'] ?? 0,
      perWorld: playersPerWorld,
    },
    memory: {
      heapUsed: metrics['jvm_memory_heap_used_bytes'] ?? 0,
      heapMax: metrics['jvm_memory_heap_max_bytes'] ?? 0,
      heapCommitted: metrics['jvm_memory_heap_committed_bytes'] ?? 0,
      heapPercent: metrics['jvm_memory_heap_max_bytes']
        ? (metrics['jvm_memory_heap_used_bytes'] / metrics['jvm_memory_heap_max_bytes']) * 100
        : 0,
      nonHeapUsed: metrics['jvm_memory_nonheap_used_bytes'] ?? 0,
      nonHeapCommitted: metrics['jvm_memory_nonheap_committed_bytes'] ?? 0,
      pools: memoryPools,
    },
    threads: {
      current: metrics['jvm_threads_current'] ?? 0,
      daemon: metrics['jvm_threads_daemon'] ?? 0,
      peak: metrics['jvm_threads_peak'] ?? 0,
    },
    gc: gcStats,
    cpu: {
      process: (metrics['process_cpu_usage'] ?? 0) * 100,
      system: (metrics['system_cpu_usage'] ?? 0) * 100,
    },
    uptime: metrics['hytale_uptime_seconds'] ?? 0,
    worlds: metrics['hytale_worlds_loaded'] ?? 0,
  };
}

// Helper function to parse TPS metrics
export function parseTpsMetrics(raw: string): Record<string, number> {
  const lines = raw.split('\n').filter(line => line && !line.startsWith('#'));
  const metrics: Record<string, number> = {};

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{[^}]*\})?\s+([\d.eE+-]+)/);
    if (match) {
      metrics[match[1]] = parseFloat(match[2]);
    }
  }

  return {
    current: metrics['hytale_tps_current'] ?? 20,
    average: metrics['hytale_tps_average'] ?? 20,
    min: metrics['hytale_tps_min'] ?? 20,
    max: metrics['hytale_tps_max'] ?? 20,
    target: metrics['hytale_tps_target'] ?? 20,
    msptCurrent: metrics['hytale_mspt_current'] ?? 50,
    msptAverage: metrics['hytale_mspt_average'] ?? 50,
  };
}

// UpdateConfig interface
export interface UpdateConfig {
  enabled: boolean;
  checkIntervalSeconds: number;
  notifyPlayersOnAvailable: boolean;
  patchline: 'release' | 'pre-release';
  runBackupBeforeUpdate: boolean;
  backupConfigBeforeUpdate: boolean;
  autoApplyMode: 'DISABLED' | 'WHEN_EMPTY' | 'SCHEDULED';
  autoApplyDelayMinutes: number;
}

// Default UpdateConfig values
export function getDefaultUpdateConfig(): UpdateConfig {
  return {
    enabled: true,
    checkIntervalSeconds: 3600,
    notifyPlayersOnAvailable: true,
    patchline: 'release',
    runBackupBeforeUpdate: true,
    backupConfigBeforeUpdate: true,
    autoApplyMode: 'DISABLED',
    autoApplyDelayMinutes: 5,
  };
}

// Native update status interface
export interface NativeUpdateStatus {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  state: 'IDLE' | 'CHECKING' | 'DOWNLOADING' | 'READY' | 'APPLYING' | 'ERROR';
  progress?: number;
  message?: string;
  error?: string;
}

// Helper to parse /update status output
export function parseUpdateStatusOutput(output: string): NativeUpdateStatus {
  if (!output || typeof output !== 'string') {
    return {
      available: false,
      currentVersion: 'unknown',
      latestVersion: 'unknown',
      state: 'IDLE',
      error: 'No output from server'
    };
  }

  const lower = output.toLowerCase();

  // Detect state
  let state: NativeUpdateStatus['state'] = 'IDLE';
  if (lower.includes('error') || lower.includes('failed')) state = 'ERROR';
  else if (lower.includes('applying') || lower.includes('installing')) state = 'APPLYING';
  else if (lower.includes('ready') || lower.includes('staged') || lower.includes('downloaded')) state = 'READY';
  else if (lower.includes('downloading') || lower.includes('download')) state = 'DOWNLOADING';
  else if (lower.includes('checking')) state = 'CHECKING';

  // Extract versions using multiple patterns
  const versionPatterns = [
    /(?:current|installed).*?([0-9]+\.[0-9]+\.[0-9]+)/i,
    /version[:\s]+([0-9]+\.[0-9]+\.[0-9]+)/i,
  ];

  let currentVersion = 'unknown';
  for (const pattern of versionPatterns) {
    const match = output.match(pattern);
    if (match) {
      currentVersion = match[1];
      break;
    }
  }

  // Extract latest version
  const latestPatterns = [
    /(?:latest|available|new).*?([0-9]+\.[0-9]+\.[0-9]+)/i,
  ];

  let latestVersion = 'unknown';
  for (const pattern of latestPatterns) {
    const match = output.match(pattern);
    if (match) {
      latestVersion = match[1];
      break;
    }
  }

  // Extract progress
  const progressMatch = output.match(/(\d+)\s*%/);
  const progress = progressMatch ? parseInt(progressMatch[1]) : undefined;

  return {
    available: state === 'READY' || (latestVersion !== 'unknown' && currentVersion !== latestVersion),
    currentVersion,
    latestVersion,
    state,
    progress,
    message: output.substring(0, 200)
  };
}
