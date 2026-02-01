import { Router, Request, Response } from 'express';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import * as dockerService from '../../services/docker.js';
import * as fileAccess from '../../utils/fileAccess.js';
import {
  checkDownloaderCredentials,
  getLatestVersion,
  readPanelConfig,
} from './utils.js';

const router = Router();

// In-memory state for downloader OAuth flow
let downloaderOAuthState: {
  active: boolean;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: Date;
} = { active: false };

// GET /api/server/downloader/auth-status - Check downloader authentication status
router.get('/downloader/auth-status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const credCheck = await checkDownloaderCredentials();

    // Try to get version as a test
    if (credCheck.exists) {
      const testResult = await getLatestVersion('release');
      res.json({
        authenticated: testResult.version !== 'unknown' && !testResult.authRequired,
        credentialsExist: true,
        authRequired: testResult.authRequired || false,
        error: testResult.authRequired ? 'Token expired or invalid' : undefined,
      });
    } else {
      res.json({
        authenticated: false,
        credentialsExist: false,
        authRequired: true,
        error: 'No credentials found',
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check downloader auth status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/downloader/initiate-auth - Start downloader OAuth flow
router.post('/downloader/initiate-auth', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    console.log('[Server] Initiating downloader OAuth flow...');

    // First, delete existing credentials to force re-authentication
    await dockerService.execInGameServerContainer(
      `rm -f ${config.hytaleContainerServerPath}/downloader/.hytale-downloader-credentials.json 2>/dev/null || true`
    );

    // Run the downloader - it will start OAuth flow when credentials are missing
    // Use a timeout since it will wait for user input
    const authResult = await dockerService.execInGameServerContainer(
      `cd ${config.hytaleContainerServerPath}/downloader && timeout 60 ./hytale-downloader-linux-amd64 2>&1 || true`
    );
    

    const output = authResult.output || '';
    console.log('[Server] Downloader auth output:', output.substring(0, 1000));

    // Parse OAuth URLs from output
    // The downloader outputs: "Visit: https://oauth.accounts.hytale.com/oauth2/device/verify"
    // And a user code like: "Enter code: fHmkjxFE" or the code might be in the URL
    const urlMatch = output.match(/(https:\/\/oauth\.accounts\.hytale\.com\/[^\s\n\]]+)/i);

    // Try multiple patterns for the user code
    let userCode: string | null = null;
    const codePatterns = [
      /(?:enter\s+code|user_code|code)[:\s=]+([A-Za-z0-9]{6,12})/i,
      /user_code=([A-Za-z0-9]{6,12})/i,
      /\[([A-Za-z0-9]{8})\]/,  // Code might be in brackets
    ];

    for (const pattern of codePatterns) {
      const match = output.match(pattern);
      if (match) {
        userCode = match[1].trim();
        break;
      }
    }

    if (!urlMatch) {
      // Check if already authenticated or if download started
      if (output.includes('Downloading') || output.includes('already') || output.includes('authenticated') || output.includes('success')) {
        return res.json({
          success: true,
          alreadyAuthenticated: true,
          message: 'Downloader is already authenticated',
        });
      }

      // Maybe the downloader isn't installed or there's another issue
      return res.status(400).json({
        success: false,
        error: 'Could not parse OAuth URL from downloader output. The downloader may need to be reinstalled.',
        output: output.substring(0, 800),
      });
    }

    let verificationUrl = urlMatch[1].trim();

    // Clean up URL - remove any trailing characters that might have been captured
    verificationUrl = verificationUrl.replace(/[\]\)\}\s]+$/, '');

    // If URL doesn't have user_code, add it
    if (userCode && !verificationUrl.includes('user_code=')) {
      verificationUrl += verificationUrl.includes('?') ? `&user_code=${userCode}` : `?user_code=${userCode}`;
    }

    // Store state
    downloaderOAuthState = {
      active: true,
      verificationUrl,
      userCode: userCode || undefined,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    };

    res.json({
      success: true,
      verificationUrl,
      userCode,
      expiresIn: 900, // 15 minutes
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to initiate downloader auth',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/downloader/auth-poll - Poll for auth completion
router.get('/downloader/auth-poll', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    if (!downloaderOAuthState.active) {
      return res.json({
        completed: false,
        error: 'No active auth flow',
      });
    }

    // Check if expired
    if (downloaderOAuthState.expiresAt && new Date() > downloaderOAuthState.expiresAt) {
      downloaderOAuthState = { active: false };
      return res.json({
        completed: false,
        expired: true,
        error: 'Auth flow expired',
      });
    }

    // Check if credentials now exist and work
    const credCheck = await checkDownloaderCredentials();
    if (credCheck.exists) {
      const testResult = await getLatestVersion('release');
      if (testResult.version !== 'unknown' && !testResult.authRequired) {
        downloaderOAuthState = { active: false };
        return res.json({
          completed: true,
          version: testResult.version,
        });
      }
    }

    res.json({
      completed: false,
      verificationUrl: downloaderOAuthState.verificationUrl,
      userCode: downloaderOAuthState.userCode,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to poll auth status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/check-update - Check if a Hytale server update is available
router.get('/check-update', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return mock update status

  try {
    // Read installed version from file
    const versionFilePath = path.join(config.gameDataPath, '.hytale-version');
    let installedVersion = 'unknown';
    try {
      installedVersion = (await fileAccess.readServerFile(versionFilePath)).trim();
    } catch {
      // Version file doesn't exist yet
    }

    // Get current patchline setting from panel config
    const panelConfig = await readPanelConfig();
    const currentPatchline = panelConfig.patchline;

    // Check both patchlines in parallel
    const [releaseResult, preReleaseResult] = await Promise.all([
      getLatestVersion('release'),
      getLatestVersion('pre-release')
    ]);

    // Check if any auth is required
    const authRequired = releaseResult.authRequired || preReleaseResult.authRequired;

    // Check if update is available for current patchline
    const latestVersionResult = currentPatchline === 'release' ? releaseResult : preReleaseResult;
    const latestVersion = latestVersionResult.version;
    const updateAvailable = installedVersion !== 'unknown' &&
                           latestVersion !== 'unknown' &&
                           installedVersion !== latestVersion;

    // Determine appropriate message
    let message: string;
    if (authRequired) {
      message = 'Downloader authentication required. Please re-authenticate to check for updates.';
    } else if (updateAvailable) {
      message = `Update available: ${installedVersion} → ${latestVersion}`;
    } else if (installedVersion === latestVersion) {
      message = 'Server is up to date';
    } else if (latestVersion === 'unknown') {
      message = 'Could not fetch latest version. Check network connection or re-authenticate.';
    } else {
      message = 'Could not determine update status';
    }

    res.json({
      installedVersion,
      latestVersion,
      updateAvailable,
      patchline: currentPatchline,
      authRequired, // NEW: indicates if re-authentication is needed
      // Include both patchline versions
      versions: {
        release: releaseResult.version,
        preRelease: preReleaseResult.version
      },
      message,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check for updates',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
