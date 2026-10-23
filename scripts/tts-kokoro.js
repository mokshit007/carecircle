// Neural text-to-speech with Kokoro (open-source, Apache-2.0, runs offline after the first model download).
//   node scripts/tts-kokoro.js out.wav "Text to speak" [voice]
import { KokoroTTS } from 'kokoro-js';

let tts;
export async function speak(text, file, voice = process.env.VIDEO_VOICE_KOKORO || 'af_heart') {
  tts ??= await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const audio = await tts.generate(text, { voice, speed: 0.95 });
  await audio.save(file);
  return audio.audio.length / audio.sampling_rate; // seconds
}

if (process.argv[1]?.endsWith('tts-kokoro.js')) {
  const [, , file, text, voice] = process.argv;
  const secs = await speak(text, file, voice);
  console.log(`${file}: ${secs.toFixed(1)}s`);
}
