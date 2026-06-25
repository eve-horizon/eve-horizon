import type {
  GatewayProvider,
  GatewayTransport,
  GatewayCapability,
  ProviderConfig,
  OutboundTarget,
  MessageContent,
  NormalizedInbound,
} from '../gateway-provider.interface.js';
import type { GatewayChatService } from '../../chat/gateway-chat.service.js';
import type { EveTokenClaims } from '@eve-horizon/auth';
import { verifyEveToken } from '@eve-horizon/auth';
import { createJsonLogger } from '@eve/shared';
import { WebSocket, WebSocketServer } from 'ws';
import * as http from 'http';
import * as url from 'url';

const logger = createJsonLogger('gateway');

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

export type WebChatTokenVerification =
  | { ok: true; claims: { user_id: string; org_id: string } }
  | { ok: false; closeReason: 'token_invalid' | 'token_expired' | 'token_not_yet_valid' };

export async function verifyWebChatToken(
  token: string,
  eveApiUrl: string,
  expectedOrgId?: string,
): Promise<WebChatTokenVerification> {
  try {
    const claims: EveTokenClaims = await verifyEveToken(token, eveApiUrl);
    const orgId =
      claims.org_id ??
      (expectedOrgId && claims.orgs?.some((org: { id: string }) => org.id === expectedOrgId) ? expectedOrgId : undefined) ??
      (claims.orgs?.length === 1 ? claims.orgs[0]?.id : undefined);

    if (!claims.user_id || !orgId) {
      return { ok: false, closeReason: 'token_invalid' };
    }
    return {
      ok: true,
      claims: {
        user_id: claims.user_id,
        org_id: orgId,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/expired/i.test(message)) {
      return { ok: false, closeReason: 'token_expired' };
    }
    if (/not yet valid/i.test(message)) {
      return { ok: false, closeReason: 'token_not_yet_valid' };
    }
    return { ok: false, closeReason: 'token_invalid' };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebChatConnection {
  ws: WebSocket;
  userId: string;
  orgId: string;
  accountId: string;
  connectedAt: Date;
  lastPing: Date;
}

interface WebChatInboundMessage {
  type: 'message';
  text: string;
  agent_slug?: string;
  thread_id?: string;
}

// ---------------------------------------------------------------------------
// WebChat Gateway Provider
// ---------------------------------------------------------------------------

/**
 * WebChat Gateway Provider
 *
 * Implements the GatewayProvider interface for browser-native WebSocket chat.
 * Follows the Nostr provider's subscription transport pattern: maintains
 * persistent connections rather than receiving webhooks.
 *
 * Transport: WebSocket server on a configurable port (default 4820).
 * Auth:      JWT token in the WebSocket handshake query string (?token=...).
 * Threading: Client-provided thread_id, or connection ID as default thread.
 * Outbound:  Finds all active connections for a user and pushes JSON frames.
 * Heartbeat: 30-second ping/pong cycle with 60-second stale threshold.
 */
export class WebChatGatewayProvider implements GatewayProvider {
  readonly name = 'webchat';
  readonly transport: GatewayTransport = 'subscription';
  readonly capabilities: GatewayCapability[] = ['inbound', 'outbound', 'identity'];

  private chatService: GatewayChatService;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;

  /** Active connections indexed by connection ID. */
  private connections = new Map<string, WebChatConnection>();

  /** Reverse index: "accountId:userId" -> Set of connection IDs. */
  private userConnections = new Map<string, Set<string>>();

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private accountId = '';
  private orgId = '';
  private eveApiUrl = '';
  private connectionCounter = 0;

  constructor(chatService: GatewayChatService) {
    this.chatService = chatService;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(config: ProviderConfig): Promise<void> {
    this.accountId = config.integration.account_id;
    this.orgId = config.integration.org_id;

    const port = (config.settings['port'] as number) ?? 4820;
    this.eveApiUrl =
      (config.settings['eve_api_url'] as string | undefined) ??
      process.env.EVE_API_URL ??
      '';
    if (!this.eveApiUrl) {
      throw new Error('WebChat provider requires eve_api_url setting or EVE_API_URL env');
    }

    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', provider: 'webchat' }));
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      this.handleConnection(ws, req).catch((err) => {
        console.error('[webchat] Connection handler error:', err);
        ws.close(1011, 'Internal error');
      });
    });

    // Heartbeat every 30s to detect stale connections
    this.heartbeatInterval = setInterval(() => {
      this.pruneStaleConnections();
    }, 30_000);

    this.httpServer.listen(port, () => {
      console.log(`[webchat] WebSocket server listening on port ${port}`);
    });
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all connections gracefully
    for (const [, conn] of this.connections) {
      conn.ws.close(1001, 'Server shutting down');
    }
    this.connections.clear();
    this.userConnections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound messaging
  // -------------------------------------------------------------------------

  async sendMessage(target: OutboundTarget, content: MessageContent): Promise<void> {
    // The channel field carries the userId for webchat outbound routing
    const userKey = `${target.accountId}:${target.channel}`;
    const connectionIds = this.userConnections.get(userKey);
    if (!connectionIds || connectionIds.size === 0) {
      console.warn(`[webchat] No active connections for ${userKey}`);
      return;
    }

    const payload = JSON.stringify({
      type: 'message',
      text: content.text,
      thread_id: target.threadId ?? null,
      timestamp: new Date().toISOString(),
    });

    for (const connId of connectionIds) {
      const conn = this.connections.get(connId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    // Extract JWT from query parameter
    const parsed = url.parse(req.url ?? '', true);
    const token = parsed.query['token'] as string | undefined;

    if (!token) {
      ws.close(4001, 'Missing authentication token');
      return;
    }

    const verification = await verifyWebChatToken(token, this.eveApiUrl, this.orgId);
    if (!verification.ok) {
      logger.warn({
        event: 'webchat.token_invalid',
        reason: verification.closeReason,
      });
      ws.close(4001, verification.closeReason);
      return;
    }
    const claims = verification.claims;

    const connId = `wc_${++this.connectionCounter}_${Date.now()}`;
    const connection: WebChatConnection = {
      ws,
      userId: claims.user_id,
      orgId: claims.org_id,
      accountId: this.accountId,
      connectedAt: new Date(),
      lastPing: new Date(),
    };

    this.connections.set(connId, connection);

    // Track by user for outbound fan-out
    const userKey = `${this.accountId}:${claims.user_id}`;
    if (!this.userConnections.has(userKey)) {
      this.userConnections.set(userKey, new Set());
    }
    this.userConnections.get(userKey)!.add(connId);

    // Acknowledge the connection
    ws.send(JSON.stringify({
      type: 'connected',
      connection_id: connId,
      user_id: claims.user_id,
      org_id: claims.org_id,
    }));

    ws.on('message', (data: Buffer | string) => {
      this.handleMessage(connId, connection, data).catch((err) => {
        console.error('[webchat] Message handler error:', err);
      });
    });

    ws.on('pong', () => {
      connection.lastPing = new Date();
    });

    ws.on('close', () => {
      this.removeConnection(connId, userKey);
    });

    ws.on('error', (err) => {
      console.error(`[webchat] Connection ${connId} error:`, err.message);
      this.removeConnection(connId, userKey);
    });
  }

  // -------------------------------------------------------------------------
  // Inbound message handling
  // -------------------------------------------------------------------------

  private async handleMessage(
    connId: string,
    connection: WebChatConnection,
    raw: Buffer | string,
  ): Promise<void> {
    let msg: WebChatInboundMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    } catch {
      connection.ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (msg.type !== 'message' || !msg.text) {
      connection.ws.send(JSON.stringify({ type: 'error', message: 'Invalid message type or missing text' }));
      return;
    }

    const threadId = msg.thread_id ?? connId;

    // Use rawType 'webchat' (not 'message') so the chat service routes
    // through the command path rather than the listener dispatch path.
    const inbound: NormalizedInbound = {
      rawType: 'webchat',
      provider: 'webchat',
      accountId: connection.accountId,
      externalUserId: connection.userId,
      channel: connection.userId,
      threadId,
      text: msg.text,
      agentSlugHint: msg.agent_slug,
      commandText: msg.text,
      dedupeKey: `webchat:${connId}:${Date.now()}`,
      raw: msg,
    };

    const result = await this.chatService.resolveAndRoute(inbound);

    if (result.immediateReply) {
      await this.sendMessage(
        {
          provider: 'webchat',
          accountId: connection.accountId,
          channel: connection.userId,
          threadId,
        },
        result.immediateReply,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Connection cleanup
  // -------------------------------------------------------------------------

  private removeConnection(connId: string, userKey: string): void {
    this.connections.delete(connId);
    const userConns = this.userConnections.get(userKey);
    if (userConns) {
      userConns.delete(connId);
      if (userConns.size === 0) {
        this.userConnections.delete(userKey);
      }
    }
  }

  /**
   * Prune connections that haven't responded to ping within the stale threshold.
   * Also cleans up connections whose underlying socket is no longer open.
   */
  private pruneStaleConnections(): void {
    const staleThreshold = 60_000; // 60 seconds
    const now = Date.now();

    for (const [connId, conn] of this.connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.ping();

        if (now - conn.lastPing.getTime() > staleThreshold) {
          console.log(`[webchat] Pruning stale connection ${connId}`);
          conn.ws.terminate();
          const userKey = `${conn.accountId}:${conn.userId}`;
          this.removeConnection(connId, userKey);
        }
      } else {
        const userKey = `${conn.accountId}:${conn.userId}`;
        this.removeConnection(connId, userKey);
      }
    }
  }
}
