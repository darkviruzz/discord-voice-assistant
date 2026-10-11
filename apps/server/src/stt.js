// Speech-to-text entry point. The implementation lives in providers/stt.js
// (whisper.cpp /inference by default, or any OpenAI-compatible
// /audio/transcriptions via STT_PROVIDER=openai); this module stays so
// pipeline.js, sttStreaming.js and the tests keep their imports.
//
//   transcribe(wavBuffer, { prompt?, signal? }) → { text, meta, words }
//   cleanWhisperText(s)                          whisper.cpp text clean-up
export { transcribe, cleanWhisperText } from './providers/stt.js';
