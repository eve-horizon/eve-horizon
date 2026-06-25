# @eve-horizon/chat

Browser and server client for Eve embedded app conversations.

```ts
import { createConversationClient } from '@eve-horizon/chat';

const conversation = createConversationClient({
  baseUrl: '/api/eve',
  projectId: 'proj_xxx',
  appKey: `open-design:${projectId}:${conversationId}`,
  getToken: async () => session.token,
});

await conversation.ensure({ metadata: { product_route: '/projects/x' } });
await conversation.send({
  text: 'Add a navbar with an auth dropdown',
  target: { kind: 'agent', agent_slug: 'od-designer' },
});

for await (const event of conversation.stream()) {
  if (event.kind === 'message') console.log(event.message.body);
  if (event.kind === 'progress') console.log(event.message.body);
}
```

The stream uses `fetch`, so bearer tokens and `Last-Event-ID` resume headers work in browsers:

```ts
for await (const event of conversation.stream({ resumeFrom: lastEventId })) {
  if (event.eventId) lastEventId = event.eventId;
}
```
