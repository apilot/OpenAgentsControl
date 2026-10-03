import { spawn, ChildProcess } from 'child_process';

export interface ServerConfig {
  port?: number;
  hostname?: string;
  printLogs?: boolean;
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  timeout?: number; // ms to wait for server to start
  cwd?: string; // Working directory for the server (important for agent detection)
  debug?: boolean; // Enable debug output
  agent?: string; // Agent to use (e.g., 'openagent', 'opencoder')
}

export class ServerManager {
  private process: ChildProcess | null = null;
  private port: number;
  private hostname: string;
  private isRunning: boolean = false;
  /** Server password captured from startup output (v2 servers require Basic auth, user "opencode") */
  private serverPassword: string | null = null;

  constructor(private config: ServerConfig = {}) {
    this.port = config.port || 0; // 0 = random port
    this.hostname = config.hostname || '127.0.0.1';
  }

  /** Password for authenticating against the started server (Basic auth, user "opencode"). */
  getPassword(): string | null {
    return this.serverPassword;
  }

  /**
   * Start the opencode server
   */
  async start(): Promise<{ url: string; port: number }> {
    if (this.isRunning) {
      throw new Error('Server is already running');
    }

    return this.startManual();
  }

  /**
   * Start server manually using spawn
   */
  private async startManual(): Promise<{ url: string; port: number }> {
    return new Promise((resolve, reject) => {
      const args = ['serve'];

      if (this.port !== 0) {
        args.push('--port', this.port.toString());
      }
      if (this.hostname) {
        args.push('--hostname', this.hostname);
      }
      if (this.config.printLogs) {
        args.push('--print-logs');
      }
      if (this.config.logLevel) {
        args.push('--log-level', this.config.logLevel);
      }

      // Spawn opencode serve
      // IMPORTANT: Set cwd to ensure agent is detected from the correct directory
      this.process = spawn('opencode', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.config.cwd || process.cwd(), // Use provided cwd or current directory
      });

      let stderr = '';
      let stdout = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          // Mark resolved BEFORE stopping: stop() triggers an 'exit' event,
          // and without this flag the exit handler would issue a second
          // reject() (unhandled rejection, exit code 130).
          resolved = true;
          this.stop();
          reject(new Error(`Server failed to start within ${this.config.timeout || 5000}ms`));
        }
      }, this.config.timeout || 5000);

      const capturePassword = (text: string): void => {
        if (this.serverPassword) return;
        const pwMatch = text.match(/server password (\S+)/);
        if (pwMatch) {
          this.serverPassword = pwMatch[1];
        }
      };

      /**
       * Resolves start() exactly once. v2 servers print "server password"
       * AFTER the "server listening" line, so the caller waits for the
       * password to arrive before finishing startup.
       */
      const finishStart = (url: string): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        const portMatch = url.match(/:(\d+)$/);
        this.port = portMatch ? parseInt(portMatch[1]) : this.port;
        this.isRunning = true;

        resolve({ url, port: this.port });
      };

      /** Waits briefly for the password line, then finishes startup either way. */
      const finishWhenReady = (url: string): void => {
        if (resolved) return;
        if (this.serverPassword) {
          finishStart(url);
          return;
        }
        const deadline = Date.now() + 3000;
        const poll = setInterval(() => {
          if (resolved) {
            clearInterval(poll);
            return;
          }
          if (this.serverPassword || Date.now() > deadline) {
            clearInterval(poll);
            finishStart(url);
          }
        }, 50);
      };

      // Listen for server startup message
      this.process.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        capturePassword(stdout);

        // Debug: Print server output
        if (this.config.debug) {
          console.log('[Server STDOUT]:', data.toString().trim());
        }

        // Look for "opencode server listening on http://..." (v1) or
        // "server listening on http://..." (v2) — pattern covers both.
        const match = stdout.match(/server listening on (http:\/\/[^\s]+)/);
        if (match) {
          finishWhenReady(match[1]);
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        capturePassword(stderr);
        
        // Debug: Print server errors
        if (this.config.debug) {
          console.log('[Server STDERR]:', data.toString().trim());
        }
        
        // Also check stderr for the startup message (v1/v2 patterns)
        const match = stderr.match(/server listening on (http:\/\/[^\s]+)/);
        if (match) {
          finishWhenReady(match[1]);
        }
      });

      this.process.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start server: ${error.message}`));
        }
      });

      this.process.on('exit', (code) => {
        this.isRunning = false;
        if (!resolved && code !== 0) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}\nstderr: ${stderr}`));
        }
      });
    });
  }

  /**
   * Stop the opencode server
   */
  async stop(): Promise<void> {
    // Stop manual process
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      this.process.on('exit', () => {
        this.isRunning = false;
        this.process = null;
        resolve();
      });

      // Try graceful shutdown first
      this.process.kill('SIGTERM');

      // Force kill after 3 seconds
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    });
  }

  /**
   * Get the server URL
   */
  getUrl(): string | null {
    if (!this.isRunning) {
      return null;
    }
    return `http://${this.hostname}:${this.port}`;
  }

  /**
   * Check if server is running
   */
  running(): boolean {
    return this.isRunning;
  }

  /**
   * Get the server port
   */
  getPort(): number | null {
    return this.isRunning ? this.port : null;
  }
}
