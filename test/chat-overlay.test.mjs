import test from 'node:test';
import assert from 'node:assert/strict';
import { twitchMessage, youtubeMessages } from '../scripts/chat-overlay.mjs';

test('chat overlay: Twitch PRIVMSG lines and YouTube pages become one message shape', () => {
    assert.deepEqual(twitchMessage('@badge-info=;display-name=Foo\\sBar;color=#FFF :foo!foo@foo.tmi.twitch.tv PRIVMSG #hoshiai_noa :こんばんは'), { source: 'twitch', name: 'Foo Bar', text: 'こんばんは' });
    assert.equal(twitchMessage(':tmi.twitch.tv 001 justinfan1 :Welcome'), null);
    assert.deepEqual(youtubeMessages({ items: [{ id: 'a', snippet: { type: 'textMessageEvent', displayMessage: '初見です' }, authorDetails: { displayName: '@ゆき' } }] }),
        [{ id: 'a', source: 'youtube', name: '@ゆき', text: '初見です' }]);
});
