import https from 'https';
import http from 'http';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { config } from '../config.js';

/**
 * Binary name for the current platform (manager runs the downloader on its own host).
 * Linux: hytale-downloader-linux-amd64, Windows: hytale-downloader-windows-amd64.exe
 */
function getDownloaderBinaryName(): string {
  const platform = os.platform();
  if (platform === 'win32') {
    return 'hytale-downloader-windows-amd64.exe';
  }
  return 'hytale-downloader-linux-amd64';
}

/**
 * Progress callback type for download operations
 */
export type ProgressCallback = (progress: {
  step: string;
  stepProgress: number;
  overallProgress: number;
  message: string;
}) => void;

/**
 * Download file from URL
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = (currentUrl: string) => {
      const proto = currentUrl.startsWith('https') ? https : http;

      proto.get(currentUrl, { headers: { 'User-Agent': 'KyuubiSoft-Panel/1.0' } }, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            request(redirectUrl);
            return;
          }
        }

        if (res.statusCode !== 200) {
          console.error(`[HytaleDownloader] Download failed: ${res.statusCode}`);
          resolve(false);
          return;
        }

        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            await writeFile(destPath, buffer);
            console.log(`[HytaleDownloader] Downloaded file to ${destPath}`);
            resolve(true);
          } catch (e) {
            console.error('[HytaleDownloader] Failed to write file:', e);
            resolve(false);
          }
        });
        res.on('error', (e) => {
          console.error('[HytaleDownloader] Download error:', e);
          resolve(false);
        });
      }).on('error', (e) => {
        console.error('[HytaleDownloader] Request error:', e);
        resolve(false);
      });
    };

    request(url);
  });
}

/**
 * Check if hytale-downloader is already installed on the manager.
 * Returns the host/manager path to the binary for spawning the process on the manager.
 */
export async function isDownloaderInstalled(): Promise<{ installed: boolean; binaryPath?: string; error?: string }> {
  try {
    // Prefer current platform binary, then fall back to Linux (e.g. manager container is often Linux)
    const binaryName = getDownloaderBinaryName();
    const hostBinaryPath = path.join(config.hostDownloaderPath, binaryName);
    if (existsSync(hostBinaryPath)) {
      return { installed: true, binaryPath: hostBinaryPath };
    }
    // Fallback: Linux binary (for manager running in Docker on Linux)
    const linuxPath = path.join(config.hostDownloaderPath, 'hytale-downloader-linux-amd64');
    if (existsSync(linuxPath)) {
      return { installed: true, binaryPath: linuxPath };
    }
    const windowsPath = path.join(config.hostDownloaderPath, 'hytale-downloader-windows-amd64.exe');
    if (existsSync(windowsPath)) {
      return { installed: true, binaryPath: windowsPath };
    }

    return { installed: false };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : 'Failed to check downloader installation',
    };
  }
}

/**
 * Download hytale-downloader.zip to host data folder
 * Only downloads if ZIP doesn't already exist
 */
export async function downloadDownloader(
  onProgress?: ProgressCallback
): Promise<{ success: boolean; zipPath?: string; error?: string }> {
  try {
    // Ensure host downloader directory exists
    await mkdir(config.hostDownloaderPath, { recursive: true });

    // Check if ZIP already exists
    const zipPath = path.join(config.hostDownloaderPath, 'hytale-downloader.zip');
    if (existsSync(zipPath)) {
      console.log(`[HytaleDownloader] ZIP already exists at ${zipPath}, skipping download`);
      onProgress?.({
        step: 'downloading-downloader',
        stepProgress: 100,
        overallProgress: 50,
        message: 'Downloader ZIP already exists',
      });
      return { success: true, zipPath };
    }

    onProgress?.({
      step: 'downloading-downloader',
      stepProgress: 0,
      overallProgress: 10,
      message: 'Downloading hytale-downloader.zip...',
    });

    // Download to host data folder
    console.log(`[HytaleDownloader] Downloading downloader from ${config.hytaleDownloaderUrl} to ${zipPath}`);
    const success = await downloadFile(config.hytaleDownloaderUrl, zipPath);

    if (!success) {
      return { success: false, error: 'Failed to download hytale-downloader.zip' };
    }

    onProgress?.({
      step: 'downloading-downloader',
      stepProgress: 100,
      overallProgress: 50,
      message: 'Downloaded hytale-downloader.zip',
    });

    return { success: true, zipPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download downloader',
    };
  }
}

/**
 * Extract downloader ZIP to host
 * The host path is mounted in the container, so no container interaction needed
 */
export async function extractDownloader(
  zipPath: string,
  onProgress?: ProgressCallback
): Promise<{ success: boolean; binaryPath?: string; error?: string }> {
  try {
    onProgress?.({
      step: 'extracting-downloader',
      stepProgress: 0,
      overallProgress: 50,
      message: 'Extracting hytale-downloader.zip...',
    });

    // Extract ZIP on host
    const extractDir = config.hostDownloaderPath;
    console.log(`[HytaleDownloader] Extracting ${zipPath} to ${extractDir}`);
    
    // Use unzip command (should be available on most systems)
    try {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
    } catch (error) {
      return { success: false, error: `Failed to extract downloader: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }

    // Verify at least one binary exists after extraction (zip may contain both Linux and Windows)
    const linuxPath = path.join(extractDir, 'hytale-downloader-linux-amd64');
    const windowsPath = path.join(extractDir, 'hytale-downloader-windows-amd64.exe');
    const hostBinaryPath = existsSync(linuxPath)
      ? linuxPath
      : existsSync(windowsPath)
        ? windowsPath
        : null;
    if (!hostBinaryPath) {
      return { success: false, error: 'Binary not found after extraction (expected hytale-downloader-linux-amd64 or hytale-downloader-windows-amd64.exe)' };
    }

    // Make binary executable on host (Linux/macOS only; no-op on Windows)
    if (os.platform() !== 'win32') {
      onProgress?.({
        step: 'extracting-downloader',
        stepProgress: 80,
        overallProgress: 90,
        message: 'Making binary executable...',
      });
      try {
        execSync(`chmod +x "${hostBinaryPath}"`, { stdio: 'pipe' });
      } catch (error) {
        console.warn('[HytaleDownloader] Failed to make binary executable on host, continuing anyway');
      }
    }

    onProgress?.({
      step: 'extracting-downloader',
      stepProgress: 100,
      overallProgress: 100,
      message: 'Extracted downloader and made binary executable',
    });

    return { success: true, binaryPath: hostBinaryPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to extract downloader',
    };
  }
}

/**
 * Install hytale-downloader (download and extract)
 * This is the main function that orchestrates the installation
 */
export async function installDownloader(
  onProgress?: ProgressCallback
): Promise<{ success: boolean; binaryPath?: string; error?: string }> {
  try {
    console.log('[HytaleDownloader] Starting downloader installation...');

    // Ensure manager downloader directory exists
    await mkdir(config.hostDownloaderPath, { recursive: true });

    // Check if already installed
    const installed = await isDownloaderInstalled();
    if (installed.installed && installed.binaryPath) {
      console.log('[HytaleDownloader] Downloader already installed');
      onProgress?.({
        step: 'complete',
        stepProgress: 100,
        overallProgress: 100,
        message: 'Downloader already installed',
      });
      return { success: true, binaryPath: installed.binaryPath };
    }

    // Step 1: Download
    const downloadResult = await downloadDownloader(onProgress);
    if (!downloadResult.success || !downloadResult.zipPath) {
      return { success: false, error: downloadResult.error };
    }

    // Step 2: Extract
    const extractResult = await extractDownloader(downloadResult.zipPath, onProgress);
    if (!extractResult.success) {
      return { success: false, error: extractResult.error };
    }

    console.log('[HytaleDownloader] Downloader installation completed successfully');
    return { success: true, binaryPath: extractResult.binaryPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install downloader',
    };
  }
}
