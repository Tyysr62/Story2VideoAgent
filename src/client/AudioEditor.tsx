import type { Storyboard } from '../domain/storyboard.js';
import { silentAudio, speechLengthWarning, type AudioPlan } from '../domain/audio.js';
import './audio.css';
import { useEffect, useState } from 'react';

function SoundEffects({ value, disabled, onChange }: { value: string[]; disabled: boolean; onChange(value: string[]): void }) {
  const serialized = value.join('\n'); const [raw, setRaw] = useState(serialized);
  useEffect(() => { if (raw.split('\n').map(s => s.trim()).filter(Boolean).join('\n') !== serialized) setRaw(serialized); }, [serialized]);
  return <label>音效（每行一个）<textarea aria-label="音效" value={raw} disabled={disabled} maxLength={5000} onChange={e => { setRaw(e.target.value); onChange(e.target.value.split('\n').map(s => s.trim()).filter(Boolean)); }} rows={2} placeholder="纸张摩擦声"/></label>;
}

type Role = Storyboard['characters'][number];
export function AudioEditor({ shot, characters, disabled, onChange }: { shot: Storyboard['shots'][number]; characters: Role[]; disabled: boolean; onChange(audio: AudioPlan): void }) {
  const audio = shot.audio ?? silentAudio(); const warning = speechLengthWarning(audio, shot.duration);
  const update = (patch: Partial<AudioPlan>) => onChange({ ...audio, ...patch });
  function line(index: number, patch: Partial<AudioPlan['dialogue'][number]>) { update({ dialogue: audio.dialogue.map((d, i) => i === index ? { ...d, ...patch } : d) }); }
  return <section className="audio-editor" aria-label={`${shot.title} 声音设计`}>
    <label>声音模式<select aria-label="声音模式" value={audio.mode} disabled={disabled} onChange={e => {
      const mode = e.target.value as AudioPlan['mode'];
      onChange(mode === 'silent' ? silentAudio() : { ...audio, mode, ...(mode === 'ambient' ? { dialogue: [], narration: null } : {}) });
    }}><option value="silent">完全静音</option><option value="ambient">仅环境声 / 音效</option><option value="speech">角色台词 / 旁白</option></select></label>
    {!shot.audio && <p className="muted">历史镜头未设置声音，沿用静音。</p>}
    {audio.mode !== 'silent' && <><label>环境声<textarea aria-label="环境声" value={audio.ambience} maxLength={1000} disabled={disabled} onChange={e => update({ ambience: e.target.value })} placeholder="例如：安静的室内底噪、窗外细雨" rows={2}/></label><SoundEffects value={audio.soundEffects} disabled={disabled} onChange={soundEffects => update({ soundEffects })}/></>}
    {audio.mode === 'speech' && <>
      {audio.dialogue.map((d, i) => <fieldset key={i} className="dialogue-line"><legend>角色台词 {i + 1}</legend><label>说话角色<select aria-label={`台词 ${i + 1} 说话角色`} value={d.characterId} disabled={disabled} onChange={e => line(i, { characterId: e.target.value })}><option value="">请选择角色</option>{characters.map(c => <option key={c.id} value={c.id}>@{c.name}</option>)}</select></label><label>发声位置<select aria-label={`台词 ${i + 1} 发声位置`} value={d.placement} disabled={disabled} onChange={e => line(i, { placement: e.target.value as 'on_screen' | 'off_screen' })}><option value="on_screen">画内说话（角色须出镜）</option><option value="off_screen">画外声音</option></select></label><label>准确台词<textarea aria-label={`台词 ${i + 1} 内容`} value={d.text} maxLength={2000} disabled={disabled} onChange={e => line(i, { text: e.target.value })} rows={2}/></label><label>语气 / 表达<input aria-label={`台词 ${i + 1} 语气`} value={d.delivery} maxLength={1000} disabled={disabled} onChange={e => line(i, { delivery: e.target.value })}/></label><button disabled={disabled} onClick={() => update({ dialogue: audio.dialogue.filter((_, j) => j !== i) })}>删除台词 {i + 1}</button></fieldset>)}
      <button disabled={disabled || audio.dialogue.length >= 20 || !characters.length} onClick={() => update({ dialogue: [...audio.dialogue, { characterId: shot.characterIds[0] ?? characters[0]?.id ?? '', text: '', delivery: '', placement: shot.characterIds.length ? 'on_screen' : 'off_screen' }] })}>添加角色台词</button>
      <label>旁白内容<textarea aria-label="旁白内容" value={audio.narration?.text ?? ''} maxLength={2000} disabled={disabled} onChange={e => update({ narration: e.target.value.trim() ? { text: e.target.value, delivery: audio.narration?.delivery ?? '' } : null })} placeholder="可留空；旁白发生在画外，不要求人物张嘴" rows={2}/></label>
      {audio.narration && <label>旁白语气<input aria-label="旁白语气" value={audio.narration.delivery} maxLength={1000} disabled={disabled} onChange={e => update({ narration: { ...audio.narration!, delivery: e.target.value } })}/></label>}
      {warning && <p className="notice">{warning}</p>}
      <p className="muted">台词与旁白按顺序发声。保存时检查角色绑定；原生生成的发音、口型与逐字准确性需试听确认。</p>
    </>}
  </section>;
}

export function VoiceProfiles({ board, characters, disabled, onChange }: { board: Storyboard; characters: Role[]; disabled: boolean; onChange(profile: NonNullable<Storyboard['audioProfile']>): void }) {
  const profile = board.audioProfile ?? { narratorVoice: '', characterVoices: [] };
  return <details className="voice-profiles"><summary>全片声音设定</summary><p className="muted">同一角色沿用声音描述。当前为原生音视频生成的提示约束，尚不保证跨镜头固定音色；本版不生成配乐。</p><label>旁白声音描述<input aria-label="旁白声音描述" value={profile.narratorVoice} maxLength={1000} disabled={disabled} onChange={e => onChange({ ...profile, narratorVoice: e.target.value })} placeholder="例如：温暖、克制的普通话女声"/></label>{characters.map(c => <label key={c.id}>@{c.name} · 声音描述<input aria-label={`${c.name} 声音描述`} value={profile.characterVoices.find(v => v.characterId === c.id)?.description ?? ''} maxLength={1000} disabled={disabled} onChange={e => onChange({ ...profile, characterVoices: [...profile.characterVoices.filter(v => v.characterId !== c.id && characters.some(role => role.id === v.characterId)), { characterId: c.id, description: e.target.value }] })}/></label>)}</details>;
}
