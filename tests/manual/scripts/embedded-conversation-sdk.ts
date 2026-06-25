import { createConversationClient } from '@eve-horizon/chat';

const baseUrl = process.env.EVE_API_URL ?? 'http://api.eve.lvh.me';
const projectId = process.env.PROJECT_ID;
const token = process.env.TOKEN;
const appKey = process.env.APP_KEY ?? `manual:sdk-${Date.now()}`;
const appId = process.env.APP_ID ?? 'manual-app';

if (!projectId) throw new Error('PROJECT_ID is required');
if (!token) throw new Error('TOKEN is required');

const conv = createConversationClient({
  baseUrl,
  projectId,
  appKey,
  appId,
  getToken: () => token,
});

const ensured = await conv.ensure({ metadata: { smoke: true } });
console.log('ensured', ensured.thread_id, ensured.key);

const sent = await conv.send('sdk smoke hello');
console.log('sent', sent.thread_id, sent.job_ids.join(','));

const messages = await conv.messages({ limit: 10 });
console.log('messages', messages.messages.length);

const ac = new AbortController();
setTimeout(() => ac.abort(), 5000);
let lastEventId: string | undefined;
for await (const event of conv.stream({ signal: ac.signal })) {
  if (event.eventId) lastEventId = event.eventId;
  console.log('stream', event.kind, event.eventId ?? '');
  if (event.kind === 'snapshot') {
    ac.abort();
  }
}

await conv.send('sdk smoke resume');
const resume = new AbortController();
setTimeout(() => resume.abort(), 5000);
for await (const event of conv.stream({ signal: resume.signal, resumeFrom: lastEventId })) {
  console.log('resume', event.kind, event.eventId ?? '');
  if (event.kind === 'message' || event.kind === 'progress') {
    resume.abort();
  }
}
