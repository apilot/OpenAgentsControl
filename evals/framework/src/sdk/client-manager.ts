import { OpenCode, type OpenCodeClient } from '@opencode/client';

/**
 * Loose structural aliases for message/part data flowing through the framework.
 * OpenCode v2 models messages as a discriminated union (SessionMessageInfo)
 * with `type` instead of v1's `role`, and embeds parts in `content`.
 * We normalize to `role` + `parts` so downstream consumers keep working.
 */
export type Message = { id: string; role?: string; [key: string]: unknown };
export type Part = { id?: string; type?: string; [key: string]: unknown };

/** v2 session object (native passthrough) */
export type Session = {
  id: string;
  title?: string;
  [key: string]: unknown;
};

export interface ClientConfig {
  baseUrl: string;
  timeout?: number;
  /**
   * OpenCode v2 server password. v2 servers require HTTP Basic auth with
   * user "opencode" and the password printed at server startup
   * (see ServerManager.getPassword()).
   */
  password?: string;
}

/**
 * Configuration for creating a new session
 */
export interface SessionConfig {
  /** Session title */
  title?: string;
  /** Agent to run the session with (v2: agent is selected at session level) */
  agent?: string;
  /** Model to use for this session (v2: model is selected at session level) */
  model?: {
    providerID: string;
    modelID: string;
  };
}

/**
 * Configuration for sending a prompt to a session
 */
export interface PromptConfig {
  /** The prompt text to send */
  text: string;
  /** Agent to use for this prompt (applied via session.switchAgent) */
  agent?: string;
  /** Model to use for this prompt (applied via session.switchModel) */
  model?: {
    providerID: string;
    modelID: string;
  };
  /** Working directory for the agent (v2 routes are location-scoped server-side) */
  directory?: string;
  /** Files to attach to the prompt */
  files?: string[];
  /** If true, only adds context without triggering AI response */
  noReply?: boolean;
}

/**
 * @deprecated Use PromptConfig instead
 */
export interface PromptOptions extends PromptConfig {}

export interface SessionInfo {
  id: string;
  title?: string;
  messages: Array<{
    info: Message;
    parts: Part[];
  }>;
}

/** Basic auth header value for OpenCode v2 servers (user "opencode"). */
export function basicAuthHeader(password: string): string {
  return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

export class ClientManager {
  private client: OpenCodeClient;
  private password?: string;

  constructor(config: ClientConfig) {
    this.password = config.password;
    // OpenCode v2: Basic auth header (user "opencode" + startup password).
    this.client = OpenCode.make({
      baseUrl: config.baseUrl,
      headers: config.password ? { authorization: basicAuthHeader(config.password) } : undefined,
    });
  }

  /**
   * Create a new session
   *
   * v2 note: agent/model selection happens at the session level
   * (SessionConfig.agent/model), not per prompt.
   *
   * @param config - Session configuration
   * @returns Created session
   */
  async createSession(config: SessionConfig = {}): Promise<Session> {
    try {
      const session = await this.client.session.create({
        title: config.title || `Eval Session ${new Date().toISOString()}`,
        agent: config.agent,
        model: config.model
          ? { id: config.model.modelID, providerID: config.model.providerID }
          : undefined,
      });

      if (!session) {
        throw new Error('Failed to create session: No data in response');
      }

      return session;
    } catch (error) {
      console.error('[ClientManager] Session creation error:', error);
      throw new Error(`Failed to create session: ${(error as Error).message}`);
    }
  }

  /**
   * Send a prompt to a session
   *
   * v2 note: the prompt endpoint no longer accepts agent/model. If provided,
   * they are applied to the session first via switchAgent/switchModel.
   *
   * @param sessionId - Session ID to send prompt to
   * @param config - Prompt configuration including agent, text, model, etc.
   * @returns Normalized message response with info and parts
   */
  async sendPrompt(sessionId: string, config: PromptConfig): Promise<{ info: Message; parts: Part[] }> {
    // Apply per-prompt overrides at session level (v2 contract)
    if (config.agent) {
      await this.client.session.switchAgent({ sessionID: sessionId, agent: config.agent });
    }
    if (config.model) {
      await this.client.session.switchModel({
        sessionID: sessionId,
        model: { id: config.model.modelID, providerID: config.model.providerID },
      });
    }

    const inboxEntry = await this.client.session.prompt({
      sessionID: sessionId,
      text: config.text,
    });

    if (!inboxEntry) {
      throw new Error('Failed to send prompt: No data in response');
    }

    return {
      info: { ...(inboxEntry as unknown as Message), role: 'user' },
      parts: [],
    };
  }

  /**
   * Get session details including all messages
   *
   * v2 note: messages come from session.context() as a discriminated union.
   * We normalize v2's `type` to v1's `role` and v2's `content` to `parts`
   * so existing consumers (role checks, part.type checks) keep working.
   */
  async getSession(sessionId: string): Promise<SessionInfo> {
    const [session, messages] = await Promise.all([
      this.client.session.get({ sessionID: sessionId }),
      this.client.session.context({ sessionID: sessionId }).catch(() => []),
    ]);

    if (!session) {
      throw new Error('Failed to get session');
    }

    return {
      id: session.id,
      title: session.title,
      messages: (messages as unknown as Array<Record<string, unknown>>).map((m) => ({
        info: { ...m, role: m.type } as Message,
        parts: ((m.content as Part[] | undefined) ?? []) as Part[],
      })),
    };
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<Session[]> {
    const response = await this.client.session.list();
    return response.data;
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    await this.client.session.remove({ sessionID: sessionId });
    return true;
  }

  /**
   * Abort a running session
   */
  async abortSession(sessionId: string): Promise<boolean> {
    await this.client.session.interrupt({ sessionID: sessionId });
    return true;
  }

  /**
   * Send a command to a session
   *
   * Not supported by the OpenCode v2 API (session.command was removed;
   * v2 exposes session.shell for non-model shell execution instead).
   */
  async sendCommand(_sessionId: string, _command: string): Promise<Message> {
    throw new Error('sendCommand is not supported by the OpenCode v2 API');
  }

  /**
   * Respond to a permission request
   */
  async respondToPermission(
    sessionId: string,
    permissionId: string,
    approved: boolean
  ): Promise<boolean> {
    await this.client.permission.reply({
      sessionID: sessionId,
      requestID: permissionId,
      decision: approved ? 'once' : 'reject',
    });
    return true;
  }

  /**
   * Get the underlying SDK client for advanced usage
   */
  getClient(): OpenCodeClient {
    return this.client;
  }
}
