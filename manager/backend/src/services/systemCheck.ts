import Docker from 'dockerode';
import * as os from 'os';
import * as net from 'net';
import * as dgram from 'dgram';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { promisify } from 'util';
import { exec } from 'child_process';
import { config } from '../config.js';

const execAsync = promisify(exec);
const dnsResolve = promisify(dns.resolve);

// ============================================================
// Types
// ============================================================

export interface SystemCheck {
  id: string;
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  required: boolean;
  details?: string;
}

export interface SystemCheckResult {
  checks: SystemCheck[];
  canProceed: boolean;
}

// ============================================================
// Individual Check Functions
// ============================================================

/**
 * Check if Docker socket is accessible and dockerode can connect
 */
async function checkDockerSocket(): Promise<SystemCheck> {
  const check: SystemCheck = {
    id: 'docker_socket',
    name: 'Docker Socket',
    status: 'error',
    message: 'Checking...',
    required: true,
  };

  console.log('[SystemCheck] Starting Docker socket check...');

  // Get Docker socket path - check if we're in Docker container first
  const hasDockerenv = fs.existsSync('/.dockerenv');
  const hasDockerEnv = !!process.env.DOCKER_CONTAINER;
  const isInDocker = hasDockerenv || hasDockerEnv;
  const platform = os.platform();
  
  console.log('[SystemCheck] Environment detection:');
  console.log(`  - Platform: ${platform}`);
  console.log(`  - /.dockerenv exists: ${hasDockerenv}`);
  console.log(`  - DOCKER_CONTAINER env: ${hasDockerEnv}`);
  console.log(`  - Running in Docker: ${isInDocker}`);
  
  // If in Docker container, always use Unix socket (even on Windows host)
  // Otherwise, use platform-specific path
  const socketPath = isInDocker
    ? '/var/run/docker.sock'
    : (platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');

  console.log(`[SystemCheck] Selected socket path: ${socketPath}`);

  try {
    // On Windows native or when in Docker, check socket accessibility
    // Named pipes on Windows don't support access() check, so skip it for native Windows
    if (!isInDocker && platform === 'win32') {
      console.log('[SystemCheck] Skipping file access check for Windows named pipe');
    } else {
      // First check if socket file exists (Linux/Mac/Docker)
      console.log(`[SystemCheck] Checking socket file accessibility: ${socketPath}`);
      try {
        await fs.promises.access(socketPath, fs.constants.R_OK | fs.constants.W_OK);
        console.log('[SystemCheck] Socket file is accessible');
        
        // Get file stats for additional info
        const stats = await fs.promises.stat(socketPath);
        console.log(`[SystemCheck] Socket file stats: mode=${stats.mode.toString(8)}, uid=${stats.uid}, gid=${stats.gid}`);
      } catch (accessError) {
        const accessErr = accessError as NodeJS.ErrnoException;
        console.error(`[SystemCheck] Socket file access check failed: ${accessErr.code} - ${accessErr.message}`);
        throw accessError;
      }
    }

    // Try to connect using dockerode
    console.log(`[SystemCheck] Attempting to connect to Docker using socket: ${socketPath}`);
    const docker = new Docker({ socketPath });
    
    console.log('[SystemCheck] Calling docker.info()...');
    const info = await docker.info();
    console.log('[SystemCheck] Successfully connected to Docker');
    console.log(`  - Server Version: ${info.ServerVersion}`);
    console.log(`  - Containers: ${info.Containers}`);
    console.log(`  - Images: ${info.Images}`);
    console.log(`  - Operating System: ${info.OperatingSystem}`);

    check.status = 'ok';
    check.message = 'Connected';
    check.details = `Docker version: ${info.ServerVersion}, Containers: ${info.Containers}`;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    
    console.error('[SystemCheck] Docker socket check failed:');
    console.error(`  - Error code: ${err.code || 'N/A'}`);
    console.error(`  - Error message: ${err.message || 'N/A'}`);
    console.error(`  - Error name: ${err.name || 'N/A'}`);
    if (err.stack) {
      console.error(`  - Stack trace: ${err.stack}`);
    }

    if (err.code === 'ENOENT') {
      check.status = 'error';
      check.message = 'Docker socket not found';
      check.details = `Docker must be installed and running. Socket path: ${socketPath}`;
      console.error(`[SystemCheck] Socket file does not exist at: ${socketPath}`);
    } else if (err.code === 'EACCES') {
      check.status = 'error';
      check.message = 'Permission denied';
      check.details = `Cannot access Docker socket. Ensure the container has access to ${socketPath}`;
      console.error(`[SystemCheck] Permission denied accessing socket. Current process:`);
      console.error(`  - UID: ${process.getuid ? process.getuid() : 'N/A (Windows)'}`);
      console.error(`  - GID: ${process.getgid ? process.getgid() : 'N/A (Windows)'}`);
      console.error(`[SystemCheck] Try: chmod 666 ${socketPath} or add user to docker group`);
    } else {
      check.status = 'error';
      check.message = 'Connection failed';
      check.details = err.message || 'Unknown error connecting to Docker';
      console.error(`[SystemCheck] Unexpected error: ${err.code || 'N/A'} - ${err.message}`);
    }
  }

  console.log(`[SystemCheck] Docker socket check completed: ${check.status} - ${check.message}`);
  return check;
}

/**
 * Check if a TCP port is free
 */
async function checkTcpPort(port: number): Promise<{ free: boolean; process?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port is in use, try to find which process
        let processInfo: string | undefined;

        try {
          // Try to find which process is using the port (Linux)
          const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | grep ':${port} ' || lsof -i :${port} 2>/dev/null | head -2 || echo ""`);
          if (stdout.trim()) {
            // Extract process name from output
            const match = stdout.match(/users:\(\("([^"]+)"/) || stdout.match(/\b(\w+)\s+\d+\s+\w+/);
            if (match) {
              processInfo = match[1];
            } else {
              processInfo = stdout.trim().split('\n')[0].substring(0, 50);
            }
          }
        } catch {
          // Ignore errors in process detection
        }

        resolve({ free: false, process: processInfo });
      } else {
        resolve({ free: false, process: `Error: ${err.message}` });
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve({ free: true });
      });
    });

    server.listen(port, '0.0.0.0');
  });
}

/**
 * Check if a UDP port is free
 */
async function checkUdpPort(port: number): Promise<{ free: boolean; process?: string }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');

    socket.once('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port is in use, try to find which process
        let processInfo: string | undefined;

        try {
          const { stdout } = await execAsync(`ss -ulnp 2>/dev/null | grep ':${port} ' || lsof -i UDP:${port} 2>/dev/null | head -2 || echo ""`);
          if (stdout.trim()) {
            const match = stdout.match(/users:\(\("([^"]+)"/) || stdout.match(/\b(\w+)\s+\d+\s+\w+/);
            if (match) {
              processInfo = match[1];
            } else {
              processInfo = stdout.trim().split('\n')[0].substring(0, 50);
            }
          }
        } catch {
          // Ignore errors in process detection
        }

        resolve({ free: false, process: processInfo });
      } else {
        resolve({ free: false, process: `Error: ${err.message}` });
      }
    });

    socket.once('listening', () => {
      socket.close(() => {
        resolve({ free: true });
      });
    });

    socket.bind(port, '0.0.0.0');
  });
}

/**
 * Check if required ports are available
 * Uses external ports from config for user-facing display
 *
 * Note: Manager port check is informational only since:
 * - It's used by our own Node process (will always show "in use")
 * - When using a reverse proxy (domain), the port doesn't matter
 */
async function checkPorts(): Promise<SystemCheck[]> {
  // Use ports from config - these are the external (host) ports
  const serverPort = config.serverPort;
  const managerPort = config.externalPort;
  const webMapPort = config.webMapPort;
  const webMapWsPort = config.webMapWsPort;

  // Manager port is NOT required because:
  // 1. It's already in use by this Node process
  // 2. If using reverse proxy, the external port doesn't matter
  const portChecks = [
    { port: serverPort, protocol: 'UDP', name: 'Game Server', required: true },
    { port: webMapPort, protocol: 'TCP', name: 'WebMap HTTP', required: false },
    { port: webMapWsPort, protocol: 'TCP', name: 'WebMap WebSocket', required: false },
  ];

  const results: SystemCheck[] = [];

  for (const { port, protocol, name, required } of portChecks) {
    const check: SystemCheck = {
      id: `port_${port}`,
      name: `Port ${port} (${protocol})`,
      status: 'error',
      message: 'Checking...',
      required,
    };

    const result = protocol === 'UDP'
      ? await checkUdpPort(port)
      : await checkTcpPort(port);

    if (result.free) {
      check.status = 'ok';
      check.message = 'Available';
      check.details = `${name} port is free`;
    } else {
      check.status = required ? 'error' : 'warning';
      check.message = result.process ? `In use by ${result.process}` : 'In use';
      check.details = required
        ? `Port ${port}/${protocol} must be free for ${name}`
        : `${name} will be disabled if port is not available`;
    }

    results.push(check);
  }

  // Add manager port as informational (always OK since we're running)
  results.unshift({
    id: `port_${managerPort}`,
    name: `Port ${managerPort} (TCP)`,
    status: 'ok',
    message: 'Active',
    required: false,
    details: `Panel active. With reverse proxy, only internal access needed.`,
  });

  return results;
}

/**
 * Check available disk space
 */
async function checkDiskSpace(): Promise<SystemCheck> {
  const check: SystemCheck = {
    id: 'disk_space',
    name: 'Disk Space',
    status: 'error',
    message: 'Checking...',
    required: true,
  };

  // Determine the correct data path based on environment:
  // - In Docker (production): Use container path (mounted volume)
  // - In dev (not in Docker): Use host path (absolute path on host machine)
  const isInDocker = fs.existsSync('/.dockerenv') || !!process.env.DOCKER_CONTAINER;
  const dataPath = isInDocker 
    ? config.hytaleContainerDataPath  // Docker: /opt/hytale/data (mounted from host)
    : path.join(config.hostDataPath, 'data');  // Dev: hostDataPath/data (absolute host path)
  const hostDataPath = config.hostDataPath;
  const minSpaceGB = 10;
  const minSpaceBytes = minSpaceGB * 1024 * 1024 * 1024;

  try {
    let availableBytes: number;

    // Check if running on Windows (in dev mode)
    const isWindows = process.platform === 'win32';

    if (isWindows && !isInDocker) {
      // Windows: Use PowerShell to get disk space
      // Get the drive letter from the path (e.g., C from C:/Users/... or C:\Users\...)
      const driveMatch = dataPath.match(/^([A-Za-z]):/);
      const driveLetter = driveMatch ? driveMatch[1] : 'C';
      
      // Use PowerShell to get free space for the drive
      // Get-PSDrive returns free space in bytes
      const psCommand = `powershell -Command "(Get-PSDrive -Name '${driveLetter}').Free"`;
      const { stdout } = await execAsync(psCommand);
      const freeSpaceStr = stdout.trim();
      availableBytes = parseInt(freeSpaceStr, 10);
      
      if (isNaN(availableBytes)) {
        throw new Error(`Could not parse available space from PowerShell output: "${freeSpaceStr}"`);
      }
    } else {
      // Linux/Unix: Use df command to get disk space info
      const { stdout } = await execAsync(`df -B1 "${dataPath}" 2>/dev/null || df -B1 / 2>/dev/null`);
      const lines = stdout.trim().split('\n');

      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        // df output: Filesystem, 1B-blocks, Used, Available, Use%, Mounted on
        // Sometimes output can wrap, so find the numeric values
        availableBytes = NaN;

        // Try to find the "Available" column (usually index 3)
        for (let i = 1; i < parts.length; i++) {
          const val = parseInt(parts[i], 10);
          if (!isNaN(val) && i >= 3) {
            availableBytes = val;
            break;
          }
        }

        // Fallback: try parts[3] directly
        if (isNaN(availableBytes) && parts[3]) {
          availableBytes = parseInt(parts[3], 10);
        }

        if (isNaN(availableBytes)) {
          throw new Error('Could not parse available space from df output');
        }
      } else {
        throw new Error('Could not parse df output');
      }
    }

    const availableGB = availableBytes / (1024 * 1024 * 1024);

    if (availableBytes >= minSpaceBytes) {
      check.status = 'ok';
      check.message = `${availableGB.toFixed(1)} GB available`;
      check.details = `Path: ${hostDataPath}`;
    } else {
      check.status = 'error';
      check.message = `Only ${availableGB.toFixed(1)} GB available`;
      check.details = `Minimum: ${minSpaceGB} GB at ${hostDataPath}`;
    }
  } catch (error) {
    const err = error as Error;
    check.status = 'error';
    check.message = 'Could not check disk space';
    check.details = err.message;
  }

  return check;
}

/**
 * Check available RAM
 */
async function checkRam(): Promise<SystemCheck> {
  const check: SystemCheck = {
    id: 'ram',
    name: 'RAM',
    status: 'error',
    message: 'Checking...',
    required: true,
  };

  const minRamGB = 6;
  const recommendedRamGB = 8;
  const minRamBytes = minRamGB * 1024 * 1024 * 1024;
  const recommendedRamBytes = recommendedRamGB * 1024 * 1024 * 1024;

  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const totalGB = totalMem / (1024 * 1024 * 1024);
    const freeGB = freeMem / (1024 * 1024 * 1024);

    if (totalMem >= recommendedRamBytes) {
      check.status = 'ok';
      check.message = `${totalGB.toFixed(1)} GB total`;
      check.details = `${freeGB.toFixed(1)} GB currently free. Recommended: ${recommendedRamGB}+ GB`;
    } else if (totalMem >= minRamBytes) {
      check.status = 'warning';
      check.message = `${totalGB.toFixed(1)} GB total`;
      check.details = `${freeGB.toFixed(1)} GB free. Minimum met, but ${recommendedRamGB}+ GB recommended`;
    } else {
      check.status = 'error';
      check.message = `Only ${totalGB.toFixed(1)} GB total`;
      check.details = `Minimum required: ${minRamGB} GB, recommended: ${recommendedRamGB}+ GB`;
    }
  } catch (error) {
    const err = error as Error;
    check.status = 'error';
    check.message = 'Could not check RAM';
    check.details = err.message;
  }

  return check;
}

/**
 * Check write permissions in data directory
 * Checks both game server data path (where manager writes configs) and manager's own data path
 */
async function checkWritePermissions(): Promise<SystemCheck> {
  const check: SystemCheck = {
    id: 'write_permissions',
    name: 'Write Permissions',
    status: 'error',
    message: 'Checking...',
    required: true,
  };

  // Determine the correct data path based on environment:
  // - In Docker (production): Use container path (mounted volume)
  // - In dev (not in Docker): Use host path (absolute path on host machine)
  const isInDocker = fs.existsSync('/.dockerenv') || !!process.env.DOCKER_CONTAINER;
  const dataPath = isInDocker 
    ? config.hytaleContainerDataPath  // Docker: /opt/hytale/data (mounted from host)
    : path.join(config.hostDataPath, 'data');  // Dev: hostDataPath/data (absolute host path)
  const hostDataPath = config.hostDataPath;
  const testFileName = `.write-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const testFilePath = path.join(dataPath, testFileName);

  try {
    // Ensure directory exists
    await fs.promises.mkdir(dataPath, { recursive: true });

    // Try to write a test file
    await fs.promises.writeFile(testFilePath, 'test', 'utf-8');

    // Try to read it back
    await fs.promises.readFile(testFilePath, 'utf-8');

    // Delete the test file
    await fs.promises.unlink(testFilePath);

    check.status = 'ok';
    check.message = 'Writable';
    check.details = `Path: ${hostDataPath}/data`;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'EACCES') {
      check.status = 'error';
      check.message = 'Permission denied';
      check.details = `Cannot write to ${hostDataPath}/data. Run: sudo mkdir -p ${hostDataPath}/data && sudo chown -R 1000:1000 ${hostDataPath}`;
    } else if (err.code === 'ENOENT') {
      check.status = 'error';
      check.message = 'Directory not found';
      check.details = `Host path ${hostDataPath}/data does not exist. Run: sudo mkdir -p ${hostDataPath}/{data,server,backups,plugins,mods,auth,assets,downloader}`;
    } else {
      check.status = 'error';
      check.message = 'Write failed';
      check.details = err.message || 'Unknown error';
    }
  }

  return check;
}

/**
 * Check DNS resolution
 */
async function checkDnsResolution(): Promise<SystemCheck> {
  const check: SystemCheck = {
    id: 'dns',
    name: 'DNS Resolution',
    status: 'error',
    message: 'Checking...',
    required: true,
  };

  try {
    await dnsResolve('google.com');
    check.status = 'ok';
    check.message = 'Working';
    check.details = 'DNS resolution successful';
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    check.status = 'error';
    check.message = 'DNS failed';
    check.details = err.code === 'ENOTFOUND'
      ? 'Cannot resolve DNS. Check internet connection.'
      : `DNS error: ${err.message}`;
  }

  return check;
}

/**
 * Check connection to Hytale download server
 */
async function checkHytaleServer(): Promise<SystemCheck> {
  const check: SystemCheck = {
    id: 'hytale_server',
    name: 'Hytale Server',
    status: 'error',
    message: 'Checking...',
    required: true,
  };

  const hostname = 'downloader.hytale.com';
  const timeout = 10000; // 10 seconds

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname,
        port: 443,
        path: '/',
        method: 'HEAD',
        timeout,
      },
      (res) => {
        // Any response means the server is reachable
        check.status = 'ok';
        check.message = 'Reachable';
        check.details = `${hostname} responded with status ${res.statusCode}`;
        resolve(check);
      }
    );

    req.on('error', (error: NodeJS.ErrnoException) => {
      check.status = 'error';
      check.message = 'Unreachable';
      check.details = error.code === 'ENOTFOUND'
        ? `Cannot reach ${hostname}. Check internet connection.`
        : `Connection error: ${error.message}`;
      resolve(check);
    });

    req.on('timeout', () => {
      req.destroy();
      check.status = 'error';
      check.message = 'Timeout';
      check.details = `Connection to ${hostname} timed out after ${timeout / 1000}s`;
      resolve(check);
    });

    req.end();
  });
}

// ============================================================
// Main Function
// ============================================================

/**
 * Run all system checks and return results
 */
export async function runSystemChecks(): Promise<SystemCheckResult> {
  const checks: SystemCheck[] = [];

  // Run independent checks in parallel for speed
  const [
    dockerCheck,
    portChecks,
    diskCheck,
    ramCheck,
    writeCheck,
    dnsCheck,
    hytaleCheck,
  ] = await Promise.all([
    checkDockerSocket(),
    checkPorts(),
    checkDiskSpace(),
    checkRam(),
    checkWritePermissions(),
    checkDnsResolution(),
    checkHytaleServer(),
  ]);

  // Add all checks to results
  checks.push(dockerCheck);
  checks.push(...portChecks);
  checks.push(diskCheck);
  checks.push(ramCheck);
  checks.push(writeCheck);
  checks.push(dnsCheck);
  checks.push(hytaleCheck);

  // Determine if setup can proceed
  // All required checks must be ok or warning (not error)
  const canProceed = checks
    .filter((c) => c.required)
    .every((c) => c.status !== 'error');

  return {
    checks,
    canProceed,
  };
}

/**
 * Run a single system check by ID
 */
export async function runSingleCheck(checkId: string): Promise<SystemCheck | null> {
  switch (checkId) {
    case 'docker_socket':
      return checkDockerSocket();
    case 'disk_space':
      return checkDiskSpace();
    case 'ram':
      return checkRam();
    case 'write_permissions':
      return checkWritePermissions();
    case 'dns':
      return checkDnsResolution();
    case 'hytale_server':
      return checkHytaleServer();
    default:
      // Check if it's a port check
      if (checkId.startsWith('port_')) {
        const port = parseInt(checkId.replace('port_', ''), 10);
        if (!isNaN(port)) {
          // Use dynamic ports from config
          const serverPort = config.serverPort;
          const managerPort = config.externalPort;
          const webMapPort = parseInt(process.env.WEBMAP_PORT || '18081', 10);
          const webMapWsPort = parseInt(process.env.WEBMAP_WS_PORT || '18082', 10);

          const portConfigs = [
            { port: serverPort, protocol: 'UDP', name: 'Game Server', required: true },
            { port: managerPort, protocol: 'TCP', name: 'Manager', required: true },
            { port: webMapPort, protocol: 'TCP', name: 'WebMap HTTP', required: false },
            { port: webMapWsPort, protocol: 'TCP', name: 'WebMap WebSocket', required: false },
          ];

          const portConfig = portConfigs.find((p) => p.port === port);
          if (portConfig) {
            const result = portConfig.protocol === 'UDP'
              ? await checkUdpPort(port)
              : await checkTcpPort(port);

            return {
              id: checkId,
              name: `Port ${port} (${portConfig.protocol})`,
              status: result.free ? 'ok' : (portConfig.required ? 'error' : 'warning'),
              message: result.free ? 'Available' : (result.process ? `In use by ${result.process}` : 'In use'),
              required: portConfig.required,
              details: result.free
                ? `${portConfig.name} port is free`
                : portConfig.required
                  ? `Port ${port}/${portConfig.protocol} must be free for ${portConfig.name}`
                  : `${portConfig.name} will be disabled if port is not available`,
            };
          }
        }
      }
      return null;
  }
}
