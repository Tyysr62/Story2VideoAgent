import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { M2View } from './Keyframes.js';
export function VideoControls({ base, view, disabled, dirty, run }: { base: string; view: M2View; disabled: boolean; dirty: boolean; run(fn: () => Promise<unknown>): Promise<void> }) {
  const [selected, setSelected] = useState<string[]>([]); const [estimate, setEstimate] = useState<{ videoUsd: number | null; note: string; simulated: boolean }>(); const [consent, setConsent] = useState(false);
  useEffect(() => { setSelected(current => current.length ? current.filter(id => view.shots.some(s => s.shotId === id)) : view.shots.filter(s => !s.videoCurrent).map(s => s.shotId)); }, [view.shots.map(s => `${s.shotId}:${s.videoCurrent}`).join(',')]);
  useEffect(() => { setConsent(false); setEstimate(undefined); }, [selected.join(','), view.manifestHash, dirty]);
  const locked = disabled || !view.approved; const canGenerate = !locked && (view.transportConfigured || selected.length > 0 && selected.every(id => view.shots.some(s => s.shotId === id && (s.videoCurrent || s.videoResumable))));
  return <div className="video-controls">
    <h3>首帧驱动视频</h3><p className="muted">模型：{view.videoModel}。可先选择一个镜头试跑。已有可用视频会复用；全部当前片段齐备后按分镜顺序合成。</p>
    <p className="muted">声音按已保存的分镜计划生成，修改台词后请重新确认清单。请试听中文发音与口型；原生音色描述尚不保证跨镜头固定声线。生产库保留云端原片，静音策略在最终合成时执行。</p>
    {!view.transportConfigured && <p className="notice">请在 .env.local 配置自有 S3 兼容对象存储并重启服务，再提交视频。首帧通过限时签名地址传给云端，密钥不进入页面。</p>}
    <div className="production-grid">{view.shots.map(s => <article className="production-entry" key={s.shotId}>{s.video?.url && <video src={s.video.url} preload="none" controls aria-label={`${s.title} 视频片段`}/>}<strong>{s.title}</strong><p className="muted">{s.videoCurrent ? '视频当前可用' : s.video ? '旧视频已过期' : '视频待生成'}</p>{s.videoError && <p className="notice error">{s.videoError}</p>}<label className="checkbox-label"><input type="checkbox" checked={selected.includes(s.shotId)} disabled={locked} onChange={e => setSelected(current => e.target.checked ? [...current, s.shotId] : current.filter(id => id !== s.shotId))}/>选择{s.title}视频</label></article>)}</div>
    <p className="muted">已选 {selected.length} 个镜头。目录估算包含所选镜头；实际执行会跳过已完成片段，或继续查询已保存的云任务。</p>
    <div className="actions"><button disabled={locked} onClick={() => setSelected(view.shots.filter(s => !s.videoCurrent).slice(0, 1).map(s => s.shotId))}>仅选择一个未完成镜头试跑</button><button disabled={locked} onClick={() => setSelected(view.shots.map(s => s.shotId))}>选择全部镜头视频</button><button disabled={locked || !selected.length} onClick={() => void run(async () => { setEstimate(await api(`${base}/estimate-videos`, 'POST', { shotIds: selected })); setConsent(false); })}>估算所选视频费用</button></div>
    {estimate && <><p className="muted">{estimate.simulated ? '离线测试，无模型或存储费用' : `本次预计 $${estimate.videoUsd?.toFixed(4) ?? '未知，请先核实供应商价格'}`}。{estimate.note}</p><label className="checkbox-label"><input type="checkbox" disabled={locked} checked={consent} onChange={e => setConsent(e.target.checked)}/>我确认本次视频生成费用</label></>}
    <button className="primary" disabled={!canGenerate || !consent || !selected.length} onClick={() => void run(async () => { await api(`${base}/videos`, 'POST', { revision: view.revision, manifestHash: view.manifestHash, shotIds: selected, requestId: crypto.randomUUID(), acceptCost: consent }); setConsent(false); setSelected([]); })}>生成所选视频并合成</button>
  </div>;
}
