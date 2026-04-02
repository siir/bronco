import { createConnection } from 'net';

/**
 * Send one or more Redis commands over a raw TCP socket using RESP protocol.
 * Returns the raw RESP response string.
 *
 * Used by system-status and system-issues routes to avoid taking ioredis
 * as a direct dependency while still being able to query Redis.
 */
export function sendRedisCommand(host: string, port: number, commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      // Send all commands in RESP protocol
      const payload = commands.map(cmd => {
        const parts = cmd.split(' ');
        const header = `*${parts.length}\r\n`;
        const body = parts.map(p => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('');
        return header + body;
      }).join('');
      socket.write(payload);
    });

    let data = '';
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Redis check timed out'));
    }, 5000);

    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      // Reset settle timer — resolve once Redis stops sending data
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(data);
      }, 100);
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      reject(err);
    });
  });
}
