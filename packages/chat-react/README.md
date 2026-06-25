# @eve-horizon/chat-react

React bindings for Eve embedded app conversations.

```tsx
import { EveConversationProvider, EveConversationDefaultPane } from '@eve-horizon/chat-react';

function Conversation({ token }: { token: string }) {
  return (
    <EveConversationProvider
      baseUrl="/api/eve"
      projectId="proj_xxx"
      appKey="open-design:project-1:conversation-1"
      getToken={() => token}
    >
      <EveConversationDefaultPane />
    </EveConversationProvider>
  );
}
```
