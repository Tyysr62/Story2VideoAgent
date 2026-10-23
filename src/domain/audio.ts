import { z } from 'zod';

const description = z.string().trim().max(1000);
const characterId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const audioProfileSchema = z.object({
  narratorVoice: description,
  characterVoices: z.array(z.object({ characterId, description }).strict()).max(30),
}).strict();
export const audioPlanSchema = z.object({
  mode: z.enum(['silent', 'ambient', 'speech']),
  dialogue: z.array(z.object({ characterId, text: z.string().trim().min(1).max(2000), delivery: description, placement: z.enum(['on_screen', 'off_screen']) }).strict()).max(20),
  narration: z.object({ text: z.string().trim().min(1).max(2000), delivery: description }).strict().nullable(),
  ambience: description,
  soundEffects: z.array(z.string().trim().min(1).max(500)).max(10),
  music: z.literal('none'),
}).strict().superRefine((audio, ctx) => {
  const speech = audio.dialogue.length > 0 || Boolean(audio.narration);
  if (audio.mode !== 'speech' && speech) ctx.addIssue({ code: 'custom', message: '静音或仅环境声模式不能包含台词、旁白' });
  if (audio.mode === 'speech' && !speech) ctx.addIssue({ code: 'custom', message: '有人声模式需要角色台词或旁白' });
  if (audio.mode === 'silent' && (audio.ambience || audio.soundEffects.length)) ctx.addIssue({ code: 'custom', message: '完全静音不能包含环境声或音效' });
});
export type AudioPlan = z.infer<typeof audioPlanSchema>;
export type AudioProfile = z.infer<typeof audioProfileSchema>;
export function silentAudio(): AudioPlan { return { mode: 'silent', dialogue: [], narration: null, ambience: '', soundEffects: [], music: 'none' }; }
export function speechLengthWarning(audio: AudioPlan | undefined, seconds: number): string | null {
  if (audio?.mode !== 'speech') return null;
  const length = [...audio.dialogue.map(d => d.text), audio.narration?.text ?? ''].join('').replace(/[\s，。！？、,.!?]/gu, '').length;
  return length > seconds * 4 ? '台词与旁白偏长，建议缩短文本或增加时长，为动作与停顿留出时间；实际语速需试听确认。' : null;
}
