import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createConversationClient, type ConversationTurnRequest, type ThreadMessage } from '@eve-horizon/chat';
import type { EveConversationState } from './types.js';

export interface EveConversationProviderProps {
  baseUrl: string;
  projectId: string;
  appKey: string;
  appId?: string;
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  children: ReactNode;
}

export const EveConversationContext = createContext<EveConversationState | null>(null);

export function EveConversationProvider({
  baseUrl,
  projectId,
  appKey,
  appId,
  getToken,
  children,
}: EveConversationProviderProps) {
  const [conversation, setConversation] = useState<EveConversationState['conversation']>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamNonce, setStreamNonce] = useState(0);

  const client = useMemo(() => createConversationClient({
    baseUrl,
    projectId,
    appKey,
    appId,
    getToken,
  }), [baseUrl, projectId, appKey, appId, getToken]);

  const ensure = useCallback(async (metadata?: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    try {
      const resolved = await client.ensure({ metadata });
      setConversation(resolved);
      if (resolved.last_message) setMessages((current) => mergeMessages(current, [resolved.last_message!]));
      return resolved;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  const send = useCallback(async (input: string | ConversationTurnRequest) => {
    const text = typeof input === 'string' ? input : input.text;
    const optimistic: ThreadMessage = {
      id: `optimistic:${Date.now()}`,
      thread_id: conversation?.thread_id ?? '',
      direction: 'inbound',
      kind: 'message',
      actor_type: 'user',
      actor_id: null,
      body: text,
      job_id: null,
      created_at: new Date().toISOString(),
    };
    setMessages((current) => mergeMessages(current, [optimistic]));
    const result = await client.send(input);
    setStreamNonce((value) => value + 1);
    return result;
  }, [client, conversation?.thread_id]);

  const reconnect = useCallback(() => setStreamNonce((value) => value + 1), []);

  useEffect(() => {
    if (!conversation) return;
    const ac = new AbortController();
    setStreaming(true);
    setError(null);
    void (async () => {
      try {
        for await (const event of client.stream({ signal: ac.signal })) {
          if (event.kind === 'snapshot' && 'messages' in event) {
            setMessages((current) => mergeMessages(current, event.messages));
          }
          if (event.kind === 'message' && 'message' in event) {
            setMessages((current) => mergeMessages(current, [event.message]));
          }
          if (event.kind === 'progress' && 'message' in event) {
            setMessages((current) => mergeMessages(current, [event.message]));
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!ac.signal.aborted) setStreaming(false);
      }
    })();
    return () => ac.abort();
  }, [client, streamNonce, conversation]);

  const value = useMemo<EveConversationState>(() => ({
    conversation,
    messages,
    loading,
    streaming,
    error,
    ensure,
    send,
    reconnect,
  }), [conversation, messages, loading, streaming, error, ensure, send, reconnect]);

  return <EveConversationContext.Provider value={value}>{children}</EveConversationContext.Provider>;
}

function mergeMessages(current: ThreadMessage[], incoming: ThreadMessage[]): ThreadMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
