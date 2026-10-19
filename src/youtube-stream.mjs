// Official YouTube StreamList wire contract; minimal read-only text subset.
// Field numbers/service path: https://developers.google.com/youtube/v3/live/streaming-live-chat
// Google documentation code examples: Apache-2.0. See THIRD_PARTY_NOTICES.md.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
/** True when the optional streaming-chat packages (npm run setup:youtube) can be loaded. */
export function grpcAvailable(resolve = require.resolve) {
    try { resolve('@grpc/grpc-js'); resolve('@grpc/proto-loader'); return true; } catch { return false; }
}
export async function* streamPages({ liveChatId, pageToken, apiKey, accessToken, signal }) {
    let grpc, loader;
    try { grpc = require('@grpc/grpc-js'); loader = require('@grpc/proto-loader'); }
    catch { const e = new Error('Install npm dependencies for streaming chat'); e.code = 'MISSING_GRPC'; throw e; }
    const def = loader.loadSync(fileURLToPath(new URL('../proto/stream_list.proto', import.meta.url)), { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true });
    const API = grpc.loadPackageDefinition(def).youtube.api.v3;
    const client = new API.V3DataLiveChatMessageService('youtube.googleapis.com:443', grpc.credentials.createSsl(), { 'grpc.max_receive_message_length': 2_000_000 });
    const metadata = new grpc.Metadata();
    if (apiKey) metadata.set('x-goog-api-key', apiKey);
    else metadata.set('authorization', `Bearer ${accessToken}`);
    const call = client.StreamList({ live_chat_id: liveChatId, part: ['id', 'snippet', 'authorDetails'], ...(pageToken ? { page_token: pageToken } : {}) }, metadata, { deadline: new Date(Date.now() + 45 * 60000) });
    const cancel = () => call.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) call.cancel();
    try {
        for await (const page of call) {
            if (signal?.aborted) break;
            yield {
                nextPageToken: page.next_page_token, offlineAt: page.offline_at,
                items: (page.items || []).map(m => ({
                    id: m.id, authorDetails: { channelId: m.author_details?.channel_id, displayName: /^https?:/.test(m.author_details?.display_name || '') ? '' : m.author_details?.display_name },
                    snippet: { type: m.snippet?.type === 'TEXT_MESSAGE_EVENT' ? 'textMessageEvent' : m.snippet?.type === 'CHAT_ENDED_EVENT' ? 'chatEndedEvent' : 'ignored',
                        publishedAt: m.snippet?.published_at, displayMessage: m.snippet?.display_message,
                        textMessageDetails: { messageText: m.snippet?.text_message_details?.message_text },
                        authorChannelId: m.snippet?.author_channel_id }
                }))
            };
        }
    } finally { signal?.removeEventListener('abort', cancel); call.cancel(); client.close(); }
}
