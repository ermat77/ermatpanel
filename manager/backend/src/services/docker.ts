import Docker from 'dockerode';
import { config } from '../config.js';
import type { ServerStatus, ServerStats, ActionResponse } from '../types/index.js';
import { validateCommand, escapeShellArg } from '../utils/sanitize.js';
import { clearOnlinePlayers } from './players.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return { success: false, error: 'Container not running' };
    }

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
        resolve({ success: true, output: cleanOutput });
      });

      stream.on('error', (err: Error) => {
        resolve({ success: false, error: err.message });
      });

      setTimeout(() => {
        // Clean up docker stream headers and control characters
        // Docker streams can contain control characters like \x1D (Group Separator) in stream framing
        // Remove all control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        const cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
        resolve({ success: true, output: cleanOutput });
      }, 5000);
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export function getDockerInstance(): Docker {
  return docker;
}

/**
 * Read directory contents from Docker container
 */
export async function readContainerDir(containerPath: string): Promise<string[]> {
  try {
    const container = await getContainer();
    if (!container) {
      throw new Error('Container not found');
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      throw new Error('Container not running');
    }

    // Execute ls command to list directory contents
    const exec = await container.exec({
      Cmd: ['sh', '-c', `ls -1 "${containerPath}" 2>/dev/null || echo ""`],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});
    let output = '';

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf8');
        output += data;
      });

      stream.on('end', () => {
        // Clean up docker stream headers and control characters
        // Docker streams can contain control characters like \x1D (Group Separator) in stream framing
        // Remove all control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        const cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
        const files = cleanOutput ? cleanOutput.split('\n').filter(f => f.length > 0) : [];
        resolve(files);
      });

      stream.on('error', (err: Error) => {
        reject(err);
      });

      setTimeout(() => {
        // Clean up docker stream headers and control characters
        // Docker streams can contain control characters like \x1D (Group Separator) in stream framing
        // Remove all control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        const cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
        const files = cleanOutput ? cleanOutput.split('\n').filter(f => f.length > 0) : [];
        resolve(files);
      }, 2000);
    });
  } catch (error) {
    console.error(`[Docker] ❌ Failed to read directory ${containerPath}:`, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Read file content from Docker container
 */
/**
 * Demultiplex Docker stream data
 * Docker uses 8-byte headers for multiplexed streams:
 * - Byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
 * - Bytes 1-3: reserved (0)
 * - Bytes 4-7: size of payload (big-endian uint32)
 */
function demuxDockerStream(chunk: Buffer): string {
  let result = '';
  let offset = 0;

  while (offset < chunk.length) {
    // Check if we have enough bytes for header
    if (offset + 8 > chunk.length) {
      // Not enough data for header, treat as raw data (shouldn't happen, but safe fallback)
      break;
    }

    // Read header
    const streamType = chunk.readUInt8(offset);
    const size = chunk.readUInt32BE(offset + 4);

    // Validate header - stream type should be 0, 1, or 2
    if (streamType > 2 || size > chunk.length - offset - 8) {
      // Invalid header, treat remaining as raw string data
      const rawData = chunk.slice(offset).toString('utf-8');
      result += rawData;
      break;
    }

    // Only extract stdout (streamType === 1) payload
    if (streamType === 1) {
      const payload = chunk.slice(offset + 8, offset + 8 + size).toString('utf-8');
      result += payload;
    }

    offset += 8 + size;
  }

  return result;
}

export async function readContainerFile(containerPath: string): Promise<string> {
  try {
    const container = await getContainer();
    if (!container) {
      throw new Error('Container not found');
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      throw new Error('Container not running');
    }

    // Use cat to read file content
    const exec = await container.exec({
      Cmd: ['sh', '-c', `cat "${containerPath}" 2>/dev/null || echo ""`],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});
    let output = '';

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        // Properly demux Docker stream to extract actual data
        try {
          const demuxed = demuxDockerStream(chunk);
          output += demuxed;
        } catch {
          // Fallback: if demuxing fails, try direct conversion (may have issues)
          const data = chunk.toString('utf8');
          output += data;
        }
      });

      stream.on('end', () => {
        // Remove control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        let cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
        
        // Remove BOM (Byte Order Mark) - U+FEFF, only at the start
        if (cleanOutput.length > 0 && cleanOutput.charCodeAt(0) === 0xFEFF) {
          cleanOutput = cleanOutput.substring(1);
        }
        
        // Remove other problematic Unicode characters (zero-width characters, invisible formatting)
        cleanOutput = cleanOutput.replace(/[\u200B-\u200D\u00AD]/g, '');
        
        resolve(cleanOutput);
      });

      stream.on('error', (err: Error) => {
        reject(err);
      });

      setTimeout(() => {
        // Remove control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        let cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
        
        // Remove BOM (Byte Order Mark) - U+FEFF, only at the start
        if (cleanOutput.length > 0 && cleanOutput.charCodeAt(0) === 0xFEFF) {
          cleanOutput = cleanOutput.substring(1);
        }
        
        // Remove other problematic Unicode characters (zero-width characters, invisible formatting)
        cleanOutput = cleanOutput.replace(/[\u200B-\u200D\u00AD]/g, '');
        
        resolve(cleanOutput);
      }, 5000);
    });
  } catch (error) {
    throw error;
  }
}

/**
 * Write file content to Docker container
 */
export async function writeContainerFile(containerPath: string, content: string): Promise<void> {
  try {
    const container = await getContainer();
    if (!container) {
      throw new Error('Container not found');
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      throw new Error('Container not running');
    }

    // Escape content for shell and write using echo/printf
    const escapedContent = content.replace(/'/g, "'\\''");
    
    // Use printf to write file (more reliable than echo for binary/special chars)
    const exec = await container.exec({
      Cmd: ['sh', '-c', `printf '%s' '${escapedContent}' > "${containerPath}"`],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});
    let errorOutput = '';

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf8');
        errorOutput += data;
      });

      stream.on('end', () => {
        if (errorOutput.trim()) {
          console.warn(`[Docker] ⚠️  Write file stderr: ${errorOutput}`);
        }
        resolve();
      });

      stream.on('error', (err: Error) => {
        reject(err);
      });

      setTimeout(() => {
        if (errorOutput.trim()) {
          console.warn(`[Docker] ⚠️  Write file stderr: ${errorOutput}`);
        }
        resolve();
      }, 3000);
    });
  } catch (error) {
    console.error(`[Docker] ❌ Failed to write file ${containerPath}:`, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Copy a file from local filesystem to Docker container
 * Uses base64 encoding to transfer binary files via exec
 */
export async function copyFileToContainer(localFilePath: string, containerPath: string): Promise<void> {
  console.log(`[Docker] 📤 copyFileToContainer called`);
  console.log(`[Docker]   Local file: ${localFilePath}`);
  console.log(`[Docker]   Container path: ${containerPath}`);
  
  try {
    // Verify local file exists
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`Local file does not exist: ${localFilePath}`);
    }
    const localStats = fs.statSync(localFilePath);
    console.log(`[Docker]   Local file size: ${localStats.size} bytes`);

    const container = await getContainer();
    if (!container) {
      throw new Error('Container not found');
    }
    console.log(`[Docker] ✅ Container found: ${config.gameContainerName}`);

    const info = await container.inspect();
    if (!info.State.Running) {
      throw new Error('Container not running');
    }
    console.log(`[Docker] ✅ Container is running`);

    // Read the file as a buffer and encode to base64
    console.log(`[Docker] 📖 Reading file and encoding to base64...`);
    const fileBuffer = fs.readFileSync(localFilePath);
    const base64Content = fileBuffer.toString('base64');
    console.log(`[Docker]   Base64 length: ${base64Content.length} characters`);

    // Normalize path to use forward slashes (Linux container paths)
    // path.join() on Windows creates backslashes, but containers need forward slashes
    const normalizedPath = containerPath.replace(/\\/g, '/');
    const containerDir = path.posix.dirname(normalizedPath);
    const fileName = path.posix.basename(normalizedPath);
    console.log(`[Docker]   Normalized container path: ${normalizedPath}`);
    console.log(`[Docker]   Container directory: ${containerDir}`);
    console.log(`[Docker]   File name: ${fileName}`);

    // Ensure directory exists in container
    console.log(`[Docker] 📁 Ensuring directory exists in container...`);
    const mkdirExec = await container.exec({
      Cmd: ['sh', '-c', `mkdir -p "${containerDir}"`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const mkdirStream = await mkdirExec.start({});
    let mkdirOutput = '';
    mkdirStream.on('data', (chunk: Buffer) => {
      mkdirOutput += chunk.toString('utf8');
    });
    await new Promise<void>((resolve) => {
      mkdirStream.on('end', resolve);
      setTimeout(() => resolve(), 2000);
    });
    if (mkdirOutput) {
      console.log(`[Docker]   mkdir output: ${mkdirOutput}`);
    }
    console.log(`[Docker] ✅ Directory ensured`);

    // Write file using base64 decode
    const tempFile = `/tmp/upload_${Date.now()}_${Math.random().toString(36).substring(7)}.b64`;
    const uniqueDelimiter = `EOF_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    console.log(`[Docker] 📝 Writing base64 to temp file: ${tempFile}`);
    
    // Write base64 content to temp file in container using heredoc with unique delimiter
    // Use a unique delimiter to avoid conflicts with base64 content
    // Construct the heredoc command with actual newlines (not \n escape sequences)
    const heredocCommand = `cat > "${tempFile}" << '${uniqueDelimiter}'
${base64Content}
${uniqueDelimiter}`;
    const writeExec = await container.exec({
      Cmd: ['sh', '-c', heredocCommand],
      AttachStdout: true,
      AttachStderr: true,
    });

    const writeStream = await writeExec.start({});
    let writeOutput = '';
    let writeError = '';
    
    await new Promise<void>((resolve, reject) => {
      writeStream.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf8');
        writeOutput += data;
        if (data.toLowerCase().includes('error')) {
          writeError += data;
        }
      });
      writeStream.on('end', resolve);
      writeStream.on('error', reject);
      setTimeout(() => resolve(), 10000);
    });

    if (writeOutput) {
      console.log(`[Docker]   Write output: ${writeOutput.substring(0, 200)}`);
    }
    if (writeError) {
      console.warn(`[Docker] ⚠️  Write stderr: ${writeError}`);
    }
    console.log(`[Docker] ✅ Base64 written to temp file`);

    // Verify temp file was created
    console.log(`[Docker] 🔍 Verifying temp file exists...`);
    const verifyTempExec = await container.exec({
      Cmd: ['sh', '-c', `test -f "${tempFile}" && echo "EXISTS" || echo "NOT_FOUND"`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const verifyTempStream = await verifyTempExec.start({});
    let verifyTempOutput = '';
    verifyTempStream.on('data', (chunk: Buffer) => {
      verifyTempOutput += chunk.toString('utf8');
    });
    await new Promise<void>((resolve) => {
      verifyTempStream.on('end', resolve);
      setTimeout(() => resolve(), 2000);
    });
    console.log(`[Docker]   Temp file check: ${verifyTempOutput.trim()}`);

    // Decode base64 and write to final location
    console.log(`[Docker] 🔓 Decoding base64 and writing to final location...`);
    const decodeExec = await container.exec({
      Cmd: ['sh', '-c', `base64 -d "${tempFile}" > "${normalizedPath}" && rm -f "${tempFile}" && echo "SUCCESS"`],
      AttachStdout: true,
      AttachStderr: true,
    });

    const decodeStream = await decodeExec.start({});
    let decodeOutput = '';
    let decodeError = '';

    await new Promise<void>((resolve, reject) => {
      decodeStream.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf8');
        decodeOutput += data;
        if (data.toLowerCase().includes('error') && !data.includes('base64: invalid input')) {
          decodeError += data;
        }
      });
      decodeStream.on('end', resolve);
      decodeStream.on('error', reject);
      setTimeout(() => resolve(), 15000);
    });

    if (decodeOutput) {
      console.log(`[Docker]   Decode output: ${decodeOutput.trim()}`);
    }
    if (decodeError) {
      console.warn(`[Docker] ⚠️  Decode stderr: ${decodeError}`);
    }

    // Verify final file exists
    console.log(`[Docker] 🔍 Verifying final file exists...`);
    const verifyFinalExec = await container.exec({
      Cmd: ['sh', '-c', `test -f "${normalizedPath}" && stat -c "%s" "${normalizedPath}" || echo "NOT_FOUND"`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const verifyFinalStream = await verifyFinalExec.start({});
    let verifyFinalOutput = '';
    verifyFinalStream.on('data', (chunk: Buffer) => {
      verifyFinalOutput += chunk.toString('utf8');
    });
    await new Promise<void>((resolve) => {
      verifyFinalStream.on('end', resolve);
      setTimeout(() => resolve(), 2000);
    });
    const finalFileSize = verifyFinalOutput.trim();
    if (finalFileSize && finalFileSize !== 'NOT_FOUND') {
      console.log(`[Docker] ✅ File verified in container: ${normalizedPath} (${finalFileSize} bytes)`);
      if (parseInt(finalFileSize) !== localStats.size) {
        console.warn(`[Docker] ⚠️  File size mismatch! Local: ${localStats.size}, Container: ${finalFileSize}`);
      }
    } else {
      console.error(`[Docker] ❌ File NOT found in container after copy: ${normalizedPath}`);
    }

    console.log(`[Docker] ✅ Copy operation completed`);
  } catch (error) {
    console.error(`[Docker] ❌ Failed to copy file to container ${containerPath}:`, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Get file stats from Docker container
 */
export async function getContainerFileStats(containerPath: string): Promise<{ size: number; modified: Date } | null> {
  try {
    const container = await getContainer();
    if (!container) {
      throw new Error('Container not found');
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      throw new Error('Container not running');
    }

    // Execute stat command to get file info
    const exec = await container.exec({
      Cmd: ['sh', '-c', `stat -c "%s %Y" "${containerPath}" 2>/dev/null || echo ""`],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});
    let output = '';

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf8');
        output += data;
      });

      stream.on('end', () => {
        // Clean up docker stream headers and control characters
        // Docker streams can contain control characters like \x1D (Group Separator) in stream framing
        // Remove all control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        const cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
        if (!cleanOutput) {
          resolve(null);
          return;
        }

        // Parse output: "size timestamp"
        const parts = cleanOutput.split(' ');
        if (parts.length >= 2) {
          const size = parseInt(parts[0], 10);
          const timestamp = parseInt(parts[1], 10);
          resolve({
            size: isNaN(size) ? 0 : size,
            modified: new Date(timestamp * 1000), // Convert Unix timestamp to Date
          });
        } else {
          resolve(null);
        }
      });

      stream.on('error', (err: Error) => {
        reject(err);
      });

      setTimeout(() => {
        // Clean up docker stream headers and control characters
        // Docker streams can contain control characters like \x1D (Group Separator) in stream framing
        // Remove all control characters (0x00-0x1F) except newline (0x0A), carriage return (0x0D), and tab (0x09)
        const cleanOutput = output.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '').trim();
        if (!cleanOutput) {
          resolve(null);
          return;
        }

        const parts = cleanOutput.split(' ');
        if (parts.length >= 2) {
          const size = parseInt(parts[0], 10);
          const timestamp = parseInt(parts[1], 10);
          resolve({
            size: isNaN(size) ? 0 : size,
            modified: new Date(timestamp * 1000),
          });
        } else {
          resolve(null);
        }
      }, 2000);
    });
  } catch (error) {
    console.error(`[Docker] ❌ Failed to get file stats for ${containerPath}:`, error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

export function getContainerName(): string {
  return config.gameContainerName;
}
