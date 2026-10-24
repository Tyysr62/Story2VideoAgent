import type { Storyboard } from '../domain/storyboard.js';
import { silentAudio } from '../domain/audio.js';

export const VIDEO_PROMPT_VERSION = 'story-video-v2.2';
/** Pure compilation: the returned string is the exact provider input and cache dependency. */
export function compileVideoPrompt(board: Storyboard, shot: Storyboard['shots'][number], mode: 'text' | 'first_frame'): string {
  const audio = shot.audio ?? silentAudio();
  const identity = (id: string) => `角色[${id}]（${board.characters.find(c => c.id === id)?.description ?? id}）`;
  const voice = (id: string) => board.audioProfile?.characterVoices.find(v => v.characterId === id)?.description || '自然的普通话声音';
  const visual = mode === 'first_frame'
    ? `从给定首帧开始，保持首帧的人物身份、年龄、服装、场景与画风，不重新设计已有画面。`
    : `视觉风格：${board.style}\n出镜主体：${shot.characterIds.map(identity).join('；') || '无人物镜头'}`;
  const sound = audio.mode === 'silent' ? '完全静音；不生成对白、旁白、环境声、音效或音乐。'
    : [audio.mode === 'ambient' ? '仅环境声与音效，无人声、无对白、无旁白。' : '以下是唯一允许的对白与旁白原文，按列出的先后顺序发声，避免人声互相重叠；完整保留语气词和句中停顿，不擅自增删改写台词。不朗读角色编号。',
      ...audio.dialogue.map((d, i) => `${i + 1}. ${identity(d.characterId)}，${d.placement === 'on_screen' ? '画内说话，配合自然口型与表情' : '画外发声，不让画内人物代说'}；声音：${voice(d.characterId)}；表演（执行而不朗读表演说明）：${d.delivery || '像在对具体的人说话，随当下情绪自然表达，保留呼吸和停顿，避免播报腔'}；普通话准确台词：${JSON.stringify(d.text)}`),
      audio.narration ? `画外旁白，不让画内人物张嘴代说；声音：${board.audioProfile?.narratorVoice || '自然、温暖的普通话旁白'}；表演（执行而不朗读表演说明）：${audio.narration.delivery || '自然叙述，留出呼吸和停顿，避免播报腔'}；准确原文：${JSON.stringify(audio.narration.text)}` : '无旁白。',
      `环境声：${audio.ambience || '无额外环境声'}。`, `音效：${audio.soundEffects.join('；') || '无额外音效'}。`,
      ...(audio.mode === 'speech' ? ['声音分层：对白与旁白处于前景，人声期间指定的环境声自然持续，必要音效随动作同步；背景层可以轻微降低音量，但不能盖住说话，也不要一开口就突然消失。未指定的环境层不额外添加。', '按对应角色的表演说明自然执行指定的呼吸、轻笑、叹息等非语言反应，不将它们念成解说；没有要求的表演不额外堆砌。保留反应和停顿，不加速赶词。'] : []),
      '无配乐，不添加未指定的台词、旁白、哼唱或背景人声；环境与动作音效不能当作台词念出。'].join('\n');
  return [visual, `本片段时长：${shot.duration}秒。单个连续镜头，动作应在时长内自然完成，不擅自切换场景。`,
    '以下视觉描述只用于画面，声音以最后的声音设计为准。', `场景与可见动作：${shot.description}`, `摄影与运镜：${shot.camera}`, `视觉动作要求：${shot.videoPrompt}`,
    '不生成字幕、标题、气泡文字或水印。', '声音设计（唯一发声依据）：', sound].join('\n');
}
