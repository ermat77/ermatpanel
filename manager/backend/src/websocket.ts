import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { verifyToken, verifyWsTicket } from './services/auth.js';
import { getDockerInstance, getContainerName, execCommand, getLogs } from './services/docker.js';
import { parseLogLine } from './services/logs.js';
import { processLogLine } from './services/players.js';
import { hasPermission } from './services/roles.js';
import type { WsMessage } from './types/index.js';
import { isDemoMode, getNextDemoLogLine, getDemoOnlinePlayers } from './services/demoData.js';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config.js';

const clients = new Set<WebSocket>();
// Map to store username for each WebSocket connection (for permission checks)
const clientUsernames = new Map<WebSocket, string>();
let logStream: NodeJS.ReadableStream | null = null;
let streamRestartTimeout: NodeJS.Timeout | null = null;
let demoLogInterval: NodeJS.Timeout | null = null;

/**
 * Check if we're running in local development (not in Docker)
 */
function isLocalDevelopment(): boolean {
  return !process.env.GAME_CONTAINER_NAME && !process.env.STACK_NAME;
}

async function sendExistingLogs(ws: WebSocket): Promise<void> {
  try {
    const logs = await getLogs(200);
    const lines = logs.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = parseLogLine(trimmed);
      if (parsed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'log',
          ...parsed,
        }));
      }
    }
  } catch (error) {
    console.error('Failed to send existing logs:', error);
  }
}

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    // Extract ticket from query string (preferred) or fall back to token (deprecated)
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const ticket = url.searchParams.get('ticket');
    const token = url.searchParams.get('token');

    let username: string;

    if (ticket) {
      // Preferred: Use single-use ticket (more secure)
      const ticketResult = verifyWsTicket(ticket);
      if (!ticketResult.valid || !ticketResult.username) {
        ws.close(4001, 'Invalid or expired ticket');
        return;
      }
      username = ticketResult.username;
    } else if (token) {
      // Deprecated: Fall back to JWT token for backwards compatibility
      // Log deprecation warning
      console.warn('WebSocket: Client using deprecated token auth. Should use /api/auth/ws-ticket instead.');
      const tokenResult = verifyToken(token, 'access');
      if (!tokenResult) {
        ws.close(4001, 'Invalid token');
        return;
      }
      username = tokenResult.username;
    } else {
      ws.close(4001, 'Authentication required (ticket or token)');
      return;
    }

    // Check if user has permission to view console logs
    const canViewLogs = await hasPermission(username, 'console.view');
    if (!canViewLogs) {
      ws.close(4003, 'Permission denied: console.view required');
      return;
    }

    console.log(`WebSocket client connected: ${username}`);
    clients.add(ws);
    clientUsernames.set(ws, username);

    // Send existing logs to new client (user already verified to have console.view)
    await sendExistingLogs(ws);

    // Start streaming if first client
    if (clients.size === 1) {
      startLogStreaming();
    }

    // Handle messages from client
    ws.on('message', async (data: Buffer) => {
      try {
        const message: WsMessage = JSON.parse(data.toString());

        switch (message.type) {
          case 'command':
            if (message.payload) {
              // Check if user has permission to execute commands
              const wsUsername = clientUsernames.get(ws);
              if (!wsUsername || !(await hasPermission(wsUsername, 'console.execute'))) {
                ws.send(JSON.stringify({
                  type: 'command_response',
                  command: message.payload,
                  success: false,
                  error: 'Permission denied: console.execute required',
                }));
                break;
              }

              const result = await execCommand(message.payload);
              ws.send(JSON.stringify({
                type: 'command_response',
                command: message.payload,
                success: result.success,
                output: result.message,
                error: result.error,
              }));
            }
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      clientUsernames.delete(ws);
      console.log('WebSocket client disconnected');

      // Stop streaming if no clients
      if (clients.size === 0) {
        stopLogStreaming();
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
      clientUsernames.delete(ws);
    });
  });
}

function broadcast(message: object): void {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Demultiplex Docker stream data
 * Docker uses 8-byte headers for multiplexed streams:
 * - Byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
 * - Bytes 1-3: reserved (0)
 * - Bytes 4-7: size of payload (big-endian uint32)
 */
function demuxDockerStream(chunk: Buffer): string[] {
  const results: string[] = [];
  let offset = 0;

  while (offset < chunk.length) {
    // Check if we have enough bytes for header
    if (offset + 8 > chunk.length) {
      // Not enough data for header, treat as raw data
      const remaining = chunk.slice(offset).toString('utf-8');
      if (remaining.trim()) {
        results.push(remaining);
      }
      break;
    }

    // Read header
    const streamType = chunk.readUInt8(offset);
    const size = chunk.readUInt32BE(offset + 4);

    // Validate header - stream type should be 0, 1, or 2
    if (streamType > 2 || size > chunk.length - offset - 8) {
      // Invalid header, treat as raw string data
      const rawData = chunk.slice(offset).toString('utf-8');
      results.push(...rawData.split('\n'));
      break;
    }

    // Extract payload
    const payload = chunk.slice(offset + 8, offset + 8 + size).toString('utf-8');
    results.push(...payload.split('\n'));

    offset += 8 + size;
  }

  return results;
}

// Demo mode: simulate log streaming with periodic log messages
function startDemoLogStreaming(): void {
  if (demoLogInterval) {
    clearInterval(demoLogInterval);
  }

  console.log('[DEMO] Demo log streaming started');

  // Send a log message every 3-8 seconds
  demoLogInterval = setInterval(() => {
    if (clients.size === 0) {
      stopDemoLogStreaming();
      return;
    }

    const logLine = getNextDemoLogLine();
    const parsed = parseLogLine(logLine);

    if (parsed) {
      broadcast({
        type: 'log',
        ...parsed,
      });

      // Check for player events in demo logs
      const playerEvent = processLogLine(logLine);
      if (playerEvent) {
        broadcast({
          type: 'player_event',
          event: playerEvent.event,
          player: playerEvent.player,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }, 3000 + Math.random() * 5000); // Random interval 3-8 seconds
}

function stopDemoLogStreaming(): void {
  if (demoLogInterval) {
    clearInterval(demoLogInterval);
    demoLogInterval = null;
    console.log('[DEMO] Demo log streaming stopped');
  }
}

/**
 * Start file-based log streaming for local development
 */
function startLocalLogStreaming(): void {
  // Clear any pending restart timeout
  if (streamRestartTimeout) {
    clearTimeout(streamRestartTimeout);
    streamRestartTimeout = null;
  }

  // Clean up existing stream
  if (logStream) {
    logStream.removeAllListeners();
    logStream = null;
  }

  // Try to find log file in server directory
  // In local dev, the directory is typically 'hytale-server' not 'server'
  const baseServerPath = config.serverPath.includes('hytale-server') 
    ? config.serverPath 
    : path.resolve(config.serverPath, '..', 'hytale-server');
  
  const logPaths = [
    path.join(baseServerPath, 'logs', 'latest.log'),
    path.join(baseServerPath, 'logs', 'server.log'),
    path.join(baseServerPath, 'server.log'),
    path.join(config.dataPath, 'logs', 'latest.log'),
    // Fallback to original serverPath if hytale-server doesn't exist
    path.join(config.serverPath, 'logs', 'latest.log'),
    path.join(config.serverPath, 'logs', 'server.log'),
    path.join(config.serverPath, 'server.log'),
  ];

  let logFile: string | null = null;
  for (const logPath of logPaths) {
    if (fs.existsSync(logPath)) {
      logFile = logPath;
      break;
    }
  }

  if (!logFile) {
    console.warn('[Local Dev] No log file found. Tried:', logPaths);
    console.warn('[Local Dev] Log streaming disabled. Server logs may not appear in real-time.');
    return;
  }

  console.log(`[Local Dev] Watching log file: ${logFile}`);

  try {
    // Use fs.watchFile for cross-platform file watching
    let lastSize = fs.statSync(logFile).size;
    let lastPosition = lastSize;

    const watchInterval = setInterval(() => {
      if (clients.size === 0) {
        clearInterval(watchInterval);
        return;
      }

      try {
        const stats = fs.statSync(logFile!);
        if (stats.size > lastPosition) {
          // Read new content
          const fd = fs.openSync(logFile!, 'r');
          const buffer = Buffer.alloc(stats.size - lastPosition);
          fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
          fs.closeSync(fd);

          lastPosition = stats.size;

          const lines = buffer.toString('utf-8').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const parsed = parseLogLine(trimmed);
            if (parsed) {
              broadcast({
                type: 'log',
                ...parsed,
              });

              // Check for player events
              const playerEvent = processLogLine(trimmed);
              if (playerEvent) {
                broadcast({
                  type: 'player_event',
                  ...playerEvent,
                  timestamp: new Date().toISOString(),
                });
              }
            }
          }
        }
      } catch (error) {
        console.error('[Local Dev] Error reading log file:', error);
        clearInterval(watchInterval);
        scheduleStreamRestart();
      }
    }, 500); // Check every 500ms

    logStream = {
      removeAllListeners: () => clearInterval(watchInterval),
    } as NodeJS.ReadableStream;

    console.log('[Local Dev] Log streaming started');
  } catch (error) {
    console.error('[Local Dev] Failed to start log streaming:', error);
    scheduleStreamRestart();
  }
}

async function startLogStreaming(): Promise<void> {
  // Demo mode: use simulated log streaming
  if (isDemoMode()) {
    startDemoLogStreaming();
    return;
  }

  // Local development: use file-based log streaming
  if (isLocalDevelopment()) {
    startLocalLogStreaming();
    return;
  }

  // Docker mode: use container logs
  // Clear any pending restart timeout
  if (streamRestartTimeout) {
    clearTimeout(streamRestartTimeout);
    streamRestartTimeout = null;
  }

  // Clean up existing stream
  if (logStream) {
    logStream.removeAllListeners();
    logStream = null;
  }

  try {
    const docker = getDockerInstance();
    const container = docker.getContainer(getContainerName());

    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0,
      timestamps: true,
    });

    logStream = stream;
    console.log('Log streaming started (Docker)');

    stream.on('data', (chunk: Buffer) => {
      // Try to demux the Docker stream
      let lines: string[];
      try {
        lines = demuxDockerStream(chunk);
      } catch {
        // Fallback to simple string split
        lines = chunk.toString('utf-8').split('\n');
      }

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseLogLine(trimmed);
        if (parsed) {
          broadcast({
            type: 'log',
            ...parsed,
          });

          // Check for player events
          const playerEvent = processLogLine(trimmed);
          if (playerEvent) {
            broadcast({
              type: 'player_event',
              ...playerEvent,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    });

    stream.on('error', (error: Error) => {
      console.error('Log stream error:', error);
      broadcast({
        type: 'error',
        message: error.message,
      });
      // Schedule restart if clients are still connected
      scheduleStreamRestart();
    });

    stream.on('end', () => {
      console.log('Log stream ended');
      // Schedule restart if clients are still connected
      scheduleStreamRestart();
    });

    stream.on('close', () => {
      console.log('Log stream closed');
      // Schedule restart if clients are still connected
      scheduleStreamRestart();
    });

  } catch (error) {
    console.error('Failed to start log streaming:', error);
    broadcast({
      type: 'error',
      message: 'Failed to connect to container logs',
    });
    // Schedule restart if clients are still connected
    scheduleStreamRestart();
  }
}

function scheduleStreamRestart(): void {
  // Only restart if we have connected clients and no pending restart
  if (clients.size > 0 && !streamRestartTimeout) {
    console.log('Scheduling log stream restart in 3 seconds...');
    streamRestartTimeout = setTimeout(() => {
      streamRestartTimeout = null;
      if (clients.size > 0) {
        console.log('Restarting log stream...');
        startLogStreaming();
      }
    }, 3000);
  }
}

function stopLogStreaming(): void {
  // Stop demo streaming if active
  stopDemoLogStreaming();

  if (streamRestartTimeout) {
    clearTimeout(streamRestartTimeout);
    streamRestartTimeout = null;
  }
  if (logStream) {
    logStream.removeAllListeners();
    logStream = null;
  }
}
