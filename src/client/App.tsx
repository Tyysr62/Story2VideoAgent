import { useEffect, useRef, useState } from 'react';
import type { Project, Job, Artifact, ProjectEvent, Storyboard } from '../domain/storyboard.js';
import type { CharacterLibrary } from '../domain/characters.js';
import type { PortraitJob } from '../storage/portrait-jobs.js';
import { Characters } from './Characters.js';
import { CharacterReferences } from './CharacterReferences.js';
import { api } from './api.js';
import { describeEvent } from './event-labels.js';
import { ProductionLibrary } from './ProductionLibrary.js';
import { Keyframes } from './Keyframes.js';
import { AudioEditor, VoiceProfiles } from './AudioEditor.js';

type Asset = Omit<Artifact, 'path'> & { url: string };
type Detail = { project: Project; jobs: Job[]; artifacts: Asset[]; events: ProjectEvent[]; characterLibrary?: CharacterLibrary; portraitJobs?: PortraitJob[] };
type Config = { plannerConfigured: boolean; mediaConfigured: boolean; simulated: boolean; plannerModel: string; imageModel: string; videoModel: string; resolution: string; m2Enabled?: boolean };
type Estimate = { videoUsd: number | null; imageUsd: number | null; seconds: number; checkedAt?: string; note?: string; simulated?: boolean };
const statuses: Record<string, string> = { draft: '草稿', planning: '规划中', awaiting_approval: '待确认', approved: '已确认', generating: '生成中', ready: '已成片', failed: '执行失败', queued: '等待', running: '执行中', succeeded: '完成', unknown: '状态待核实' };
const kinds: Record<string, string> = { image: '图像', video: '视频', compose: '成片' };
const clone = <T,>(value: T): T => structuredClone(value);
export function App() {
  const [config, setConfig] = useState<Config>(); const [projects, setProjects] = useState<Project[]>([]);
  const [id, setId] = useState<string | null>(null); const [detail, setDetail] = useState<Detail>();
  const [draft, setDraft] = useState<Storyboard | null>(null); const [dirty, setDirty] = useState(false);
  const [story, setStory] = useState(''); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [estimate, setEstimate] = useState<Estimate>();
  const [newV2, setNewV2] = useState<boolean | null>(null);
  const [roleBusy, setRoleBusy] = useState(false); const [roleDraft, setRoleDraft] = useState(false); const selectedProject = useRef<string | null>(null);
  const refreshList = async () => setProjects(await api<Project[]>('/projects'));
  async function load(projectId: string, reset = false) {
    const d = await api<Detail>(`/projects/${projectId}`); if (selectedProject.current !== projectId) return d; setDetail(d);
    if (reset) { setDraft(d.project.storyboard ? clone(d.project.storyboard) : null); setDirty(false); setEstimate(undefined); }
    return d;
  }
  useEffect(() => { Promise.all([api<Config>('/config').then(setConfig), refreshList()]).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    const timer = setInterval(() => {
      api<Detail>(`/projects/${id}`).then(d => { if (!stopped && selectedProject.current === id) { setDetail(d); void refreshList(); } }).catch(e => { if (!stopped && selectedProject.current === id) setError(e.message); });
    }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [id]);
  async function action(label: string, fn: () => Promise<void>) {
    if (busy) return; setBusy(label); setError('');
    try { await fn(); await refreshList(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(''); }
  }
  async function select(projectId: string) { await action('加载', async () => { selectedProject.current = projectId; await load(projectId, true); setId(projectId); }); }
  function edit(change: (b: Storyboard) => void) { if (!draft) return; const b = clone(draft); change(b); setDraft(b); setDirty(true); setEstimate(undefined); }
  const project = detail?.project;
  const active = project?.status === 'generating' || project?.status === 'planning' || detail?.portraitJobs?.some(j => j.status === 'running');
  const locked = Boolean(busy || active || roleBusy);
  const currentJobs = detail?.jobs.filter(j => j.revision === project?.revision) || [];
  const completed = currentJobs.filter(j => j.status === 'succeeded').length;
  const final = detail?.artifacts.find(a => a.id === project?.finalArtifactId);
  const asset = (shotId: string, kind: string) => detail?.artifacts.find(a => a.revision === project?.revision && a.shotId === shotId && a.kind === kind);
  const v2 = project?.workflowVersion === 2;
  const library = detail?.characterLibrary;
  const currentBoard = () => draft && v2 && library ? { ...draft, characters: library.characters.map(c => ({ id: c.id, name: c.name, description: c.description })) } : draft;
  return <div className="studio">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Story Agent 首页"><span className="brand-icon">S<span>✦</span></span><span>STORY AGENT<small>让故事，发生。</small></span></a>
      <button className="new-project" disabled={Boolean(busy || roleBusy)} onClick={() => { selectedProject.current = null; setId(null); setDetail(undefined); setDraft(null); setDirty(false); setError(''); setEstimate(undefined); }}>＋ 新建故事</button>
      <p className="eyebrow">你的创作</p>
      <nav className="project-list" aria-label="故事列表">{projects.length ? projects.map(p => <button key={p.id} className={id === p.id ? 'selected' : ''} disabled={Boolean(busy || roleBusy)} onClick={() => void select(p.id)}><span>{p.storyboard?.title || p.story.slice(0, 22)}</span><small><i className={`dot ${p.status}`}/>{statuses[p.status]} · V{p.revision}</small></button>) : <p className="empty-list">第一个故事，从这里开始。</p>}</nav>
      <div className="sidebar-bottom"><span className="pill">V2 / M2 · 生产库与首帧</span><p>Pi Agent 驱动规划<br/>云端生成 · 本地合成</p></div>
    </aside>
    <main>
      <header className="topbar"><span>创作工作室 <span className="slash">/</span> {project ? '故事分镜' : '新建故事'}</span><span className="connection"><i className="dot ready"/>{config?.simulated ? '离线演示' : 'OpenRouter API'}</span></header>
      <div className="workspace">
        {config?.simulated && <div className="notice demo">离线联调模式：分镜由固定脚本返回，图像与视频是测试色卡，均非真实 AI 生成。</div>}
        {config && (!config.plannerConfigured || !config.mediaConfigured) && <div className="notice">尚未配置 API 密钥。请在项目的 <code>.env.local</code> 中填写 <code>OPENROUTER_API_KEY</code>，然后重启服务。密钥只保留在本地。</div>}
        {error && <div className="notice error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
        {!project ? <section className="intro">
          <div className="section-kicker">FROM A SPARK TO A STORY</div>
          <h1>每一个故事，<br/>都值得被看见<span>。</span></h1>
          <p className="lead">写下一个灵感。导演 Agent 会安排节奏、角色与镜头，<br className="desktop-break"/>由你确认分镜，再把文字变成画面。</p>
          <div className="story-input"><label htmlFor="story">你的故事 / 创作要求</label><textarea id="story" value={story} maxLength={20000} onChange={e => setStory(e.target.value)} placeholder="例如：一只小狐狸在月光下经营邮局，某天收到一封寄给太阳的信。温暖的手绘风格，适合一分钟短片。" rows={6}/><div className="input-bottom"><span>AI 自主决定镜头数量，最多 20 个</span><button className="primary" disabled={locked || !story.trim() || !config?.plannerConfigured} onClick={() => void action('规划分镜', async () => {
            const p = await api<Project>('/projects', 'POST', { story, workflowVersion: (newV2 ?? !config?.simulated) ? 2 : 1 }); selectedProject.current = p.id; setId(p.id); await load(p.id, true);
            await api(`/projects/${p.id}/plan`, 'POST', { revision: p.revision }); await load(p.id, true);
          })}>{busy ? `${busy}…` : '开始规划分镜 ↗'}</button></div></div>
          <label className="checkbox-label workflow-choice"><input type="checkbox" checked={newV2 ?? !config?.simulated} onChange={e => setNewV2(e.target.checked)} disabled={locked}/>启用角色参考（V2）<small>角色参考 → 首帧审阅 → 图生视频；取消选择可使用原 V1 成片流程。</small></label>
          <div className="steps"><div><b>01</b><span>写下故事<small>描述情节与创作意图</small></span></div><div><b>02</b><span>打磨分镜<small>查看、编辑并确认版本</small></span></div><div><b>03</b><span>生成成片<small>云端生成，自动拼接</small></span></div></div>
        </section> : <>
          <div className="project-heading"><div><div className="section-kicker">YOUR STORY, FRAME BY FRAME</div><h1>{project.storyboard?.title || '新的故事'}</h1><p className="muted">V{project.revision} <span className="separator">·</span> {statuses[project.status]} <span className="separator">·</span> {draft?.shots.length || 0} / 20 镜头{dirty && ' · 有未保存修改'}</p></div><button className="subtle" disabled={locked || dirty || !config?.plannerConfigured} onClick={() => void action('重新规划', async () => { await api(`/projects/${id}/plan`, 'POST', { revision: project.revision }); await load(id!, true); })}>重新规划</button></div>
          <details className="brief"><summary>创作原文</summary><p>{project.story}</p></details>
          {!v2 && <div className="notice">当前为 V1 项目，视频尚无角色参考约束。<button disabled={locked || dirty} onClick={() => void action('启用角色参考', async () => { await api(`/projects/${id}/enable-v2`, 'POST', { revision: project.revision }); await load(id!, true); })}>启用角色参考 V2</button></div>}
          {v2 && <div className="notice">参考图驱动首帧，再以已确认首帧生成视频。请依次完成角色定稿、首帧审阅与视频费用确认；生成历史保留在项目生产库。</div>}
          {project.error && <div className="notice error">{project.error}</div>}
          {project.status === 'planning' && <div className="panel progress-panel">导演正在规划角色、节奏和分镜，请稍候…</div>}
          {!draft && project.storyboard && <button onClick={() => void load(id!, true)}>载入最新分镜</button>}
          {v2 && library && <Characters key={project.id} projectId={project.id} library={library} storyboard={draft} jobs={detail?.portraitJobs ?? []} disabled={locked} boardDirty={dirty} simulated={Boolean(config?.simulated)} imageModel={config?.imageModel ?? '待加载'} onBusyChange={setRoleBusy} onDraftChange={setRoleDraft} onChanged={() => load(project.id)} onError={setError}/>}
          {draft && <>
            <section className="board-meta panel"><label>故事标题<input aria-label="故事标题" value={draft.title} disabled={locked} onChange={e => edit(b => { b.title = e.target.value; })}/></label><label>视觉风格<input aria-label="视觉风格" value={draft.style} disabled={locked} onChange={e => edit(b => { b.style = e.target.value; })}/></label><div className="characters"><span className="muted">角色设定</span>{(v2 && library ? library.characters : draft.characters).map(c => <span key={c.id} title={c.description}>{c.name}<small>{c.description}</small></span>)}</div></section>
            {v2 && library && <button disabled={locked} onClick={() => edit(b => { for (const shot of b.shots) { shot.characterRefs = (shot.characterRefs ?? []).map(ref => { const c = library.characters.find(c => c.id === ref.characterId); const look = c?.looks.find(l => l.id === ref.lookId); return look ? { ...ref, lookVersionId: look.selectedVersionId } : ref; }); shot.characterIds = [...new Set(shot.characterRefs.map(r => r.characterId))]; } })}>更新镜头引用到当前造型版本</button>}
            <VoiceProfiles board={draft} characters={v2 && library ? library.characters : draft.characters} disabled={locked} onChange={profile => edit(b => { b.audioProfile = profile; })}/>
            <div className="section-row"><h2>故事分镜 <span>{draft.shots.length.toString().padStart(2, '0')}</span></h2><span className="muted">确认前可编辑每个镜头</span></div>
            <div className="shot-grid">{draft.shots.map((shot, index) => { const img = asset(shot.id, 'image'); const video = asset(shot.id, 'video'); return <article className="shot-card" key={shot.id}>
              <div className="shot-preview">{video ? <video controls preload="metadata" src={video.url} poster={img?.url} aria-label={`镜头 ${index + 1} 视频`}/> : img ? <img src={img.url} alt={`镜头 ${index + 1} 预览`}/> : <div className="preview-placeholder"><span>▧</span><small>等待生成画面</small></div>}<span className="shot-number">{String(index + 1).padStart(2, '0')}</span><span className="duration">{shot.duration}s</span></div>
              <div className="shot-body"><input className="shot-title" aria-label={`镜头 ${index + 1} 标题`} value={shot.title} disabled={locked} onChange={e => edit(b => { b.shots[index].title = e.target.value; })}/><textarea aria-label={`镜头 ${index + 1} 描述`} rows={3} value={shot.description} disabled={locked} onChange={e => edit(b => { b.shots[index].description = e.target.value; })}/><div className="shot-settings"><label>运镜<input aria-label={`镜头 ${index + 1} 运镜`} value={shot.camera} disabled={locked} onChange={e => edit(b => { b.shots[index].camera = e.target.value; })}/></label><label className="seconds">时长 / 秒<input aria-label={`镜头 ${index + 1} 时长`} type="number" min="1" max="60" step="1" value={shot.duration} disabled={locked} onChange={e => edit(b => { b.shots[index].duration = Number(e.target.value); })}/></label></div><details><summary>生成提示词</summary><label>图像提示词<textarea value={shot.imagePrompt} disabled={locked} onChange={e => edit(b => { b.shots[index].imagePrompt = e.target.value; })}/></label><label>视频提示词<textarea value={shot.videoPrompt} disabled={locked} onChange={e => edit(b => { b.shots[index].videoPrompt = e.target.value; })}/></label></details>
              {v2 && library && <CharacterReferences key={`${project.id}:${shot.id}`} projectId={project.id} library={library} refs={shot.characterRefs ?? []} index={index} disabled={locked} onChange={refs => edit(b => { b.shots[index].characterRefs = refs; b.shots[index].characterIds = [...new Set(refs.map(r => r.characterId))]; })}/>}
              <AudioEditor shot={shot} characters={v2 && library ? library.characters : draft.characters} disabled={locked} onChange={audio => edit(b => { b.shots[index].audio = audio; })}/>
              {currentJobs.filter(j => j.shotId === shot.id).map(j => <span className={`job-state ${j.status}`} key={j.id}>{kinds[j.kind]} · {statuses[j.status]}{j.error && <small>{j.error}</small>}</span>)}</div>
            </article>; })}</div>
            <section className="approval-bar panel"><div><strong>{v2 ? (dirty ? '请保存分镜修改' : '角色与分镜已保存，请在下方审阅首帧') : dirty ? '保存修改后，重新确认当前版本' : project.approvedRevision === project.revision ? `已确认 V${project.revision}` : '分镜准备好了？'} </strong><p>{v2 ? '角色定稿在上方完成，首帧与视频在下方继续；历史内容保留在项目生产库。' : '镜头时长须符合当前视频模型目录；费用以供应商实际账单为准。'}</p>{estimate && <p className="estimate" role="status">{estimate.simulated ? '测试素材 · 不调用付费 API' : `预计视频 $${estimate.videoUsd?.toFixed(3) ?? '未知'} + 图像 ${estimate.imageUsd === null ? '价格待核实' : '$' + estimate.imageUsd.toFixed(3)}`}{estimate.note && <small>{estimate.note}</small>}</p>}</div><div className="actions">
              <button disabled={locked || !dirty} onClick={() => void action('保存', async () => { await api(`/projects/${id}/storyboard`, 'PUT', { revision: project.revision, storyboard: currentBoard() }); await load(id!, true); })}>保存分镜</button>
              {!v2 && <><button disabled={locked || dirty || !config?.mediaConfigured} onClick={() => void action('查询报价', async () => setEstimate(await api<Estimate>(`/projects/${id}/estimate`)))}>估算费用</button>
              <button disabled={locked || dirty || project.approvedRevision === project.revision} onClick={() => void action('确认', async () => { await api(`/projects/${id}/approve`, 'POST', { revision: project.revision }); await load(id!); })}>确认 V{project.revision}</button>
              <button className="primary" disabled={locked || dirty || !config?.mediaConfigured || project.approvedRevision !== project.revision || project.status === 'ready'} onClick={() => void action('提交生成', async () => { await api(`/projects/${id}/generate`, 'POST', { revision: project.revision }); await load(id!); })}>{project.status === 'ready' ? '已生成成片' : config?.simulated ? '生成测试成片 ↗' : '调用 API 生成 ↗'}</button></>}
            </div></section>
          </>}
          {currentJobs.length > 0 && <section className="panel progress-panel"><div className="section-row"><h2>执行进度</h2><span>{completed} / {currentJobs.length} 任务完成</span></div><progress value={completed} max={currentJobs.length}/><p className="muted">已完成素材自动复用。提交状态不明时会暂停，避免重复计费。</p></section>}
          {final && <section className="panel final-panel"><div className="section-row"><h2>成片预览</h2><a className="download" href={`${final.url}?download=1`}>下载 MP4 ↓</a></div><video controls preload="metadata" src={final.url} aria-label="成片预览"/><p className="muted">{final.simulated ? '测试素材合成 · 非真实 AI 成片' : '云端视频生成 · FFmpeg 本地合成 · V1 静音输出'}</p></section>}
          {!!detail?.events.length && <details className="event-log"><summary>执行记录 · {detail.events.length}</summary>{detail.events.slice(-20).reverse().map(e => <div key={e.id}><time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{describeEvent(e, { jobs: detail.jobs, portraitJobs: detail.portraitJobs, characterLibrary: library, storyboard: project.storyboard })}</span></div>)}</details>}
        </>}
        {project && v2 && project.storyboard && config?.m2Enabled && <Keyframes key={`frames-${project.id}`} projectId={project.id} revision={project.revision} refreshKey={JSON.stringify([project.revision, project.status, library?.revision, detail?.events.at(-1)?.id])} disabled={locked} dirty={dirty || roleDraft} rolesApproved={Boolean(library?.approval)} onBusyChange={setRoleBusy} onChanged={() => load(project.id)}/>}
        {project && <ProductionLibrary key={project.id} projectId={project.id} refreshKey={JSON.stringify([project.revision, project.status, library?.revision, detail?.events.at(-1)?.id])}/>}
        <footer><span>STORY AGENT / {v2 ? 'V2 · M2' : 'V1'}</span><span>{config?.simulated ? 'OFFLINE FIXTURES' : `${config?.videoModel || '…'} · ${config?.resolution || '…'}`}</span></footer>
      </div>
    </main>
  </div>;
}
