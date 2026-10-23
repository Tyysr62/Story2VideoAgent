import { useEffect, useState } from 'react';
import { api } from './api.js';
interface Frame { shotId: string; title: string; current: boolean; blocked?: string; entry?: { id: string; url?: string }; candidates: { id: string; current: boolean }[]; }
export interface M2View { revision: number; shots: Frame[]; manifestHash: string; approved: boolean; complete: boolean; imageModel: string; videoModel: string; }
interface Props { projectId: string; revision: number; refreshKey: string; disabled: boolean; dirty: boolean; rolesApproved: boolean; onBusyChange(busy: boolean): void; onChanged(): Promise<unknown>; }
export function Keyframes(props: Props) {
  const [view, setView] = useState<M2View>(); const [selected, setSelected] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [estimate, setEstimate] = useState<{ imageUsd: number | null; note: string; simulated: boolean }>(); const [consent, setConsent] = useState(false);
  const base = `/projects/${props.projectId}/m2`; const locked = props.disabled || props.dirty || busy || !props.rolesApproved;
  useEffect(() => { let stopped = false; api<M2View>(base).then(data => { if (!stopped) { setView(data); setSelected(current => current.length ? current : data.shots.filter(s => !s.current).map(s => s.shotId)); } }).catch(e => { if (!stopped) setError(e.message); }); return () => { stopped = true; }; }, [props.projectId, props.refreshKey]);
  useEffect(() => { setConsent(false); setEstimate(undefined); }, [selected.join(','), view?.manifestHash]);
  async function run(operation: () => Promise<unknown>) {
    if (locked) return; setBusy(true); props.onBusyChange(true); setError('');
    try { await operation(); await props.onChanged(); setView(await api<M2View>(base)); }
    catch (e) { setError(e instanceof Error ? e.message : '首帧操作失败'); await props.onChanged().catch(() => {}); }
    finally { setBusy(false); props.onBusyChange(false); }
  }
  return <section className="panel keyframes" aria-label="分镜首帧与视频">
    <div className="section-row"><h2>分镜首帧与视频</h2><span>{view?.approved ? '整组首帧已确认' : '整组首帧待确认'}</span></div>
    <p className="muted">先确认角色设定，再生成独立首帧。逐镜检查人物、场景和构图；整组首帧确认后才能生成视频。所有候选与 Prompt 都保留在项目生产库。</p>
    {!props.rolesApproved && <p className="notice">请先在角色库确认角色定稿。</p>}{props.dirty && <p className="notice">请先保存分镜修改，再生成或确认首帧。</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="production-grid">{view?.shots.map(s => <article className="production-entry" key={s.shotId} data-testid={`keyframe-${s.shotId}`}>
      {s.entry?.url ? <img src={s.entry.url} alt={`${s.title} 首帧`}/> : <p className="muted">尚无首帧</p>}
      <strong>{s.title}</strong><p className="muted">{s.blocked ? `输入阻塞：${s.blocked}` : s.current ? '当前可用' : s.entry ? '已过期，需要重做' : '缺失，等待生成'}</p>
      <label className="checkbox-label"><input type="checkbox" disabled={locked || Boolean(s.blocked)} checked={selected.includes(s.shotId)} onChange={e => setSelected(current => e.target.checked ? [...current, s.shotId] : current.filter(id => id !== s.shotId))}/>选择生成该镜头首帧</label>
      {!!s.candidates.length && <label>首帧历史版本<select aria-label={`${s.title} 首帧历史版本`} value={s.entry?.id ?? ''} disabled={locked} onChange={e => void run(() => api(`${base}/select`, 'POST', { revision: props.revision, shotId: s.shotId, entryId: e.target.value }))}>{s.candidates.map((c, i) => <option value={c.id} key={c.id} disabled={!c.current}>候选 {i + 1}{c.current ? '' : ' · 过期'}</option>)}</select></label>}
    </article>)}</div>
    <p className="muted">生图模型：{view?.imageModel ?? '加载中'}。已选 {selected.length} 个镜头；选择当前可用镜头会建立新候选。</p>
    <div className="actions"><button disabled={locked || !view} onClick={() => setSelected(view!.shots.filter(s => !s.current && !s.blocked).map(s => s.shotId))}>选择缺失／过期首帧</button><button disabled={locked || !selected.length} onClick={() => void run(async () => { setEstimate(await api(`${base}/estimate-frames`, 'POST', { shotIds: selected })); setConsent(false); })}>估算首帧费用</button></div>
    {estimate && <><p className="muted">{estimate.simulated ? '离线色卡，不调用付费 API' : `本次预计 $${estimate.imageUsd?.toFixed(4) ?? '未知，请核实供应商价格'}`}。{estimate.note}</p><label className="checkbox-label"><input type="checkbox" disabled={locked} checked={consent} onChange={e => setConsent(e.target.checked)}/>我确认本次首帧生成费用</label></>}
    <div className="actions"><button disabled={locked || !consent || !selected.length} onClick={() => void run(async () => { await api(`${base}/frames`, 'POST', { revision: props.revision, shotIds: selected, requestId: crypto.randomUUID(), acceptCost: consent, force: true }); setConsent(false); setSelected([]); })}>生成所选首帧</button><button disabled={locked || !view?.complete || view.approved} onClick={() => void run(() => api(`${base}/approve`, 'POST', { revision: props.revision, manifestHash: view!.manifestHash }))}>确认整组首帧</button></div>
  </section>;
}
