/* Local-only capture. No network, storage, transcription or business actions. */
class MinkAudioRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || this.frames >= 960000) return true;
    const samples = input.slice(0, 960000 - this.frames);
    this.frames += samples.length;
    this.port.postMessage(samples, [samples.buffer]);
    return true;
  }
}
registerProcessor("mink-audio-recorder", MinkAudioRecorder);
