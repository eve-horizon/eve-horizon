import type {
  GatewayProvider,
  GatewayTransport,
  GatewayCapability,
  ProviderConfig,
  OutboundTarget,
  MessageContent,
} from '../gateway-provider.interface.js';

/**
 * API Gateway Provider — no-op delivery for polling-based clients.
 *
 * Web apps and API clients that send chat messages via the REST API
 * (`POST /projects/:id/chat/route` with `provider: "api"`) don't have
 * a push channel. The agent's reply is already persisted in
 * `thread_messages` before the gateway is called — the client polls
 * for it. This provider acknowledges delivery without pushing.
 */
export class ApiGatewayProvider implements GatewayProvider {
  readonly name = 'api';
  readonly transport: GatewayTransport = 'subscription';
  readonly capabilities: GatewayCapability[] = ['inbound', 'outbound'];

  async initialize(_config: ProviderConfig): Promise<void> {
    // No connections to establish — clients poll the REST API.
  }

  async shutdown(): Promise<void> {
    // Nothing to clean up.
  }

  async sendMessage(_target: OutboundTarget, _content: MessageContent): Promise<void> {
    // No-op. The message is already stored in thread_messages.
    // The client retrieves it by polling GET /threads/:id/messages.
  }
}
