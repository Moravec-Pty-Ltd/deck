// @ts-nocheck: runs in the AudioWorkletGlobalScope, whose globals the DOM types lack.

// Copies the mic's first channel to the main thread in 2048-frame chunks
// (about 40 ms), where the voice bar measures them for the level and detector
// and keeps them for the take. Any message from the main thread ends it.
class PcmCapture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.chunk = new Float32Array(2048);
		this.filled = 0;
		this.live = true;
		this.port.onmessage = () => (this.live = false);
	}

	process(inputs) {
		const samples = inputs[0]?.[0];
		if (samples) this.append(samples);
		return this.live;
	}

	append(samples) {
		for (let i = 0; i < samples.length; i++) {
			this.chunk[this.filled++] = samples[i];
			if (this.filled === this.chunk.length) {
				this.port.postMessage(this.chunk, [this.chunk.buffer]);
				this.chunk = new Float32Array(2048);
				this.filled = 0;
			}
		}
	}
}

registerProcessor('pcm-capture', PcmCapture);
