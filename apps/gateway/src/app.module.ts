import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { WebhookController } from './webhook/webhook.controller.js';
import { DeliveryController } from './delivery/delivery.controller.js';
import { GatewayProviderRegistry } from './providers/provider-registry.js';
import { SlackGatewayProvider } from './providers/slack/slack.provider.js';
import { NostrGatewayProvider } from './providers/nostr/index.js';
import { WebChatGatewayProvider } from './providers/webchat/index.js';
import { ApiGatewayProvider } from './providers/api/index.js';
import { GatewayChatService } from './chat/gateway-chat.service.js';

const chatServiceProvider = {
  provide: GatewayChatService,
  useFactory: () => new GatewayChatService(),
};

const registryProvider = {
  provide: GatewayProviderRegistry,
  useFactory: (chatService: GatewayChatService) => {
    const registry = new GatewayProviderRegistry();
    registry.registerFactory('slack', {
      create: () => new SlackGatewayProvider(),
    });
    registry.registerFactory('nostr', {
      create: () => new NostrGatewayProvider(chatService),
    });
    registry.registerFactory('webchat', {
      create: () => new WebChatGatewayProvider(chatService),
    });
    registry.registerFactory('api', {
      create: () => new ApiGatewayProvider(),
    });
    return registry;
  },
  inject: [GatewayChatService],
};

@Module({
  controllers: [HealthController, WebhookController, DeliveryController],
  providers: [chatServiceProvider, registryProvider],
})
export class AppModule {}
