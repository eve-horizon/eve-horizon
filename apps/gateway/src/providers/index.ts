// Gateway provider framework
export type {
  GatewayProvider,
  GatewayTransport,
  GatewayCapability,
  ProviderConfig,
  WebhookRequest,
  WebhookValidation,
  WebhookParseResult,
  NormalizedInbound,
  OutboundTarget,
  MessageContent,
  ResolvedIdentity,
} from './gateway-provider.interface.js';

export { GatewayProviderRegistry } from './provider-registry.js';
export type { GatewayProviderFactory } from './provider-registry.js';

// Slack provider
export { SlackGatewayProvider } from './slack/slack.provider.js';
export { isValidSlackSignature } from './slack/slack-signature.js';
export {
  parseAgentCommand,
  parseAgentsCommand,
  isBotEvent,
  isPlainMessageEvent,
  extractText,
} from './slack/slack-parser.js';
export {
  extractSlackToken,
  extractSlackBotUserId,
  getIntegrationTokens,
  sendSlackMessage,
} from './slack/slack-sender.js';

// WebChat provider
export { WebChatGatewayProvider } from './webchat/index.js';
