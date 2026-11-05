import net from 'node:net';

export function resolvePort(preferred: number, maxAttempts = 100): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = preferred;
    const tryPort = () => {
      const server = net.createServer();
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          port++;
          if (port >= preferred + maxAttempts) {
            reject(new Error(`No available port found in range ${preferred}-${preferred + maxAttempts}`));
          } else {
            tryPort();
          }
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
    };
    tryPort();
  });
}

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}
