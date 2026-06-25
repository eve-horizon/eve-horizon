import type { ConversationResponse, ConversationStreamEvent, ConversationTurnRequest, ConversationTurnResponse, ThreadMessage } from '@eve-horizon/chat';

export interface EveConversationState {
  conversation: ConversationResponse | null;
  messages: ThreadMessage[];
  loading: boolean;
  streaming: boolean;
  error: string | null;
  ensure: (metadata?: Record<string, unknown>) => Promise<ConversationResponse>;
  send: (input: string | ConversationTurnRequest) => Promise<ConversationTurnResponse>;
  reconnect: () => void;
}

export type EveConversationEvent = ConversationStreamEvent;
