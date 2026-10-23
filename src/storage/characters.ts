import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Project, type Storyboard } from '../domain/storyboard.js';
import type { ProductionStore } from '../production/store.js';
import {
  characterInputSchema, characterPatchSchema, lookInputSchema, lookPatchSchema,
  normalizeLabel, referenceKey, resolveCharacterReferences, validateCharacterRef, validateLibraryLabels,
  type Character, type CharacterInput, type CharacterLibrary, type CharacterPatch,
  type ImageAsset, type Look, type LookInput, type LookPatch, type LookVersion,
} from '../domain/characters.js';

const stamp = () => new Date().toISOString();
const imageSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), path: z.string().min(1),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), bytes: z.number().int().positive().max(10 * 1024 * 1024),
  width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i), source: z.enum(['upload', 'generated']), simulated: z.boolean(), createdAt: z.string().min(1),
  generation: z.object({ model: z.string().max(300), parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), prompt: z.string().max(12000), identityDescription: z.string().max(2000), lookDescription: z.string().max(2000), style: z.string().max(2000) }).optional(),
}).strict();

/** Uses Repository's connection. Public mutations are synchronous and transactionally CAS-protected. */
export class CharacterStore {
  constructor(private db: DatabaseSync, private project: (id: string) => Project, private production?: ProductionStore) {}
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private raw(projectId: string): CharacterLibrary {
    this.project(projectId);
    const row = this.db.prepare('SELECT payload FROM character_libraries WHERE project_id=?').get(projectId);
    return row ? JSON.parse(String(row.payload)) : { revision: 0, characters: [], approval: null };
  }
  snapshot(projectId: string): CharacterLibrary {
    const library = this.raw(projectId);
    if (library.approval && library.approval.manifestHash !== this.manifestHash(projectId, library)) library.approval = null;
    return library;
  }
  private write(projectId: string, library: CharacterLibrary) {
    this.db.prepare('INSERT INTO character_libraries(project_id,payload) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload').run(projectId, JSON.stringify(library));
  }
  private editable(projectId: string) {
    const project = this.project(projectId);
    if (project.status === 'planning' || project.status === 'generating') throw new AppError(409, '规划或生成期间不能修改角色');
  }
  private mutate(projectId: string, revision: number, fn: (library: CharacterLibrary) => void): CharacterLibrary {
    return this.transaction(() => {
      this.editable(projectId);
      const library = this.snapshot(projectId);
      if (library.revision !== revision) throw new AppError(409, '角色库版本已变化，请刷新后重试');
      const previousHash = this.manifestHash(projectId, library);
      fn(library); validateLibraryLabels(library.characters);
      const changed = previousHash !== this.manifestHash(projectId, library);
      if (changed) {
        library.approval = null;
        const project = this.project(projectId);
        if (project.workflowVersion === 2 && project.approvedRevision !== null) {
          project.approvedRevision = null; project.status = project.storyboard ? 'awaiting_approval' : 'draft';
          this.db.prepare('UPDATE projects SET payload=? WHERE id=?').run(JSON.stringify(project), projectId);
        }
      }
      library.revision++; this.write(projectId, library); return library;
    });
  }
  private character(library: CharacterLibrary, id: string): Character {
    const character = library.characters.find(c => c.id === id);
    if (!character) throw new AppError(404, '角色不存在');
    return character;
  }
  private look(library: CharacterLibrary, characterId: string, lookId: string): Look {
    const look = this.character(library, characterId).looks.find(l => l.id === lookId);
    if (!look) throw new AppError(404, '造型不属于角色');
    return look;
  }
  createCharacter(projectId: string, revision: number, input: CharacterInput): CharacterLibrary {
    const data = characterInputSchema.parse(input);
    return this.mutate(projectId, revision, library => library.characters.push({ ...data, id: randomUUID(), looks: [] }));
  }
  updateCharacter(projectId: string, revision: number, characterId: string, patch: CharacterPatch): CharacterLibrary {
    const data = characterPatchSchema.parse(patch);
    return this.mutate(projectId, revision, library => {
      const character = this.character(library, characterId);
      const previousName = character.name;
      const historicalAliases = character.aliases;
      Object.assign(character, data);
      // Existing aliases can occur in saved text. Keep them as historical names instead of breaking bindings.
      character.aliases = [...new Map([...historicalAliases, ...character.aliases].map(a => [normalizeLabel(a), a])).values()];
      // Historical labels remain visible aliases, preserving already bound @ text through rename.
      if (data.name && normalizeLabel(previousName) !== normalizeLabel(data.name)) {
        character.aliases = character.aliases.filter(a => normalizeLabel(a) !== normalizeLabel(data.name!));
        if (!character.aliases.some(a => normalizeLabel(a) === normalizeLabel(previousName))) character.aliases.push(previousName);
      }
    });
  }
  deleteCharacter(projectId: string, revision: number, characterId: string): CharacterLibrary {
    return this.mutate(projectId, revision, library => {
      this.character(library, characterId); this.assertUnused(projectId, characterId);
      library.characters = library.characters.filter(c => c.id !== characterId);
    });
  }
  createLook(projectId: string, revision: number, characterId: string, input: LookInput): CharacterLibrary {
    const data = lookInputSchema.parse(input);
    return this.mutate(projectId, revision, library => {
      const character = this.character(library, characterId);
      if (data.imageAssetId) this.getImageAsset(projectId, data.imageAssetId);
      if (data.default) character.looks.forEach(l => { l.default = false; });
      const version = this.newVersion(projectId, character, data.description, data.imageAssetId ?? null);
      character.looks.push({ id: randomUUID(), name: data.name, ...(data.default === undefined ? {} : { default: data.default }), selectedVersionId: version.id, versions: [version] });
    });
  }
  updateLook(projectId: string, revision: number, characterId: string, lookId: string, patch: LookPatch): CharacterLibrary {
    const data = lookPatchSchema.parse(patch);
    return this.mutate(projectId, revision, library => {
      const look = this.look(library, characterId, lookId);
      if (data.name && normalizeLabel(data.name) !== normalizeLabel(look.name)) {
        look.aliases = [...new Set([...(look.aliases ?? []), look.name])].filter(n => normalizeLabel(n) !== normalizeLabel(data.name!)); look.name = data.name;
      }
      if (data.default !== undefined) {
        if (data.default) this.character(library, characterId).looks.forEach(l => { l.default = false; });
        look.default = data.default;
      }
      const current = look.versions.find(v => v.id === look.selectedVersionId)!;
      if (data.description !== undefined || data.imageAssetId !== undefined) {
        const imageAssetId = data.imageAssetId === undefined ? current.imageAssetId : data.imageAssetId;
        if (imageAssetId) this.getImageAsset(projectId, imageAssetId);
        const version = this.newVersion(projectId, this.character(library, characterId), data.description ?? current.description, imageAssetId);
        look.versions.push(version); look.selectedVersionId = version.id;
      }
    });
  }
  private newVersion(projectId: string, character: Pick<Character, 'description'>, description: string, imageAssetId: string | null, style = this.project(projectId).storyboard?.style ?? ''): LookVersion {
    const image = imageAssetId ? this.getImageAsset(projectId, imageAssetId) : undefined;
    const snapshot = { description, imageSha: image?.sha256 ?? null, identityDescription: character.description, style };
    return { id: randomUUID(), description, imageAssetId, createdAt: stamp(), identityDescription: character.description,
      identityHash: createHash('sha256').update(character.description).digest('hex'), style, source: image?.source ?? 'draft',
      contentHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), ...(image?.generation ? { generation: image.generation } : {}) };
  }
  selectVersion(projectId: string, revision: number, characterId: string, lookId: string, versionId: string): CharacterLibrary {
    return this.mutate(projectId, revision, library => {
      const look = this.look(library, characterId, lookId);
      if (!look.versions.some(v => v.id === versionId)) throw new AppError(404, '造型版本不存在');
      look.selectedVersionId = versionId;
    });
  }
  deleteLook(projectId: string, revision: number, characterId: string, lookId: string): CharacterLibrary {
    return this.mutate(projectId, revision, library => {
      this.look(library, characterId, lookId); this.assertUnused(projectId, characterId, lookId);
      const character = this.character(library, characterId); character.looks = character.looks.filter(l => l.id !== lookId);
    });
  }
  impact(projectId: string, characterId: string, lookId?: string): string[] {
    return (this.project(projectId).storyboard?.shots ?? []).filter(s => (s.characterRefs ?? []).some(r => r.characterId === characterId && (!lookId || r.lookId === lookId)) || !lookId && s.audio?.dialogue.some(d => d.characterId === characterId)).map(s => s.id);
  }
  private assertUnused(projectId: string, characterId: string, lookId?: string) {
    if (!lookId && this.project(projectId).storyboard?.audioProfile?.characterVoices.some(v => v.characterId === characterId)) throw new AppError(409, '角色仍有全片声音设定，请先清除该声音设定并保存分镜，再删除角色');
    const shots = this.impact(projectId, characterId, lookId);
    if (shots.length) throw new AppError(409, `角色或造型已被镜头引用：${shots.join('、')}`);
  }
  resolveReferences(projectId: string, text: string) { return resolveCharacterReferences(text, this.snapshot(projectId)); }
  /** Called only by Repository while committing a planner result or explicit V1 upgrade. */
  adoptPlan(projectId: string, storyboard: Storyboard): Storyboard {
    const library = this.raw(projectId);
    if (!library.characters.length && storyboard.characters.length) {
      library.characters = storyboard.characters.map(c => {
        const data = characterInputSchema.parse({ name: c.name, description: c.description });
        const version = this.newVersion(projectId, data, data.description, null, storyboard.style);
        return { ...data, id: c.id, looks: [{ id: randomUUID(), name: '默认', default: true, selectedVersionId: version.id, versions: [version] }] };
      });
      validateLibraryLabels(library.characters); library.revision++; library.approval = null; this.write(projectId, library);
    }
    const ids = new Set(library.characters.map(c => c.id));
    if (storyboard.characters.some(c => !ids.has(c.id))) throw new AppError(409, '规划引用了未登记角色，请先在角色库创建该身份');
    const shots = storyboard.shots.map(shot => {
      if (shot.characterIds.some(id => !ids.has(id))) throw new AppError(400, '规划引用了未知角色 ID');
      const refs = shot.characterRefs ?? shot.characterIds.map(id => {
        const c = library.characters.find(c => c.id === id)!; const choices = c.looks.length === 1 ? c.looks : c.looks.filter(l => l.default);
        if (choices.length !== 1) throw new AppError(409, `角色 ${c.name} 有多个造型，请选择默认造型或在分镜中明确引用`);
        return { characterId: id, lookId: choices[0].id, lookVersionId: choices[0].selectedVersionId };
      });
      return { ...shot, characterIds: [...new Set(refs.map(r => r.characterId))], characterRefs: refs };
    });
    return { ...storyboard, characters: library.characters.map(c => ({ id: c.id, name: c.name, description: c.description })), shots };
  }
  validateStoryboard(projectId: string, storyboard: Storyboard, forApproval = false) {
    const library = this.snapshot(projectId);
    const ids = new Set(library.characters.map(c => c.id));
    if (storyboard.audioProfile?.characterVoices.some(v => !ids.has(v.characterId))) throw new AppError(400, '声音设定必须引用角色库中的身份');
    for (const shot of storyboard.shots) {
      const refs = shot.characterRefs ?? [];
      for (const d of shot.audio?.dialogue ?? []) {
        if (!ids.has(d.characterId)) throw new AppError(400, '台词必须引用角色库中的身份');
        if (d.placement === 'on_screen' && !refs.some(r => r.characterId === d.characterId)) throw new AppError(409, '画内说话角色尚未绑定出镜造型');
      }
      if (shot.characterIds.some(id => !refs.some(ref => ref.characterId === id))) throw new AppError(409, '角色身份尚未绑定明确造型引用');
      if (new Set(refs.map(referenceKey)).size !== refs.length) throw new AppError(400, '角色引用重复');
      if (forApproval) {
        const mentions = resolveCharacterReferences([shot.title, shot.description, shot.camera, shot.imagePrompt, shot.videoPrompt].join('\n'), library, refs);
        if (mentions.some(r => !refs.some(bound => referenceKey(bound) === referenceKey(r)))) throw new AppError(409, '角色提及尚未绑定明确造型');
      }
      for (const ref of refs) {
        const version = validateCharacterRef(library, ref);
        if (forApproval && (!version.imageAssetId || !version.description.trim())) throw new AppError(409, '被引用造型需要参考图片和具体描述');
        if (version.imageAssetId) this.getImageAsset(projectId, version.imageAssetId);
      }
    }
  }
  private manifestHash(projectId: string, library: CharacterLibrary): string {
    const manifest = { style: this.project(projectId).storyboard?.style ?? '', characters: library.characters.map(c => ({
      id: c.id, description: c.description, looks: c.looks.map(l => {
        const version = l.versions.find(v => v.id === l.selectedVersionId)!;
        return { id: l.id, versionId: version.id, description: version.description, imageSha: version.imageAssetId ? this.getImageAsset(projectId, version.imageAssetId).sha256 : null };
      }),
    })) };
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  }
  approve(projectId: string, revision: number): CharacterLibrary {
    return this.transaction(() => {
      this.editable(projectId); const library = this.snapshot(projectId);
      if (library.revision !== revision) throw new AppError(409, '角色库版本已变化，请刷新后重试');
      const storyboard = this.project(projectId).storyboard;
      if (storyboard) this.validateStoryboard(projectId, storyboard, true);
      library.approval = { manifestHash: this.manifestHash(projectId, library), approvedAt: stamp() };
      this.write(projectId, library); return library;
    });
  }
  /** Called inside Repository's storyboard transaction; does not start a nested transaction. */
  invalidateApproval(projectId: string) { const library = this.raw(projectId); library.approval = null; library.revision++; this.write(projectId, library); }
  saveImageAsset(input: Omit<ImageAsset, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ImageAsset {
    this.editable(input.projectId);
    const asset = imageSchema.parse({ ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? stamp() });
    this.db.prepare('INSERT INTO character_images(id,project_id,payload) VALUES(?,?,?)').run(asset.id, asset.projectId, JSON.stringify(asset));
    this.archiveImage(asset);
    return asset;
  }
  images(projectId: string): ImageAsset[] { this.project(projectId); return this.db.prepare('SELECT payload FROM character_images WHERE project_id=? ORDER BY rowid').all(projectId).map(r => JSON.parse(String(r.payload))); }
  archiveImage(asset: ImageAsset) {
    return this.production?.ensure({ id: `character:${asset.id}`, projectId: asset.projectId, kind: asset.source === 'upload' ? 'upload' : 'portrait', label: asset.source === 'upload' ? '上传角色参考图' : '生成角色候选图', status: 'succeeded', file: { path: asset.path, mime: asset.mime, bytes: asset.bytes, sha256: asset.sha256 }, prompt: asset.generation?.prompt, model: asset.generation?.model, parameters: asset.generation?.parameters, content: asset.generation, simulated: asset.simulated, createdAt: asset.createdAt });
  }
  getImageAsset(projectId: string, id: string): ImageAsset {
    this.project(projectId);
    const row = this.db.prepare('SELECT payload FROM character_images WHERE id=? AND project_id=?').get(id, projectId);
    if (!row) throw new AppError(404, '参考图片不属于当前项目');
    return JSON.parse(String(row.payload));
  }
  deleteImageAsset(projectId: string, id: string) {
    this.transaction(() => {
      this.editable(projectId); this.getImageAsset(projectId, id);
      if (this.raw(projectId).characters.some(c => c.looks.some(l => l.versions.some(v => v.imageAssetId === id)))) throw new AppError(409, '参考图片已被造型版本引用');
      this.db.prepare('DELETE FROM character_images WHERE id=? AND project_id=?').run(id, projectId);
    });
  }
}
