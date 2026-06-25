import { useContext } from 'react';
import { EveConversationContext } from './provider.js';

export function useEveConversation() {
  const ctx = useContext(EveConversationContext);
  if (!ctx) {
    throw new Error('useEveConversation must be used within an EveConversationProvider');
  }
  return ctx;
}
