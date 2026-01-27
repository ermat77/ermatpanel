import path from 'path';
import { config } from '../config.js';
import * as dockerService from './docker.js';
import { readPanelConfig } from '../routes/server/utils.js';
import * as fileAccess from '../utils/fileAccess.js';
import { isDownloaderInstalled } from './hytaleDownloader.js';

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
 * Download server files using the hytale-downloader
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

    // Check if downloader is installed
    const downloaderCheck = await isDownloaderInstalled();
    if (!downloaderCheck.installed || !downloaderCheck.binaryPath) {
      return {
        success: false,
        error: 'Hytale downloader is not installed. Please install it first.',
      };
    }

    // Get patchline from panel config if not provided
    let targetPatchline = patchline;
    if (!targetPatchline) {
      const panelConfig = await readPanelConfig();
      targetPatchline = (panelConfig.patchline || 'release') as 'release' | 'pre-release';
    }

    // Ensure server directory exists
    await dockerService.execInGameServerContainer(
      `mkdir -p ${config.hytaleContainerServerPath}`
    );

    // Run downloader to download server files
    // The downloader downloads to game.zip by default in the current directory
    // We specify -download-path to ensure it downloads to game.zip in the server directory
    const downloaderPath = downloaderCheck.binaryPath;
    const gameZipPath = path.join(config.hytaleContainerServerPath, 'game.zip');
    const downloadCommand = `cd ${config.hytaleContainerServerPath} && ${downloaderPath} -patchline ${targetPatchline} -download-path game.zip 2>&1`;

    console.log(`[ServerFileDownloader] Running downloader with patchline: ${targetPatchline}`);
    onProgress?.({
      step: 'downloading-server',
      stepProgress: 30,
      overallProgress: 30,
      message: `Downloading server files (${targetPatchline})...`,
    });

    const downloadResult = await dockerService.execInGameServerContainer(downloadCommand);

    if (!downloadResult.success) {
      // Check if it's an auth error
      const output = downloadResult.output || '';
      if (output.includes('authentication') || output.includes('unauthorized') || output.includes('token')) {
        return {
          success: false,
          error: 'Downloader authentication required. Please authenticate the downloader first.',
        };
      }
      return {
        success: false,
        error: `Failed to download server files: ${downloadResult.error || 'Unknown error'}`,
      };
    }

    onProgress?.({
      step: 'downloading-server',
      stepProgress: 100,
      overallProgress: 70,
      message: 'Downloaded server files',
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download server files',
    };
  }
}

/**
 * Extract downloaded server files
 */
export async function extractServerFiles(
  onProgress?: ProgressCallback
): Promise<{ success: boolean; error?: string }> {
  try {
    onProgress?.({
      step: 'extracting-server',
      stepProgress: 0,
      overallProgress: 70,
      message: 'Extracting server files...',
    });

    // The hytale-downloader downloads to game.zip in the server directory
    const gameZipPath = path.join(config.hytaleContainerServerPath, 'game.zip');
    
    // Check if game.zip exists
    const checkZipResult = await dockerService.execInGameServerContainer(
      `test -f ${gameZipPath} && echo "exists" || echo "missing"`
    );

    if (checkZipResult.success && checkZipResult.output?.includes('exists')) {
      // Extract game.zip
      onProgress?.({
        step: 'extracting-server',
        stepProgress: 30,
        overallProgress: 75,
        message: 'Extracting game.zip...',
      });

      const extractResult = await dockerService.execInGameServerContainer(
        `cd ${config.hytaleContainerServerPath} && unzip -o game.zip 2>&1`
      );

      if (!extractResult.success) {
        return { success: false, error: `Failed to extract game.zip: ${extractResult.error}` };
      }

      // Move files from Server subdirectory if it exists (hytale-downloader creates this)
      onProgress?.({
        step: 'extracting-server',
        stepProgress: 60,
        overallProgress: 85,
        message: 'Organizing extracted files...',
      });

      const serverDirPath = path.join(config.hytaleContainerServerPath, 'Server');
      const checkServerDirResult = await dockerService.execInGameServerContainer(
        `test -d ${serverDirPath} && echo "exists" || echo "missing"`
      );

      if (checkServerDirResult.success && checkServerDirResult.output?.includes('exists')) {
        // Move files from Server/* to the server directory
        const moveResult = await dockerService.execInGameServerContainer(
          `cd ${config.hytaleContainerServerPath} && mv Server/* . 2>/dev/null && rm -rf Server || true`
        );
        
        if (!moveResult.success) {
          console.warn('[ServerFileDownloader] Failed to move files from Server directory, continuing anyway');
        }
      }

      // Remove the ZIP file after extraction
      await dockerService.execInGameServerContainer(
        `rm -f ${gameZipPath}`
      );
    } else {
      // If no game.zip, check if files are already extracted
      // The downloader might have already extracted them
      console.log('[ServerFileDownloader] No game.zip found, checking if files are already extracted...');
    }

    // Verify files exist using fileAccess
    onProgress?.({
      step: 'extracting-server',
      stepProgress: 90,
      overallProgress: 95,
      message: 'Verifying extracted files...',
    });

    try {
      await fileAccess.readServerFile(path.join(config.hytaleContainerServerPath, 'HytaleServer.jar'));
    } catch {
      return { success: false, error: 'HytaleServer.jar not found after extraction' };
    }

    try {
      await fileAccess.readServerFile(path.join(config.hytaleContainerServerPath, 'Assets.zip'));
    } catch {
      return { success: false, error: 'Assets.zip not found after extraction' };
    }

    onProgress?.({
      step: 'extracting-server',
      stepProgress: 100,
      overallProgress: 100,
      message: 'Server files extracted successfully',
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to extract server files',
    };
  }
}

/**
 * Download and extract server files (complete process)
 */
export async function downloadAndExtractServerFiles(
  patchline?: 'release' | 'pre-release',
  onProgress?: ProgressCallback
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('[ServerFileDownloader] Starting server file download and extraction...');

    // Step 1: Download server files
    const downloadResult = await downloadServerFiles(patchline, onProgress);
    if (!downloadResult.success) {
      return downloadResult;
    }

    // Step 2: Extract server files
    const extractResult = await extractServerFiles(onProgress);
    if (!extractResult.success) {
      return extractResult;
    }

    console.log('[ServerFileDownloader] Server file download and extraction completed successfully');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to download and extract server files',
    };
  }
}

/**
 * Check if server files are already downloaded
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
