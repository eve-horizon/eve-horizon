import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Bot } from 'lucide-react';
import { SlideOver } from '@/components/slide-over';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { Agent } from '../shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThreadMessage {
  id: string;
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  direction?: 'inbound' | 'outbound';
  actor_type?: string | null;
  body?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMessageBody(message: ThreadMessage): string {
  return message.content ?? message.body ?? '';
}

function isUserMessage(message: ThreadMessage): boolean {
  if (message.role) {
    return message.role === 'user';
  }
  return message.direction === 'inbound' && message.actor_type !== 'agent';
}

// ---------------------------------------------------------------------------
// Chat Slide-Over
// ---------------------------------------------------------------------------

export function ChatSlideOver({ agent, orgId, onClose }: { agent: Agent | null; orgId: string; onClose: () => void }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Reset thread when agent changes
  useEffect(() => {
    setThreadId(null);
    setMessageText('');
  }, [agent?.id]);

  useEffect(() => {
    let cancelled = false;

    if (!agent || !orgId) {
      return () => { cancelled = true; };
    }

    const ensureThread = async () => {
      try {
        const thread = await api<{ id: string }>(`/orgs/${orgId}/threads`, {
          method: 'POST',
          body: JSON.stringify({ key: `agents:${agent.slug}` }),
        });
        if (!cancelled) {
          setThreadId(thread.id);
        }
      } catch (err) {
        console.error('Failed to ensure agent thread:', err);
      }
    };

    ensureThread();

    return () => {
      cancelled = true;
    };
  }, [agent, orgId]);

  // Fetch messages when we have a thread
  const { data: messagesData } = useQuery({
    queryKey: ['thread-messages', threadId],
    queryFn: () => api<{ messages?: ThreadMessage[]; data?: ThreadMessage[] }>(`/orgs/${orgId}/threads/${threadId}/messages`),
    enabled: !!threadId,
    refetchInterval: 3000,
  });

  const messages = messagesData?.messages ?? messagesData?.data ?? [];

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const sendMessage = useCallback(async () => {
    if (!messageText.trim() || !agent || sending) return;
    setSending(true);

    try {
      if (!threadId) {
        console.error('Failed to create thread');
        return;
      }

      await api(`/orgs/${orgId}/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: messageText,
          direction: 'inbound',
          actor_type: 'user',
        }),
      });

      setMessageText('');
      queryClient.invalidateQueries({ queryKey: ['thread-messages', threadId] });
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  }, [messageText, agent, threadId, orgId, sending, queryClient]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  return (
    <SlideOver
      open={!!agent}
      onClose={onClose}
      title={agent?.name ?? agent?.slug ?? 'Chat'}
      subtitle={agent?.harness_profile ? `${agent.harness_profile} profile` : undefined}
      width="w-[540px] max-w-[90vw]"
    >
      {/* Messages area */}
      <div className="flex flex-col h-[calc(100vh-200px)]">
        <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-label text-[var(--text-muted)]">
          This is the agent thread record for direct dashboard messages. Routed delivery still depends on the project's chat wiring.
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 pb-4">
          {messages.length === 0 && !threadId && (
            <div className="text-center py-12">
              <Bot size={32} className="mx-auto mb-3 text-[var(--text-muted)]" />
              <div className="text-body text-[var(--text-secondary)]">Start a conversation with {agent?.name ?? 'this agent'}</div>
            </div>
          )}
          {messages.length === 0 && threadId && (
            <div className="text-center py-8 text-label text-[var(--text-muted)]">Waiting for response...</div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${isUserMessage(msg) ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className="max-w-[80%] rounded-lg px-3 py-2 text-body"
                style={{
                  background: isUserMessage(msg) ? 'var(--blue)' : 'var(--bg-2)',
                  color: isUserMessage(msg) ? '#fff' : 'var(--text-primary)',
                }}
              >
                <div className="whitespace-pre-wrap break-words">{getMessageBody(msg)}</div>
                <div
                  className="text-label mt-1"
                  style={{ opacity: 0.6 }}
                >
                  {timeAgo(msg.created_at)}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex items-end gap-2 pt-3 border-t border-[var(--border)]">
          <textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-[var(--bg-2)] rounded-lg px-3 py-2 text-body outline-none resize-none border border-[var(--border)] focus:border-[var(--blue)] transition-colors"
            style={{ maxHeight: 120, minHeight: 36, color: 'var(--text-primary)' }}
          />
          <button
            onClick={sendMessage}
            disabled={!messageText.trim() || sending}
            className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors disabled:opacity-40"
            style={{ background: 'var(--blue)', color: '#fff' }}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </SlideOver>
  );
}
