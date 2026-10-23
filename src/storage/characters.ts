import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Project, type Storyboard } from '../domain/storyboard.js';
import {
  characterInputSchema, characterPatchSchema, lookInputSchema, lookPatchSchema,
  normalizeLabel, referenceKey, resolveCharacterReferences, validateCharacterRef, validateLibraryLabels,
  type Character, type CharacterInput, type CharacterLibrary, type CharacterPatch,
  type ImageAsset, type Look, type LookInput, type LookPatch,
} from '../domain/characters.js';

const stamp = () => new Date().toISOString();
const imageSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), path: z.string().min(1),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), bytes: z.number().int().positive().max(10 * 1024 * 1024),
  width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i), source: z.enum(['upload', 'generated']), simulated: z.boolean(), createdAt: z.string().min(1),
}).strict();

/** Uses Repository's connection. Public mutations are synchronous and transactionally CAS-protected. */
export class CharacterStore {
  constructor(private db: DatabaseSync, private project: (id: string) => Project) {}
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
      fn(library); validateLibraryLabels(library.characters);
      if (library.approval && library.approval.manifestHash !== this.manifestHash(projectId, library)) library.approval = null;
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
      Object.assign(character, data);
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
      const version = { id: randomUUID(), description: data.description, imageAssetId: data.imageAssetId ?? null, createdAt: stamp() };
      character.looks.push({ id: randomUUID(), name: data.name, ...(data.default === undefined ? {} : { default: data.default }), selectedVersionId: version.id, versions: [version] });
    });
  }
  updateLook(projectId: string, revision: number, characterId: string, lookId: string, patch: LookPatch): CharacterLibrary {
    const data = lookPatchSchema.parse(patch);
    return this.mutate(projectId, revision, library => {
      const look = this.look(library, characterId, lookId);
      if (data.name) look.name = data.name;
      if (data.default !== undefined) {
        if (data.default) this.character(library, characterId).looks.forEach(l => { l.default = false; });
        look.default = data.default;
      }
      const current = look.versions.find(v => v.id === look.selectedVersionId)!;
      if (data.description !== undefined || data.imageAssetId !== undefined) {
        const imageAssetId = data.imageAssetId === undefined ? current.imageAssetId : data.imageAssetId;
        if (imageAssetId) this.getImageAsset(projectId, imageAssetId);
        const version = { id: randomUUID(), description: data.description ?? current.description, imageAssetId, createdAt: stamp() };
        look.versions.push(version); look.selectedVersionId = version.id;
      }
    });
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
    return (this.project(projectId).storyboard?.shots ?? []).filter(s => (s.characterRefs ?? []).some(r => r.characterId === characterId && (!lookId || r.lookId === lookId))).map(s => s.id);
  }
  private assertUnused(projectId: string, characterId: string, lookId?: string) {
    const shots = this.impact(projectId, characterId, lookId);
    if (shots.length) throw new AppError(409, `角色或造型已被镜头引用：${shots.join('、')}`);
  }
  resolveReferences(projectId: string, text: string) { return resolveCharacterReferences(text, this.snapshot(projectId)); }
  validateStoryboard(projectId: string, storyboard: Storyboard, forApproval = false) {
    const library = this.snapshot(projectId);
    for (const shot of storyboard.shots) {
      const refs = shot.characterRefs ?? [];
      if (new Set(refs.map(referenceKey)).size !== refs.length) throw new AppError(400, '角色引用重复');
      if (forApproval) {
        const mentions = resolveCharacterReferences([shot.title, shot.description, shot.camera, shot.imagePrompt, shot.videoPrompt].join('\n'), library);
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
  invalidateApproval(projectId: string) { const library = this.raw(projectId); if (library.approval) { library.approval = null; this.write(projectId, library); } }
  saveImageAsset(input: Omit<ImageAsset, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ImageAsset {
    this.editable(input.projectId);
    const asset = imageSchema.parse({ ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? stamp() });
    this.db.prepare('INSERT INTO character_images(id,project_id,payload) VALUES(?,?,?)').run(asset.id, asset.projectId, JSON.stringify(asset));
    return asset;
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
