import {
  isDownloaderInstalled,
  installDownloader,
  type ProgressCallback,
} from './hytaleDownloader.js';
import {
  downloadAndExtractServerFiles,
  checkServerFilesInstalled,
  type DockerCpCommand,
} from './serverFileDownloader.js';

/**
 * Ensure hytale-downloader is installed in the manager data folder.
 * Creates the folder if missing and installs the binary if not present.
 */
export async function ensureDownloaderInstalled(
  onProgress?: ProgressCallback
): Promise<{ success: boolean; error?: string }> {
  const installed = await isDownloaderInstalled();
  if (installed.installed) {
    return { success: true };
  }
  const result = await installDownloader(onProgress);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true };
}

/**
 * Download and extract game files: ensure downloader is installed, then download
 * latest game (per patchline) and extract on manager. User must manually copy
 * files to the game container using the returned docker cp command.
 */
export async function downloadAndExtractGameFiles(
  patchline?: 'release' | 'pre-release',
  onProgress?: ProgressCallback
): Promise<{ success: boolean; error?: string; manualCopyRequired?: boolean; dockerCp?: DockerCpCommand }> {
  const ensure = await ensureDownloaderInstalled(onProgress);
  if (!ensure.success) {
    return { success: false, error: ensure.error };
  }
  return downloadAndExtractServerFiles(patchline, onProgress);
}

/**
 * Check if game files (HytaleServer.jar and Assets.zip) are present in the game container.
 */
export async function checkGameFilesInstalled(): Promise<{
  installed: boolean;
  hasJar: boolean;
  hasAssets: boolean;
}> {
  return checkServerFilesInstalled();
}
