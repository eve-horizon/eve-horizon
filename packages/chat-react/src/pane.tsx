import type { FormEvent } from 'react';
import { useState } from 'react';
import { useEveConversation } from './hooks.js';

export function EveConversationPane() {
  const { messages, send, loading, error } = useEveConversation();
  const [text, setText] = useState('');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    await send(value);
  };

  return (
    <section>
      <div>
        {messages.map((message) => (
          <article key={message.id} data-direction={message.direction}>
            {message.body}
          </article>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <form onSubmit={onSubmit}>
        <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={loading} />
        <button type="submit" disabled={loading || !text.trim()}>Send</button>
      </form>
    </section>
  );
}
