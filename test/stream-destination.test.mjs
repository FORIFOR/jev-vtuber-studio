import test from 'node:test';
import assert from 'node:assert/strict';
import { OBS } from '../src/obs.mjs';
import { setup } from './helpers.mjs';
function mock(t, { active = false, record = false, wrong = false } = {}) {
    const c = setup(t, { ALLOW_OBS_STREAM: 'true', STREAM_TARGET: 'youtube' });
    c.mode = 'live';
    const obs = new OBS(c), calls = []; let profile = c.obsYouTubeProfile;
    obs.call = async (type, data) => {
        calls.push(type);
        if (type === 'GetStreamStatus') return { outputActive: active };
        if (type === 'GetRecordStatus') return { outputActive: record };
        if (type === 'GetReplayBufferStatus') return { outputActive: false };
        if (type === 'GetProfileList') return { currentProfileName: profile, profiles: [c.obsYouTubeProfile, c.obsTwitchProfile] };
        if (type === 'SetCurrentProfile') { profile = data.profileName; return {}; }
        if (type === 'GetStreamServiceSettings') return { streamServiceType: 'rtmp_common', streamServiceSettings: { service: !wrong && profile === c.obsTwitchProfile ? 'Twitch' : 'YouTube - RTMPS', key: 'PRIVATE-STREAM-KEY' } };
        return {};
    };
    return { c, obs, calls, current: () => profile };
}
test('switch changes OBS profile, validates service, saves selection, never starts output', async t => {
    const { c, obs, calls } = mock(t);
    const d = await obs.selectDestination('twitch', target => { c.streamTarget = target; });
    assert.equal(d.actual, 'twitch'); assert.equal(c.streamTarget, 'twitch'); assert.equal(d.ready, true);
    assert.ok(!JSON.stringify(d).includes('PRIVATE')); assert.ok(!calls.includes('StartStream'));
});
test('streaming and recording prevent profile switching', async t => {
    for (const state of [{ active: true }, { record: true }]) {
        const {obs,calls} = mock(t, state); await assert.rejects(obs.selectDestination('twitch'), /停止/);
        assert.ok(!calls.includes('SetCurrentProfile'));
    }
});
test('wrong service is rolled back and selected destination is not saved', async t => {
    const { c, obs, current } = mock(t, { wrong: true }); let saved = false;
    await assert.rejects(obs.selectDestination('twitch', () => { saved = true; }), /一致/);
    assert.equal(current(), c.obsYouTubeProfile); assert.equal(saved, false);
});
test('failed settings persistence restores previous profile', async t => {
    const { c, obs, current } = mock(t);
    await assert.rejects(obs.selectDestination('twitch', () => { throw Error('disk'); }), /disk/);
    assert.equal(current(), c.obsYouTubeProfile);
});
test('start refuses mismatched destination without sending StartStream', async t => {
    const { c, obs, calls } = mock(t); c.streamTarget = 'twitch';
    await assert.rejects(obs.start(), /一致/); assert.ok(!calls.includes('StartStream')); assert.equal(obs.owned, false);
});
test('destination enumeration rejects arbitrary profile targets', async t => {
    const {obs} = mock(t); await assert.rejects(obs.selectDestination('../../other'), /選択/);
});
test('disabled OBS replay buffer permits switching; other errors fail closed', async t => {
    const {obs} = mock(t); const call = obs.call;
    obs.call = async (type, data) => { if (type === 'GetReplayBufferStatus') throw Error('OBS GetReplayBufferStatus failed (604)'); return call(type, data); };
    assert.equal((await obs.selectDestination('twitch')).ready, true);
    obs.call = async type => { if (type === 'GetReplayBufferStatus') throw Error('network'); return { outputActive: false }; };
    await assert.rejects(obs.selectDestination('youtube'), /network/);
});

test('simulcast requires its own Restream profile and never accepts a Twitch-only profile', async t => {
    const {c,obs} = mock(t); c.streamTarget = 'simulcast';
    assert.equal((await obs.destination()).ready, false);
    obs.call = async type => type === 'GetProfileList'
        ? {currentProfileName:c.obsSimulcastProfile}
        : {streamServiceSettings:{service:'Restream.io - RTMPS',key:'TEST-ONLY'}};
    const d=await obs.destination(); assert.equal(d.ready,true); assert.equal(d.actual,'simulcast');
    assert.equal(JSON.stringify(d).includes('TEST-ONLY'),false);
});
