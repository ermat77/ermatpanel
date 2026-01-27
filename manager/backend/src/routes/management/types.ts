// ============== SHARED TYPES ==============

// Whitelist
export interface WhitelistData {
  enabled: boolean;
  list: string[];
}

// Bans
export interface HytaleBanEntry {
  type: 'infinite' | 'temporary';
  target: string; // UUID
  by: string; // UUID of admin (00000000-0000-0000-0000-000000000000 for console)
  timestamp: number; // Unix timestamp in ms
  reason: string;
}

export interface BanEntry {
  player: string; // Player name for display
  target?: string; // UUID from Hytale
  reason?: string;
  bannedAt: string;
  bannedBy?: string;
}

export interface BanNameMapping {
  [uuid: string]: string; // UUID -> player name
}

// Permissions
export interface HytalePermissionsData {
  users: { [uuid: string]: { groups: string[] } };
  groups: { [name: string]: string[] };
}

export interface PermissionUser {
  uuid: string;
  name: string; // Display name
  groups: string[];
}

export interface PermissionGroup {
  name: string;
  permissions: string[];
}

export interface PermissionsDisplayData {
  users: PermissionUser[];
  groups: PermissionGroup[];
}

export interface PermissionsNameMapping {
  [uuid: string]: string;
}

// Worlds
export interface WorldFileInfo {
  name: string;
  path: string;  // relative path within world (e.g., "config.json" or "resources/Time.json")
  size: number;
  lastModified: string;
}

export interface WorldInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  hasConfig: boolean;
  files: WorldFileInfo[];  // All editable JSON files in this world
}

export interface WorldConfig {
  name: string;
  displayName?: string;
  seed?: number;
  isTicking?: boolean;
  isBlockTicking?: boolean;
  isPvpEnabled?: boolean;
  isFallDamageEnabled?: boolean;
  isGameTimePaused?: boolean;
  gameTime?: string;
  isSpawningNPC?: boolean;
  isAllNPCFrozen?: boolean;
  isSpawnMarkersEnabled?: boolean;
  isObjectiveMarkersEnabled?: boolean;
  isSavingPlayers?: boolean;
  isSavingChunks?: boolean;
  saveNewChunks?: boolean;
  isUnloadingChunks?: boolean;
  isCompassUpdating?: boolean;
  gameplayConfig?: string;
  deleteOnUniverseStart?: boolean;
  deleteOnRemove?: boolean;
  daytimeDurationSecondsOverride?: number;
  nighttimeDurationSecondsOverride?: number;
  clientEffects?: {
    sunHeightPercent?: number;
    sunAngleDegrees?: number;
    bloomIntensity?: number;
    bloomPower?: number;
    sunIntensity?: number;
    sunshaftIntensity?: number;
    sunshaftScaleFactor?: number;
  };
}

// Mods
export interface ModInfo {
  name: string;
  filename: string;
  size: number;
  lastModified: string;
  enabled: boolean;
  // Update info (optional - only for mods in registry)
  storeId?: string;
  installedVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
}

// Stats
export interface StatsEntry {
  timestamp: string;
  cpu: number;
  memory: number;
  players: number;
}
