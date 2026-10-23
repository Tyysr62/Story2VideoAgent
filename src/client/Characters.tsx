import { useCallback, useEffect, useState } from 'react';
import './characters.css';
import type { Character, CharacterLibrary, Look } from '../domain/characters.js';
import type { Storyboard } from '../domain/storyboard.js';
import type { PortraitJob } from '../storage/portrait-jobs.js';
import { api, uploadPortrait } from './api.js';

interface Props {
  projectId: string; library: CharacterLibrary; storyboard: Storyboard | null; jobs: PortraitJob[];
  disabled: boolean; boardDirty: boolean; simulated: boolean; onChanged(): Promise<unknown>; onError(message: string): void;
  imageModel: string; onBusyChange(busy: boolean): void;
}
export function Characters(props: Props) {
  const { projectId, library } = props;
  const [busy, setBusy] = useState(false); const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const reportDraft = useCallback((key: string, dirty: boolean) => setDrafts(current => current[key] === dirty ? current : { ...current, [key]: dirty }), []);
  const hasDraft = Object.values(drafts).some(Boolean);
  const locked = props.disabled || busy || props.jobs.some(j => j.status === 'running');
  async function run(operation: () => Promise<unknown>) {
    if (locked) return; setBusy(true); props.onBusyChange(true); props.onError('');
    try { await operation(); await props.onChanged(); } catch (error) { props.onError(error instanceof Error ? error.message : '角色操作失败'); await props.onChanged().catch(() => {}); } finally { setBusy(false); props.onBusyChange(false); }
  }
  return <section className="panel character-library">
    <div className="section-row"><h2>角色库</h2><span className={`role-approval ${library.approval ? 'approved' : ''}`}>{library.approval ? '角色已定稿' : '角色待定稿'}</span></div>
    <p className="muted">身份与造型分别管理。青年、老年或换装可各自配置参考图；名称和历史别名始终指向同一身份。修改外观会撤销定稿，并影响引用它的镜头。</p>
    <div className="role-cards">{library.characters.map(character => <CharacterCard key={character.id} {...props} character={character} locked={locked} run={run} reportDraft={reportDraft}/>)}</div>
    <details className="add-character"><summary>＋ 添加角色</summary><div className="role-form"><label>新角色名称<input aria-label="新角色名称" value={name} disabled={locked} onChange={e => setName(e.target.value)}/></label><label>新角色身份描述<textarea aria-label="新角色身份描述" value={description} maxLength={2000} disabled={locked} onChange={e => setDescription(e.target.value)}/></label>
      <button disabled={locked || !name.trim() || !description.trim()} onClick={() => void run(async () => { await api(`/projects/${projectId}/characters`, 'POST', { revision: library.revision, name, description }); setName(''); setDescription(''); })}>添加角色</button></div></details>
    <div className="role-confirm"><p className="muted">参考图支持静态 PNG / JPEG / WebP，最大 10 MiB、4096×4096。上传后若镜头显示旧引用，请先更新引用并保存分镜。无人物故事可直接确认空角色库。</p>
      <button disabled={locked || hasDraft || props.boardDirty || Boolean(library.approval)} onClick={() => void run(() => api(`/projects/${projectId}/characters/approve`, 'POST', { revision: library.revision }))}>确认角色定稿</button>{hasDraft && <small>请先保存角色或造型修改</small>}</div>
    {props.jobs.filter(j => j.status !== 'succeeded').map(job => <p className="muted" role="status" key={job.id}>角色生图 · {job.status === 'running' ? '执行中' : job.status === 'unknown' ? '状态待核实，已阻止自动重提' : '失败'}{job.error && `：${job.error}`}</p>)}
  </section>;
}
type CardProps = Props & { character: Character; locked: boolean; run(operation: () => Promise<unknown>): Promise<void>; reportDraft(key: string, dirty: boolean): void };
function CharacterCard(props: CardProps) {
  const { character, library, projectId, locked, run } = props;
  const [name, setName] = useState(character.name); const [aliases, setAliases] = useState(character.aliases.join('、')); const [description, setDescription] = useState(character.description); const [dirty, setDirty] = useState(false);
  const identity = JSON.stringify([character.name, character.aliases, character.description]); const [editIdentity, setEditIdentity] = useState(identity);
  const conflict = dirty && editIdentity !== identity;
  const beginEdit = () => { if (!dirty) setEditIdentity(identity); setDirty(true); };
  const [lookName, setLookName] = useState(''); const [lookDescription, setLookDescription] = useState('');
  useEffect(() => { props.reportDraft(`${character.id}:identity`, dirty); return () => props.reportDraft(`${character.id}:identity`, false); }, [dirty, character.id, props.reportDraft]);
  useEffect(() => { if (!dirty) { setName(character.name); setAliases(character.aliases.join('、')); setDescription(character.description); } }, [character.name, character.description, character.aliases.join('、'), dirty]);
  const base = `/projects/${projectId}/characters/${character.id}`;
  const affected = props.storyboard?.shots.filter(s => s.characterRefs?.some(r => r.characterId === character.id)) ?? [];
  return <article className="character-card" data-testid={`character-${character.id}`}>
    <div className="section-row"><h3>{character.name}</h3><small className="muted">影响镜头：{affected.length ? affected.map(s => s.title).join('、') : '暂无引用'}</small></div>
    <div className="role-form"><label>角色名称<input aria-label="角色名称" value={name} maxLength={100} disabled={locked} onChange={e => { setName(e.target.value); beginEdit(); }}/></label><label>角色别名<input aria-label="角色别名" value={aliases} disabled={locked} onChange={e => { setAliases(e.target.value); beginEdit(); }} placeholder="以顿号或逗号分隔，历史别名会保留"/></label><label className="wide">角色身份描述<textarea aria-label="角色身份描述" value={description} maxLength={2000} disabled={locked} onChange={e => { setDescription(e.target.value); beginEdit(); }}/></label></div>
    {conflict && <p className="notice">角色已在其他窗口更新，本地修改已保留。<button disabled={locked} onClick={() => { setName(character.name); setAliases(character.aliases.join('、')); setDescription(character.description); setEditIdentity(identity); setDirty(false); }}>载入当前角色设定</button></p>}
    <div className="actions"><button disabled={locked || !dirty || conflict} onClick={() => void run(async () => { await api(base, 'PATCH', { revision: library.revision, name, aliases: aliases.split(/[、,，\n]/).map(x => x.trim()).filter(Boolean), description }); setDirty(false); })}>保存角色</button><button disabled={locked || affected.length > 0} title={affected.length ? '先移除镜头引用，再删除角色' : '删除角色'} onClick={() => void run(() => api(base, 'DELETE', { revision: library.revision }))}>删除角色</button></div>
    {character.looks.map(look => <LookCard key={look.id} {...props} look={look} identityDirty={dirty}/>)}
    <details className="add-look"><summary>＋ 添加造型 / 年龄阶段</summary><div className="role-form"><label>新造型名称<input aria-label="新造型名称" value={lookName} disabled={locked} onChange={e => setLookName(e.target.value)} placeholder="例如：青年、老年、冬装"/></label><label>新造型描述<textarea aria-label="新造型描述" value={lookDescription} maxLength={2000} disabled={locked} onChange={e => setLookDescription(e.target.value)} placeholder="脸型、发型、年龄、服装配色、标志物与禁止变化项"/></label><button disabled={locked || dirty || !lookName.trim() || !lookDescription.trim()} onClick={() => void run(async () => { await api(`${base}/looks`, 'POST', { revision: library.revision, name: lookName, description: lookDescription }); setLookName(''); setLookDescription(''); })}>添加造型</button></div></details>
  </article>;
}
function LookCard(props: CardProps & { look: Look; identityDirty: boolean }) {
  const { character, look, projectId, library, run } = props;
  const version = look.versions.find(v => v.id === look.selectedVersionId)!;
  const [description, setDescription] = useState(version.description); const [dirty, setDirty] = useState(false);
  const [editVersion, setEditVersion] = useState(version.id); const conflict = dirty && editVersion !== version.id;
  const [estimate, setEstimate] = useState<{ imageUsd: number | null; note?: string }>(); const [consent, setConsent] = useState(false);
  const [portraitError, setPortraitError] = useState(''); const [generating, setGenerating] = useState(false);
  useEffect(() => { props.reportDraft(`${character.id}:${look.id}`, dirty); return () => props.reportDraft(`${character.id}:${look.id}`, false); }, [dirty, character.id, look.id, props.reportDraft]);
  useEffect(() => { if (!dirty) { setDescription(version.description); setEditVersion(version.id); } setConsent(false); setEstimate(undefined); }, [version.id]);
  const locked = props.locked || props.identityDirty; const base = `/projects/${projectId}/characters/${character.id}/looks/${look.id}`;
  const job = [...props.jobs].reverse().find(j => j.lookId === look.id && j.assetId === version.imageAssetId);
  const latestJob = [...props.jobs].reverse().find(j => j.lookId === look.id);
  useEffect(() => { setPortraitError(''); }, [latestJob?.id, latestJob?.status, version.id]);
  const failure = portraitError || (latestJob?.lookVersionId === version.id && ['failed', 'unknown'].includes(latestJob.status) ? latestJob.error || '角色图片生成未完成，请核实任务状态' : '');
  const affected = props.storyboard?.shots.filter(s => s.characterRefs?.some(r => r.lookId === look.id)) ?? [];
  return <div className="look-card" data-testid={`look-${look.name}`}>
    <div className="look-image">{version.imageAssetId ? <img src={`/api/projects/${projectId}/character-images/${version.imageAssetId}`} alt={`${character.name} ${look.name} 主参考图`}/> : <span>尚无参考图</span>}</div>
    <div className="look-editor"><h4>{look.name} <small>{look.default ? '默认造型' : '独立造型'} · V{look.versions.findIndex(v => v.id === version.id) + 1}</small></h4>
      {(generating || latestJob?.status === 'running') && <p className="muted" role="status">正在生成角色候选图，请等待。请勿重复提交。</p>}
      {failure && !generating && latestJob?.status !== 'running' && <p className="notice error" role="alert">候选图生成未成功：{failure}</p>}
      <label>造型描述<textarea aria-label="造型描述" value={description} maxLength={2000} disabled={locked} onChange={e => { if (!dirty) setEditVersion(version.id); setDescription(e.target.value); setDirty(true); }}/></label>
      {conflict && <p className="notice">造型已在其他窗口更新，本地修改已保留。<button disabled={locked} onClick={() => { setDescription(version.description); setEditVersion(version.id); setDirty(false); }}>载入当前造型版本</button></p>}
      <p className="muted">影响：{affected.length ? affected.map(s => s.title).join('、') : '暂无镜头引用'}。外观变化将撤销角色定稿，旧素材保留。</p>
      <div className="actions"><button disabled={locked || !dirty || conflict} onClick={() => void run(async () => { await api(base, 'PATCH', { revision: library.revision, description }); setDirty(false); })}>保存造型</button>
        <button disabled={locked || dirty || Boolean(look.default)} onClick={() => void run(() => api(base, 'PATCH', { revision: library.revision, default: true }))}>设为默认</button>
        <button disabled={locked || affected.length > 0} onClick={() => void run(() => api(base, 'DELETE', { revision: library.revision }))}>删除造型</button></div>
      <label className="upload-label">上传参考图<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`${character.name} ${look.name} 上传参考图`} disabled={locked || dirty} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => uploadPortrait(`${base}/image`, library.revision, file)); }}/></label>
      <details className="portrait-controls"><summary>AI 生成候选图 · {props.simulated ? '离线测试' : 'OpenRouter API'}</summary>
        <p className="muted">模型：{props.imageModel}。按已保存的身份、造型与全局画风生成一张单人图；生成后仍需你定稿。</p>
        <button disabled={locked || dirty} onClick={() => void run(async () => { setEstimate(await api(`/projects/${projectId}/portrait-estimate`)); setConsent(false); })}>查询生图费用</button>
        {estimate && <><p className="muted">{props.simulated ? '测试替身，不调用付费 API' : `单张预计 $${estimate.imageUsd?.toFixed(4) ?? '未知，请核实供应商价格'}`}。{estimate.note}</p><label className="checkbox-label"><input type="checkbox" checked={consent} disabled={locked || dirty} onChange={e => setConsent(e.target.checked)}/>我确认本次生图费用</label><button disabled={locked || dirty || !consent} onClick={() => void run(async () => {
          setPortraitError(''); setGenerating(true);
          try { const result = await api<PortraitJob>(`${base}/portrait`, 'POST', { revision: library.revision, requestId: crypto.randomUUID(), acceptCost: consent }); if (result.status !== 'succeeded') throw new Error(result.error ?? '角色图片生成未完成'); }
          catch (error) { setPortraitError(error instanceof Error ? error.message : '角色图片生成失败'); throw error; }
          finally { setConsent(false); setGenerating(false); }
        })}>生成角色候选图</button></>}
      </details>
      {(job?.status === 'succeeded' && version.imageAssetId && props.simulated) && <p className="muted">测试候选图 · 非真实 AI</p>}
      <label className="version-select">历史版本<select aria-label={`${character.name} ${look.name} 历史版本`} disabled={locked || dirty} value={version.id} onChange={e => void run(() => api(`${base}/select-version`, 'POST', { revision: library.revision, versionId: e.target.value }))}>{look.versions.map((v, index) => <option key={v.id} value={v.id}>V{index + 1} · {v.source === 'generated' ? '生成' : v.source === 'upload' ? '上传' : '文字草案'} · {v.description.slice(0, 18)}</option>)}</select></label>
    </div>
  </div>;
}
