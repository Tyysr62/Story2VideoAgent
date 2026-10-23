import { useState } from 'react';
import type { CharacterLibrary, CharacterRef } from '../domain/characters.js';

interface Props { projectId: string; library: CharacterLibrary; refs: CharacterRef[]; index: number; disabled: boolean; onChange(refs: CharacterRef[]): void; }
export function CharacterReferences({ projectId, library, refs, index, disabled, onChange }: Props) {
  const [query, setQuery] = useState(''); const search = query.replace(/^@/, '').trim().toLocaleLowerCase();
  const candidates = library.characters.flatMap(c => c.looks.map(l => ({ c, l }))).filter(({ c, l }) => `${c.name} ${c.aliases.join(' ')} ${l.name} ${c.name}·${l.name}`.toLocaleLowerCase().includes(search));
  return <div className="reference-editor">
    <label>出镜角色 · 输入 @ 搜索<input aria-label={`镜头 ${index + 1} 角色引用`} value={query} placeholder="@角色名，选择明确造型" disabled={disabled} onChange={e => setQuery(e.target.value)}/></label>
    {query && <div className="reference-candidates">{candidates.length ? candidates.map(({ c, l }) => <button type="button" key={`${c.id}:${l.id}`} disabled={disabled} onClick={() => {
      onChange([...refs.filter(r => r.characterId !== c.id || r.lookId !== l.id), { characterId: c.id, lookId: l.id, lookVersionId: l.selectedVersionId }]); setQuery('');
    }}>@{c.name}·{l.name}</button>) : <p className="muted">未找到角色或造型。请先在角色库登记，再选择引用。</p>}</div>}
    <div className="reference-chips">{refs.map(ref => {
      const character = library.characters.find(c => c.id === ref.characterId); const look = character?.looks.find(l => l.id === ref.lookId);
      const version = look?.versions.find(v => v.id === ref.lookVersionId); const stale = !version || look?.selectedVersionId !== ref.lookVersionId;
      return <div className={`reference-chip ${stale ? 'stale' : ''}`} key={`${ref.characterId}:${ref.lookId}`}>
        <details><summary>
          {version?.imageAssetId && <img src={`/api/projects/${projectId}/character-images/${version.imageAssetId}`} alt={`${character?.name} 引用预览`}/>}
          <span>@{character?.name ?? '未知角色'}·{look?.name ?? '未知造型'}{stale && <small>引用已过期，请更新版本</small>}</span>
        </summary><div className="reference-detail"><p>绑定版本：V{look ? look.versions.findIndex(v => v.id === ref.lookVersionId) + 1 : '?'} · {ref.lookVersionId}</p><p>{version?.description ?? '该版本不存在，请重新选择'}</p>
          {version?.imageAssetId && <a href={`/api/projects/${projectId}/character-images/${version.imageAssetId}`} target="_blank" rel="noreferrer"><img src={`/api/projects/${projectId}/character-images/${version.imageAssetId}`} alt={`${character?.name} 完整参考图`}/>查看原图 ↗</a>}
        </div></details>
        <button type="button" disabled={disabled} aria-label={`移除镜头 ${index + 1} ${character?.name} ${look?.name} 引用`} onClick={() => onChange(refs.filter(r => r !== ref))}>×</button>
      </div>;
    })}</div>
  </div>;
}
