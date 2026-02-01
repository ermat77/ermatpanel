import Docker from 'dockerode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import * as tarStream from 'tar-stream';
import { config } from '../config.js';
import type { ServerStatus, ServerStats, ActionResponse } from '../types/index.js';
import { validateCommand, escapeShellArg } from '../utils/sanitize.js';
import { clearOnlinePlayers } from './players.js';

/**
 * Get the Docker socket path based on the operating system
 * - When running in Docker container: Always use /var/run/docker.sock
 * - Windows (native): Uses named pipe //./pipe/docker_engine
 * - Linux/Mac (native): Uses Unix socket /var/run/docker.sock
 */
function getDockerSocketPath(): string {
  // Check if we're running inside a Docker container
  const hasDockerenv = fs.existsSync('/.dockerenv');
  const hasDockerEnv = !!process.env.DOCKER_CONTAINER;
  const isInDocker = hasDockerenv || hasDockerEnv;
  
  console.log('[Docker] Initializing Docker connection...');
  console.log(`[Docker] Environment detection:`);
  console.log(`  - Platform: ${os.platform()}`);
  console.log(`  - /.dockerenv exists: ${hasDockerenv}`);
  console.log(`  - DOCKER_CONTAINER env: ${hasDockerEnv}`);
  console.log(`  - Running in Docker: ${isInDocker}`);
  
  // If in Docker container, always use Unix socket (even on Windows host)
  if (isInDocker) {
    const path = '/var/run/docker.sock';
    console.log(`[Docker] Using Docker socket path (container): ${path}`);
    return path;
  }
  
  // Native execution: check platform
  const platform = os.platform();
  if (platform === 'win32') {
    // Windows uses a named pipe
    const path = '//./pipe/docker_engine';
    console.log(`[Docker] Using Docker socket path (Windows native): ${path}`);
    return path;
  } else {
    // Linux and macOS use Unix socket
    const path = '/var/run/docker.sock';
    console.log(`[Docker] Using Docker socket path (Linux/Mac native): ${path}`);
    return path;
  }
}

const dockerSocketPath = getDockerSocketPath();
console.log(`[Docker] Creating Docker client with socket: ${dockerSocketPath}`);

// Verify socket exists and is accessible before creating client
async function verifyDockerSocket(): Promise<{ accessible: boolean; error?: string }> {
  try {
    // Check if socket file exists (skip for Windows named pipes)
    const isInDocker = fs.existsSync('/.dockerenv') || !!process.env.DOCKER_CONTAINER;
    const platform = os.platform();
    
    if (!isInDocker && platform === 'win32') {
      // Windows named pipes don't support fs.access, skip check
      console.log('[Docker] Skipping socket file check for Windows named pipe');
      return { accessible: true };
    }
    
    // Check if socket file exists
    if (!fs.existsSync(dockerSocketPath)) {
      return {
        accessible: false,
        error: `Docker socket not found at ${dockerSocketPath}. Ensure Docker is running and socket is mounted.`,
      };
    }
    
    // Check if socket is accessible (read and write)
    try {
      await fs.promises.access(dockerSocketPath, fs.constants.R_OK | fs.constants.W_OK);
      console.log('[Docker] Socket file is accessible');
      
      // Get file stats for logging
      const stats = await fs.promises.stat(dockerSocketPath);
      console.log(`[Docker] Socket file stats: mode=${stats.mode.toString(8)}, uid=${stats.uid}, gid=${stats.gid}`);
    } catch (accessError) {
      const err = accessError as NodeJS.ErrnoException;
      return {
        accessible: false,
        error: `Cannot access Docker socket at ${dockerSocketPath}: ${err.code || err.message}. Ensure the container has read-write access to the socket.`,
      };
    }
    
    return { accessible: true };
  } catch (error) {
    return {
      accessible: false,
      error: `Error checking Docker socket: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

const docker = new Docker({ socketPath: dockerSocketPath });
console.log('[Docker] Docker client initialized');

// Test connection to Docker daemon (called on first use)
async function testDockerConnection(): Promise<boolean> {
  try {
    await docker.info();
    console.log('[Docker] ✅ Successfully connected to Docker daemon');
    return true;
  } catch (error) {
    console.error(`[Docker] ❌ Failed to connect to Docker daemon: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

// Verify socket on startup (non-blocking)
verifyDockerSocket().then((socketCheck) => {
  if (!socketCheck.accessible) {
    console.error(`[Docker] ⚠️  WARNING: Docker socket not accessible: ${socketCheck.error}`);
    console.error(`[Docker] ⚠️  Docker operations will fail until socket is accessible`);
  } else {
    console.log('[Docker] ✅ Docker socket verified and accessible');
    // Test connection after socket is verified
    testDockerConnection().catch(() => {
      console.warn('[Docker] ⚠️  Docker connection test failed, but continuing startup');
    });
  }
}).catch((err) => {
  console.warn(`[Docker] ⚠️  Socket verification failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
});


async function getContainer(): Promise<Docker.Container | null> {
  const containerName = config.gameContainerName;
  
  try {
    const container = docker.getContainer(containerName);
    
    // Try to inspect to verify container exists
    try {
      const info = await container.inspect();
      // console.log(`[Docker] ✅ Container found: ${containerName}`);
      // console.log(`[Docker]   - ID: ${info.Id.substring(0, 12)}`);
      // console.log(`[Docker]   - Status: ${info.State.Status}`);
      // console.log(`[Docker]   - Running: ${info.State.Running}`);
      return container;
    } catch (inspectError) {
      console.error(`[Docker] ❌ Container not found or cannot inspect: ${containerName}`);
      console.error(`[Docker]   Error: ${inspectError instanceof Error ? inspectError.message : 'Unknown error'}`);
      return null;
    }
  } catch (error) {
    console.error(`[Docker] ❌ Failed to get container: ${containerName}`);
    console.error(`[Docker]   Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}

export async function getStatus(): Promise<ServerStatus> {
  try {
    // Verify socket is accessible before attempting operations
    const socketCheck = await verifyDockerSocket();
    if (!socketCheck.accessible) {
      console.error(`[Docker] ❌ Cannot access Docker socket: ${socketCheck.error}`);
      return {
        status: 'error',
        running: false,
        error: socketCheck.error || 'Cannot access Docker socket',
      };
    }
    
    const container = await getContainer();
    if (!container) {
      console.error(`[Docker] ❌ Container not found: ${config.gameContainerName}`);
      return {
        status: 'not_found',
        running: false,
        error: 'Container not found',
      };
    }

    const info = await container.inspect();
    const status = {
      status: info.State.Status,
      running: info.State.Running,
      id: info.Id.substring(0, 12),
      name: info.Name.replace('/', ''),
      created: info.Created,
      started_at: info.State.StartedAt,
    };
    return status;
  } catch (error) {
    console.error(`[Docker] ❌ Error getting container status:`, error instanceof Error ? error.message : 'Unknown error');
    return {
      status: 'error',
      running: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function getStats(): Promise<ServerStats> {
  try {
    const container = await getContainer();
    if (!container) {
      return { error: 'Container not found' };
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return { error: 'Container not running' };
    }

    const stats = await container.stats({ stream: false });

    // Calculate CPU percentage
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

    // Memory usage
    const memoryUsage = stats.memory_stats.usage || 0;
    const memoryLimit = stats.memory_stats.limit || 1;
    const memoryPercent = (memoryUsage / memoryLimit) * 100;

    return {
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_bytes: memoryUsage,
      memory_limit_bytes: memoryLimit,
      memory_percent: Math.round(memoryPercent * 100) / 100,
      memory_mb: Math.round(memoryUsage / (1024 * 1024) * 10) / 10,
      memory_limit_mb: Math.round(memoryLimit / (1024 * 1024) * 10) / 10,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function startContainer(): Promise<ActionResponse> {
  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    await container.start();
    return { success: true, message: 'Container started' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function stopContainer(): Promise<ActionResponse> {
  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    await container.stop({ t: 30 });
    // Clear online players when server stops - they can't be online if server is down
    clearOnlinePlayers();
    return { success: true, message: 'Container stopped' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function restartContainer(): Promise<ActionResponse> {

  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    await container.restart({ t: 30 });
    // Clear online players on restart - they need to rejoin after restart
    clearOnlinePlayers();
    return { success: true, message: 'Container restarted' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function getLogs(tail: number = 100): Promise<string> {
  // Always use Docker API - server is always in Docker
  try {
    const container = await getContainer();
    if (!container) {
      console.error(`[Docker] ❌ Cannot get logs - container not found: ${config.gameContainerName}`);
      return '';
    }

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });

    const logContent = logs.toString('utf-8');
    console.log(`[Docker] ✅ Retrieved ${logContent.length} bytes of logs`);
    return logContent;
  } catch (error) {
    console.error(`[Docker] ❌ Error getting logs:`, error instanceof Error ? error.message : 'Unknown error');
    return '';
  }
}

// Store the stdin stream for the container
let stdinStream: NodeJS.WritableStream | null = null;
let stdinAttached = false;

async function ensureStdinAttached(): Promise<boolean> {
  if (stdinAttached && stdinStream) {
    return true;
  }

  
  try {
    const container = await getContainer();
    if (!container) {
      console.error(`[Docker] ❌ Cannot attach stdin - container not found: ${config.gameContainerName}`);
      return false;
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      console.error(`[Docker] ❌ Cannot attach stdin - container not running: ${config.gameContainerName}`);
      return false;
    }

    
    // Attach to container stdin
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });

    stdinStream = stream;
    stdinAttached = true;

    stream.on('error', (error) => {
      console.error(`[Docker] ❌ Stdin stream error:`, error instanceof Error ? error.message : 'Unknown error');
      stdinAttached = false;
      stdinStream = null;
    });

    stream.on('close', () => {
      console.log(`[Docker] 🔌 Stdin stream closed for container: ${config.gameContainerName}`);
      stdinAttached = false;
      stdinStream = null;
    });

    return true;
  } catch (error) {
    console.error(`[Docker] ❌ Failed to attach stdin:`, error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

export async function execCommand(command: string): Promise<ActionResponse> {
  // SECURITY: Validate command against whitelist and injection patterns
  const validation = validateCommand(command);
  if (!validation.valid) {
    console.warn(`[SECURITY] Blocked command: ${command.substring(0, 50)}... Reason: ${validation.error}`);
    return { success: false, error: validation.error || 'Invalid command' };
  }

  // Always use Docker exec - server is always in Docker
  console.log(`[Docker] Executing command in container: ${config.gameContainerName}`);
  console.log(`[Docker] Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
  
  try {
    const container = await getContainer();
    if (!container) {
      console.error(`[Docker] ❌ Cannot execute command - container not found: ${config.gameContainerName}`);
      return { success: false, error: 'Container not found' };
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return { success: false, error: 'Container not running' };
    }

    // Try to use stdin stream first (safest method - no shell interpolation)
    const attached = await ensureStdinAttached();
    if (attached && stdinStream) {
      try {
        stdinStream.write(command + '\n');
        console.log(`[Docker] ✅ Command sent via stdin stream`);
        return { success: true, message: `Command executed: ${command}` };
      } catch (error) {
        console.error(`[Docker] ❌ Failed to write to stdin stream:`, error instanceof Error ? error.message : 'Unknown error');
        // Reset and try fallback
        stdinAttached = false;
        stdinStream = null;
      }
    }

    // SECURITY: Use proper shell escaping for fallback method
    const escapedCommand = escapeShellArg(command);
    console.log(`[Docker] Using fallback method (exec) to send command...`);

    // Fallback: Use screen or tmux if available, or direct write
    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        if command -v screen > /dev/null && screen -list | grep -q hytale; then
          screen -S hytale -p 0 -X stuff ${escapedCommand}$'\n'
        elif [ -p /tmp/server_input ]; then
          echo ${escapedCommand} > /tmp/server_input
        else
          echo ${escapedCommand} >> /proc/1/fd/0
        fi
      `],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});
    console.log(`[Docker] ✅ Command execution started via fallback method`);

    return new Promise((resolve) => {
      stream.on('end', () => {
        console.log(`[Docker] ✅ Command execution completed`);
        resolve({ success: true, message: `Command sent: ${command}` });
      });
      stream.on('error', (err: Error) => {
        resolve({ success: false, error: err.message });
      });

      setTimeout(() => {
        resolve({ success: true, message: `Command sent: ${command}` });
      }, 1000);
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Execute a shell command inside the container and capture output
export async function execInGameServerContainer(command: string): Promise<ActionResponse & { output?: string }> {
  const logPrefix = '[Docker] execInGameServerContainer';
  console.log(`${logPrefix} Running command: ${command}`);

  try {
    const container = await getContainer();
    if (!container) {
      console.error(`${logPrefix} Container not found (name: ${config.gameContainerName})`);
      return { success: false, error: 'Container not found' };
    }

    const info = await container.inspect();
    const containerName = info.Name?.replace(/^\//, '') ?? config.gameContainerName;
    if (!info.State.Running) {
      console.error(`${logPrefix} Container "${containerName}" is not running`);
      return { success: false, error: 'Container not running' };
    }
    console.log(`${logPrefix} Container "${containerName}" (id: ${info.Id?.slice(0, 12)}), creating exec...`);

    const exec = await container.exec({
      Cmd: ['sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});

    return new Promise((resolve) => {
      let output = '';

      stream.on('data', (chunk: Buffer) => {
        // Docker stream multiplexing: first 8 bytes are header
        // Skip header bytes and extract actual output
        const data = chunk.toString('utf8');
        output += data;
      });

      stream.on('end', () => {
        // Clean up docker stream headers and control characters
        // Docker streams can contain control characters like \x1D (Group Separator) in stream framing
        // Remove all control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        const cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
        if (cleanOutput) {
          console.log(`${logPrefix} Command output: ${cleanOutput}`);
        }
        console.log(`${logPrefix} Command finished successfully`);
        resolve({ success: true, output: cleanOutput });
      });

      stream.on('error', (err: Error) => {
        console.error(`${logPrefix} Stream error:`, err.message);
        resolve({ success: false, error: err.message });
      });

      setTimeout(() => {
        // Clean up docker stream headers and control characters
        // Docker streams can contain control characters like \x1D (Group Separator) in stream framing
        // Remove all control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        const cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
        if (cleanOutput) {
          console.log(`${logPrefix} Command output (timeout): ${cleanOutput}`);
        }
        console.log(`${logPrefix} Command finished (timeout fallback)`);
        resolve({ success: true, output: cleanOutput });
      }, 5000);
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${logPrefix} Exception:`, errMsg, error);
    return { success: false, error: errMsg };
  }
}

/**
 * List directory contents inside the game server container.
 * Used in local dev when the manager has no access to the shared volume.
 */
export async function readContainerDir(containerPath: string): Promise<string[]> {
  const normalizedPath = containerPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const result = await execInGameServerContainer(`ls -1 ${escapeShellArg(normalizedPath)}`);
  if (!result.success || result.output === undefined) {
    return [];
  }
  const lines = result.output.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  return lines;
}

/**
 * Copy a local file into the game server container at the given container path.
 * Used in local dev when the manager has no access to the shared volume.
 */
export async function copyFileToContainer(localFilePath: string, containerPath: string): Promise<void> {
  const container = await getContainer();
  if (!container) {
    throw new Error(`Container not found: ${config.gameContainerName}`);
  }
  const info = await container.inspect();
  if (!info.State.Running) {
    throw new Error(`Container is not running: ${config.gameContainerName}`);
  }
  const content = await fs.promises.readFile(localFilePath);
  const entryName = containerPath.replace(/\\/g, '/').replace(/^\//, '');
  if (!entryName) {
    throw new Error('Invalid container path');
  }
  const pack = tarStream.pack();
  pack.entry({ name: entryName, size: content.length, type: 'file' }, content);
  pack.finalize();
  await new Promise<void>((resolve, reject) => {
    container.putArchive(pack, { path: '/' }, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function getDockerInstance(): Docker {
  return docker;
}

export function getContainerName(): string {
  return config.gameContainerName;
}
