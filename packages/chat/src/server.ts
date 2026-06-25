import { createConversationClient } from './client.js';
import type { ConversationClientOptions, ConversationTurnRequest } from './types.js';

export interface EveConversationsClientOptions extends Omit<ConversationClientOptions, 'getToken'> {
  token: string | (() => string | Promise<string>);
}

export class EveConversationsClient {
  private client: ReturnType<typeof createConversationClient>;

  constructor(options: EveConversationsClientOptions) {
    this.client = createConversationClient({
      ...options,
      getToken: async () => typeof options.token === 'function' ? options.token() : options.token,
    });
  }

  ensure(...args: Parameters<typeof this.client.ensure>) {
    return this.client.ensure(...args);
  }

  get(...args: Parameters<typeof this.client.get>) {
    return this.client.get(...args);
  }

  send(...args: Parameters<typeof this.client.send>) {
    return this.client.send(...args);
  }

  messages(...args: Parameters<typeof this.client.messages>) {
    return this.client.messages(...args);
  }

  events(...args: Parameters<typeof this.client.events>) {
    return this.client.events(...args);
  }

  emitEvent(...args: Parameters<typeof this.client.emitEvent>) {
    return this.client.emitEvent(...args);
  }

  stream(...args: Parameters<typeof this.client.stream>) {
    return this.client.stream(...args);
  }

  streamEvents(...args: Parameters<typeof this.client.streamEvents>) {
    return this.client.streamEvents(...args);
  }

  async forwardTurn(
    input: string | ConversationTurnRequest,
    enrich?: (turn: ConversationTurnRequest) => Promise<ConversationTurnRequest | null> | ConversationTurnRequest | null,
  ) {
    const turn = typeof input === 'string' ? { text: input } : input;
    const enriched = enrich ? await enrich(turn) : turn;
    if (!enriched) {
      throw new Error('Conversation turn rejected by enrich hook');
    }
    return this.client.send(enriched);
  }
}
