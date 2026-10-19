// AudioWorklet for public/collab.mjs: hands each block of the partner's audio (mono) to the page.
class CollabTap extends AudioWorkletProcessor {
    process(inputs) { const ch = inputs[0]?.[0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('collab-tap', CollabTap);
