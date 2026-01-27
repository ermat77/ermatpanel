import https from 'https';
import http from 'http';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { config } from '../config.js';

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
 * Get container path for downloader binary
 * Based on HOST_DATA_PATH, the downloader is mounted at the same relative path in container
 */
function getHytaleDownloaderPath(): string {
  // Get HOST_DATA_PATH from config
  const hostDataPath = config.hostDataPath;
  // Container path mirrors host path structure
  // If HOST_DATA_PATH is /opt/hytale, container path is /opt/hytale/downloader
  return path.join(hostDataPath, 'downloader');
}

/**
 * Check if hytale-downloader is already installed
 * Checks host path (where downloader is stored)
 * The host path is mounted in the container at the same path
 */
export async function isDownloaderInstalled(): Promise<{ installed: boolean; binaryPath?: string; error?: string }> {
  try {
    // Check host path (where downloader is stored)
    const hostBinaryPath = path.join(config.hostDownloaderPath, 'hytale-downloader-linux-amd64');
    if (existsSync(hostBinaryPath)) {
      // Return container path (same structure as host path)
      const containerDownloaderPath = getHytaleDownloaderPath();
      const containerBinaryPath = path.join(containerDownloaderPath, 'hytale-downloader-linux-amd64');
      return { installed: true, binaryPath: containerBinaryPath };
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

    // Verify binary exists after extraction
    const hostBinaryPath = path.join(extractDir, 'hytale-downloader-linux-amd64');
    if (!existsSync(hostBinaryPath)) {
      return { success: false, error: 'Binary not found after extraction' };
    }

    // Make binary executable on host
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

    // Return container path for execution (host path is mounted in container)
    const containerDownloaderPath = getHytaleDownloaderPath();
    const containerBinaryPath = path.join(containerDownloaderPath, 'hytale-downloader-linux-amd64');

    onProgress?.({
      step: 'extracting-downloader',
      stepProgress: 100,
      overallProgress: 100,
      message: 'Extracted downloader and made binary executable',
    });

    return { success: true, binaryPath: containerBinaryPath };
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
