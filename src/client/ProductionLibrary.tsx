import { useEffect, useState } from 'react';
import type { ProductionEntry } from '../production/store.js';
import { api } from './api.js';
import './production.css';

type Entry = Omit<ProductionEntry, 'file'> & { file?: { mime: string; bytes: number; sha256: string }; url?: string };
const states = { running: '生成中', succeeded: '已保存', failed: '生成失败', unknown: '状态待核实' };
const kinds: Record<string, string> = { storyboard: '分镜版本', prompt: 'Prompt', portrait: '角色图', upload: '上传参考图', image: '镜头预览图', keyframe: '分镜首帧', video: '视频片段', compose: '合成成片' };
export function ProductionLibrary({ projectId, refreshKey }: { projectId: string; refreshKey: string }) {
  const [data, setData] = useState<{ project: { title: string }; entries: Entry[] }>(); const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); const [search, setSearch] = useState(''); const [limit, setLimit] = useState(30);
  useEffect(() => { let stopped = false; api<typeof data>(`/projects/${projectId}/production`).then(value => { if (!stopped) { setData(value); setError(''); } }).catch(e => { if (!stopped) setError(e.message); }); return () => { stopped = true; }; }, [projectId, refreshKey]);
  const entries = [...(data?.entries ?? [])].reverse().filter(e => (filter === 'all' || filter === 'image' && e.file?.mime.startsWith('image/') || filter === 'video' && e.file?.mime.startsWith('video/') || filter === 'prompt' && ['prompt', 'storyboard'].includes(e.kind)) && `${e.label}\n${e.prompt ?? ''}\n${e.model ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="panel production-library" aria-label="项目生产库">
    <div className="section-row"><h2>项目生产库</h2><a className="download" href={`/api/projects/${projectId}/production/export`}>导出项目生产库 ZIP</a></div>
    <p className="muted">「{data?.project.title ?? '当前项目'}」· {data?.entries.length ?? 0} 条生产记录。图片、视频、Prompt 与分镜历史全部保留；重新生成不会覆盖旧版。</p>
    <p className="muted">ZIP 包含当前快照的原文件、Prompt 和版本清单；失败、未完成、缺失或校验异常会在清单中标明。</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="production-filters"><label>生产内容类型<select aria-label="生产内容类型" value={filter} onChange={e => { setFilter(e.target.value); setLimit(30); }}><option value="all">全部生产内容</option><option value="image">图片</option><option value="video">视频</option><option value="prompt">Prompt 与分镜</option></select></label><label>搜索生产内容<input aria-label="搜索生产内容" value={search} onChange={e => { setSearch(e.target.value); setLimit(30); }} placeholder="名称、Prompt 或模型"/></label></div>
    <div className="production-grid">{entries.slice(0, limit).map(entry => <article key={entry.id} data-testid="production-entry" className="production-entry">
      {entry.file?.mime.startsWith('image/') && <img loading="lazy" src={entry.url} alt={entry.label}/>}
      {entry.file?.mime.startsWith('video/') && <video controls preload="none" src={entry.url} aria-label={entry.label}/>}
      <strong>{entry.label}</strong><p className="muted">{kinds[entry.kind] ?? '生产记录'} · {states[entry.status]}{entry.simulated && ' · 离线测试'}{entry.legacy && ' · 历史回收'}<br/>{new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })}{entry.model && <><br/>{entry.model}</>}</p>
      {entry.error && <p className="notice error">{entry.error}</p>}
      {entry.legacy && entry.file && !entry.prompt && <small className="muted">原记录未保存 Prompt，未用当前输入补造。</small>}
      <details><summary>查看 Prompt 与生成参数</summary>{entry.prompt && <pre>{entry.prompt}</pre>}<pre>{JSON.stringify({ parameters: entry.parameters, dependencies: entry.dependencies, content: entry.content }, null, 2)}</pre></details>
      <div className="actions">{entry.url && <a className="download" href={`${entry.url}?download=1`}>下载原文件</a>}<a className="download" href={`/api/projects/${projectId}/production/${encodeURIComponent(entry.id)}/record`}>下载记录 JSON</a>{entry.prompt && <a className="download" href={`/api/projects/${projectId}/production/${encodeURIComponent(entry.id)}/prompt`}>下载 Prompt</a>}</div>
    </article>)}</div>
    {!entries.length && <p className="muted">暂无符合条件的生产内容。</p>}
    {entries.length > limit && <button onClick={() => setLimit(value => value + 30)}>显示更多生产记录</button>}
  </section>;
}
