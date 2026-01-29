import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import unzipper from 'unzipper';
import { config } from '../config.js';
import { readPanelConfig } from '../routes/server/utils.js';
import * as fileAccess from '../utils/fileAccess.js';
import { isDownloaderInstalled } from './hytaleDownloader.js';

/** Docker cp helper: source path (manager files), container name, container path (game server dir) */
export type DockerCpCommand = { sourcePath: string; containerName: string; containerPath: string };

/**
 * Build the docker cp helper command. Use the directory that contains HytaleServer.jar and Assets.zip.
 * When HOST_PATH_FOR_DOCKER_CP is set (e.g. manager in Docker), use it as source so user sees host path.
 */
export function getDockerCpCommand(serverFilesDir: string): DockerCpCommand {
  const sourcePath = config.hostPathForDockerCp
    ? path.join(config.hostPathForDockerCp, path.relative(config.hostDownloaderPath, serverFilesDir))
    : serverFilesDir;
  return {
    sourcePath: sourcePath.replace(/\\/g, '/'),
    containerName: config.gameContainerName,
    containerPath: config.hytaleContainerServerPath.replace(/\\/g, '/'),
  };
}

/**
 * Return the docker cp command if server files are already extracted on the manager (ready for manual copy).
 * Returns null if HytaleServer.jar and Assets.zip are not in the extract dir.
 */
export function getDockerCpCommandIfReady(): DockerCpCommand | null {
  const jarPath = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'HytaleServer.jar');
  const assetsPath = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'Assets.zip');
  if (!jarPath || !assetsPath) return null;
  return getDockerCpCommand(path.dirname(jarPath));
}

/**
 * Progress callback type for download operations.
 * stdoutLine: stream a single line to the frontend (auth links, messages).
 * authUrl: when a line contains an OAuth/device-login URL, it is extracted and sent so the frontend can show it prominently.
 * downloadPercent/Mb/TotalGb: parsed from downloader progress line for progress bar.
 */
export type ProgressCallback = (progress: {
  step: string;
  stepProgress: number;
  overallProgress: number;
  message: string;
  stdoutLine?: string;
  /** OAuth/device-login URL extracted from downloader stdout/stderr for user to click and authenticate */
  authUrl?: string;
  downloadPercent?: number;
  downloadMb?: number;
  downloadTotalGb?: number;
}) => void;

/** Match downloader progress line e.g. "10.0% (142.6 MB / 1.4 GB)" or "[=====] 11.0% (156.9 MB / 1.4 GB)" */
const DOWNLOAD_PROGRESS_REGEX = /(\d+(?:\.\d+)?)\s*%\s*\(([\d.]+)\s*MB\s*\/\s*([\d.]+)\s*GB\)/;

/** Match OAuth/device-login URL in downloader output (e.g. https://login.live.com/..., https://microsoft.com/devicelogin, etc.) */
const AUTH_URL_REGEX = /(https:\/\/[^\s)\]}>'"]+)/;

/** Manager-side path for game.zip (downloader writes here) */
const MANAGER_GAME_ZIP_PATH = path.join(config.hostDownloaderPath, 'game.zip');
/** Manager-side temp dir for extracting game.zip */
const MANAGER_GAME_EXTRACT_DIR = path.join(config.hostDownloaderPath, 'game-extract');

/**
 * Recursively find a file by name under dir (case-insensitive).
 * Returns the full path or null if not found.
 */
function findFileInDir(dir: string, fileName: string): string | null {
  const lower = fileName.toLowerCase();
  function search(d: string): string | null {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return null;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        const found = search(full);
        if (found) return found;
      } else if (e.name.toLowerCase() === lower) return full;
    }
    return null;
  }
  return search(dir);
}

/**
 * Download server files using the hytale-downloader on the manager.
 * Writes game.zip to the manager filesystem (hostDownloaderPath).
 */
export async function downloadServerFiles(
  patchline?: 'release' | 'pre-release',
  onProgress?: ProgressCallback
): Promise<{ success: boolean; error?: string }> {
  try {
    onProgress?.({
      step: 'downloading-server',
      stepProgress: 0,
      overallProgress: 10,
      message: 'Starting server file download...',
    });

    const downloaderCheck = await isDownloaderInstalled();
    if (!downloaderCheck.installed || !downloaderCheck.binaryPath) {
      return {
        success: false,
        error: 'Hytale downloader is not installed. Please install it first.',
      };
    }

    let targetPatchline = patchline;
    if (!targetPatchline) {
      const panelConfig = await readPanelConfig();
      targetPatchline = (panelConfig.patchline || 'release') as 'release' | 'pre-release';
    }

    await fs.promises.mkdir(config.hostDownloaderPath, { recursive: true });

    const downloaderPath = downloaderCheck.binaryPath;
    const downloadPathArg = `-download-path ${MANAGER_GAME_ZIP_PATH}`;
    const patchlineArg = `-patchline ${targetPatchline}`;
    const skipUpdate = '-skip-update-check';

    const fullCommand = `"${downloaderPath}" ${patchlineArg} ${downloadPathArg} ${skipUpdate}`;
    console.log(`[ServerFileDownloader] Running downloader on manager with patchline: ${targetPatchline}`);
    console.log(`[ServerFileDownloader] cwd: ${config.hostDownloaderPath}`);
    console.log(`[ServerFileDownloader] command: ${fullCommand}`);
    onProgress?.({
      step: 'downloading-server',
      stepProgress: 30,
      overallProgress: 30,
      message: `Downloading server files (${targetPatchline})...`,
    });

    const { stdoutChunks, stderrChunks, exitCode, signal } = await new Promise<{
      stdoutChunks: string[];
      stderrChunks: string[];
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const args: string[] = ['-patchline', targetPatchline ?? 'release', '-download-path', MANAGER_GAME_ZIP_PATH, '-skip-update-check'];
      console.log(`[ServerFileDownloader] Spawning process...`);
      console.log(`[ServerFileDownloader] args: ${JSON.stringify(args)}`);
      const child = spawn(downloaderPath, args, {
        cwd: config.hostDownloaderPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as import('child_process').ChildProcess & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdoutChunks.push(chunk);
        const lines = chunk.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          console.log(`[ServerFileDownloader] stdout: ${line}`);
          const progressPayload: Parameters<ProgressCallback>[0] = {
            step: 'downloading-server',
            stepProgress: 30,
            overallProgress: 30,
            message: `Downloading server files (${targetPatchline ?? 'release'})...`,
            stdoutLine: line,
          };
          const progressMatch = line.match(DOWNLOAD_PROGRESS_REGEX);
          if (progressMatch) {
            progressPayload.downloadPercent = parseFloat(progressMatch[1]);
            progressPayload.downloadMb = parseFloat(progressMatch[2]);
            progressPayload.downloadTotalGb = parseFloat(progressMatch[3]);
          }
          const authUrlMatch = line.match(AUTH_URL_REGEX);
          if (authUrlMatch) {
            progressPayload.authUrl = authUrlMatch[1];
          }
          onProgress?.(progressPayload);
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderrChunks.push(chunk);
        const lines = chunk.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          console.log(`[ServerFileDownloader] stderr: ${line}`);
          const progressPayload: Parameters<ProgressCallback>[0] = {
            step: 'downloading-server',
            stepProgress: 30,
            overallProgress: 30,
            message: `Downloading server files (${targetPatchline ?? 'release'})...`,
            stdoutLine: line,
          };
          const authUrlMatch = line.match(AUTH_URL_REGEX);
          if (authUrlMatch) {
            progressPayload.authUrl = authUrlMatch[1];
          }
          onProgress?.(progressPayload);
        }
      });

      child.on('error', (err: Error) => {
        console.log(`[ServerFileDownloader] Process error: ${err.message}`);
        reject(err);
      });

      child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
        console.log(`[ServerFileDownloader] Process closed with code=${code} signal=${sig ?? 'none'}`);
        resolve({ stdoutChunks, stderrChunks, exitCode: code, signal: sig });
      });
    });

    const stderrOutput = stderrChunks.join('');
    const stdoutOutput = stdoutChunks.join('');

    if (exitCode !== 0) {
      const output = stderrOutput || stdoutOutput || `Process exited with code ${exitCode}`;
      console.log(`[ServerFileDownloader] Download failed. exitCode=${exitCode} output=${output.slice(0, 500)}`);
      if (output.includes('authentication') || output.includes('unauthorized') || output.includes('token') || output.includes('device code')) {
        return {
          success: false,
          error: 'Downloader authentication required. Please authenticate the downloader first (run it once interactively or check credentials).',
        };
      }
      return {
        success: false,
        error: `Failed to download server files: ${output || (signal ? `killed by signal ${signal}` : `exit code ${exitCode}`)}`,
      };
    }

    console.log(`[ServerFileDownloader] Downloader process finished successfully`);

    if (!fs.existsSync(MANAGER_GAME_ZIP_PATH)) {
      return { success: false, error: 'game.zip was not created by the downloader' };
    }

    onProgress?.({
      step: 'downloading-server',
      stepProgress: 100,
      overallProgress: 70,
      message: 'Downloaded server files',
      downloadPercent: 100,
      downloadMb: undefined,
      downloadTotalGb: undefined,
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download server files',
    };
  }
}

/** Result of extractServerFiles when user must manually copy files to the game container */
export type ExtractResult = {
  success: boolean;
  error?: string;
  manualCopyRequired?: boolean;
  dockerCp?: DockerCpCommand;
};

/**
 * Extract game.zip on the manager. Does NOT copy to the game container.
 * Returns manualCopyRequired and dockerCp so the frontend can show the user the docker cp command.
 * If HytaleServer.jar and Assets.zip are already in the extract dir, skips extraction and returns dockerCp.
 */
export async function extractServerFiles(
  onProgress?: ProgressCallback
): Promise<ExtractResult> {
  try {
    const logPrefix = '[ServerFileDownloader]';
    onProgress?.({
      step: 'extracting-server',
      stepProgress: 0,
      overallProgress: 70,
      message: 'Extracting server files...',
    });

    await fs.promises.mkdir(MANAGER_GAME_EXTRACT_DIR, { recursive: true });

    // If already extracted, skip extraction and return docker cp command
    const existingJar = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'HytaleServer.jar');
    const existingAssets = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'Assets.zip');
    if (existingJar && existingAssets) {
      console.log(`${logPrefix} HytaleServer.jar and Assets.zip already present in extract dir; manual copy required`);
      const serverFilesDir = path.dirname(existingJar);
      onProgress?.({
        step: 'complete',
        stepProgress: 100,
        overallProgress: 100,
        message: 'Server files ready. Copy to game container using the command below.',
      });
      return { success: true, manualCopyRequired: true, dockerCp: getDockerCpCommand(serverFilesDir) };
    }

    if (!fs.existsSync(MANAGER_GAME_ZIP_PATH)) {
      return { success: false, error: 'game.zip not found on manager. Run download first.' };
    }

    onProgress?.({
      step: 'extracting-server',
      stepProgress: 20,
      overallProgress: 75,
      message: 'Extracting game.zip on manager...',
    });

    try {
      const directory = await unzipper.Open.file(MANAGER_GAME_ZIP_PATH);
      const files = directory.files;
      const total = files.length;
      const progressStart = 75;
      const progressEnd = 85;

      for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        const destPath = path.join(MANAGER_GAME_EXTRACT_DIR, entry.path);
        const resolved = path.resolve(destPath);
        if (!resolved.startsWith(path.resolve(MANAGER_GAME_EXTRACT_DIR))) {
          continue; // skip path traversal
        }

        if (entry.type === 'Directory') {
          await fs.promises.mkdir(resolved, { recursive: true });
        } else {
          await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
          try {
            const readStream = entry.stream();
            const writeStream = fs.createWriteStream(resolved, { flags: 'w' });
            await pipeline(readStream, writeStream);
          } catch (fileErr) {
            console.warn(`[ServerFileDownloader] Failed to extract ${entry.path}:`, fileErr);
            // Continue with next file instead of failing the whole extraction
          }
        }

        const pct = progressStart + (progressEnd - progressStart) * ((i + 1) / total);
        onProgress?.({
          step: 'extracting-server',
          stepProgress: 20 + Math.round(30 * (i + 1) / total),
          overallProgress: Math.round(pct),
          message: `Extracting game.zip... (${i + 1}/${total} files)`,
        });
        // Yield to event loop so SSE progress is pushed to the frontend before next file
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (err) {
      return {
        success: false,
        error: `Failed to extract game.zip: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }

    onProgress?.({
      step: 'extracting-server',
      stepProgress: 50,
      overallProgress: 85,
      message: 'Locating HytaleServer.jar and Assets.zip...',
    });

    // Find JAR and Assets.zip anywhere under extract dir (zip layout can vary: root, Server/, etc.)
    const jarPath = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'HytaleServer.jar');
    const assetsPath = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'Assets.zip');
    if (!jarPath) {
      return { success: false, error: 'HytaleServer.jar not found after extraction' };
    }
    if (!assetsPath) {
      return { success: false, error: 'Assets.zip not found after extraction' };
    }

    const serverFilesDir = path.dirname(jarPath);
    console.log(`${logPrefix} Server files extracted to: ${serverFilesDir}`);
    try {
      await fs.promises.unlink(MANAGER_GAME_ZIP_PATH);
    } catch {
      // ignore cleanup failure
    }

    onProgress?.({
      step: 'complete',
      stepProgress: 100,
      overallProgress: 100,
      message: 'Server files ready. Copy to game container using the command below.',
    });

    return { success: true, manualCopyRequired: true, dockerCp: getDockerCpCommand(serverFilesDir) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to extract server files',
    };
  }
}

/**
 * Download and extract server files (complete process).
 * Files are extracted on the manager; user must copy them to the game container using the returned docker cp command.
 */
export async function downloadAndExtractServerFiles(
  patchline?: 'release' | 'pre-release',
  onProgress?: ProgressCallback
): Promise<{ success: boolean; error?: string; manualCopyRequired?: boolean; dockerCp?: DockerCpCommand }> {
  try {
    console.log('[ServerFileDownloader] Starting server file download and extraction (manager-side)...');

    const alreadyExtractedJar = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'HytaleServer.jar');
    const alreadyExtractedAssets = findFileInDir(MANAGER_GAME_EXTRACT_DIR, 'Assets.zip');
    if (alreadyExtractedJar && alreadyExtractedAssets) {
      console.log('[ServerFileDownloader] HytaleServer.jar and Assets.zip already in extract dir; skipping download and extraction');
      const extractResult = await extractServerFiles(onProgress);
      if (!extractResult.success) return extractResult;
      return { success: true, manualCopyRequired: true, dockerCp: extractResult.dockerCp };
    }

    const downloadResult = await downloadServerFiles(patchline, onProgress);
    if (!downloadResult.success) return downloadResult;

    const extractResult = await extractServerFiles(onProgress);
    if (!extractResult.success) return extractResult;

    console.log('[ServerFileDownloader] Server file download and extraction completed; manual copy required');
    return { success: true, manualCopyRequired: true, dockerCp: extractResult.dockerCp };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download and extract server files',
    };
  }
}

/**
 * Check if server files are already downloaded in the game container
 */
export async function checkServerFilesInstalled(): Promise<{
  installed: boolean;
  hasJar: boolean;
  hasAssets: boolean;
}> {
  try {
    let hasJar = false;
    let hasAssets = false;

    try {
      await fileAccess.readServerFile(path.join(config.hytaleContainerServerPath, 'HytaleServer.jar'));
      hasJar = true;
    } catch {
      // File doesn't exist
    }

    try {
      await fileAccess.readServerFile(path.join(config.hytaleContainerServerPath, 'Assets.zip'));
      hasAssets = true;
    } catch {
      // File doesn't exist
    }

    return {
      installed: hasJar && hasAssets,
      hasJar,
      hasAssets,
    };
  } catch (error) {
    console.error('[ServerFileDownloader] Failed to check server files:', error);
    return {
      installed: false,
      hasJar: false,
      hasAssets: false,
    };
  }
}
