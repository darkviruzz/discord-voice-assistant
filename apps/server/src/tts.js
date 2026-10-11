// Thin re-export: the TTS backends (piper | openai | elevenlabs) live in
// providers/tts.js. Kept so ttsStream.js, debugTts.js and anything else that
// imports './tts.js' keeps working unchanged.
//
// synthesizeStream(text, opts, signal) → async iterable of
// { pcm: Buffer (mono int16LE), sampleRate }; ends silently on abort.
export { synthesizeStream, ttsConfig, ttsProvider } from './providers/tts.js';
