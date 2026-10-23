import { z } from 'zod';
import { AppError } from './storyboard.js';

export interface CharacterRef { characterId: string; lookId: string; lookVersionId: string; }
export interface LookVersion { readonly id: string; readonly description: string; readonly imageAssetId: string | null; readonly createdAt: string; }
export interface Look { id: string; name: string; default?: boolean; selectedVersionId: string; versions: LookVersion[]; }
export interface Character { id: string; name: string; aliases: string[]; description: string; looks: Look[]; }
export interface CharacterApproval { manifestHash: string; approvedAt: string; }
export interface CharacterLibrary { revision: number; characters: Character[]; approval: CharacterApproval | null; }
export interface ImageAsset {
  readonly id: string; readonly projectId: string; readonly path: string;
  readonly mime: 'image/png' | 'image/jpeg' | 'image/webp'; readonly bytes: number;
  readonly width: number; readonly height: number; readonly sha256: string;
  readonly source: 'upload' | 'generated'; readonly simulated: boolean; readonly createdAt: string;
}

// Names exclude mention delimiters so every accepted label can be entered as @name·look.
export const labelSchema = z.string().trim().min(1).max(100).regex(/^[^\s@·，。！？、,!?;；:：()（）]+$/u);
export const descriptionSchema = z.string().trim().min(1).max(2000);
export const characterInputSchema = z.object({ name: labelSchema, aliases: z.array(labelSchema).max(100).default([]), description: descriptionSchema }).strict();
export const characterPatchSchema = characterInputSchema.partial();
export const lookInputSchema = z.object({ name: labelSchema, default: z.boolean().optional(), description: descriptionSchema, imageAssetId: z.string().min(1).nullable().optional() }).strict();
export const lookPatchSchema = lookInputSchema.partial();
export type CharacterInput = z.input<typeof characterInputSchema>;
export type CharacterPatch = z.input<typeof characterPatchSchema>;
export type LookInput = z.input<typeof lookInputSchema>;
export type LookPatch = z.input<typeof lookPatchSchema>;
export const normalizeLabel = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
export function validateLibraryLabels(characters: Character[]) {
  if (characters.length > 30) throw new AppError(400, '每个项目最多 30 个角色');
  const names = new Set<string>();
  for (const character of characters) {
    for (const name of [character.name, ...character.aliases]) {
      const key = normalizeLabel(name);
      if (names.has(key)) throw new AppError(400, '角色名称或别名重复');
      names.add(key);
    }
    const looks = character.looks.map(l => normalizeLabel(l.name));
    if (new Set(looks).size !== looks.length) throw new AppError(400, '造型名称重复');
    if (character.looks.filter(l => l.default).length > 1) throw new AppError(400, '只能选择一个默认造型');
  }
}
export interface CharacterMention { label: string; name: string; lookName?: string; start: number; end: number; }
export function parseCharacterMentions(text: string): CharacterMention[] {
  const mentions: CharacterMention[] = [];
  // A letter/number immediately before @ belongs to ordinary text such as an email address.
  const regex = /(?<![\p{L}\p{N}_.%+@-])@([^\s@·，。！？、,!?;；:：()（）]+)(?:·([^\s@·，。！？、,!?;；:：()（）]+))?/gu;
  for (const match of text.matchAll(regex)) mentions.push({ label: match[0], name: match[1], lookName: match[2], start: match.index, end: match.index + match[0].length });
  return mentions;
}
export function resolveCharacterReferences(text: string, library: CharacterLibrary): CharacterRef[] {
  const refs: CharacterRef[] = [];
  for (const mention of parseCharacterMentions(text)) {
    const candidates = library.characters.filter(c => [c.name, ...c.aliases].some(n => normalizeLabel(n) === normalizeLabel(mention.name)));
    if (candidates.length !== 1) throw new AppError(400, `未知或有歧义的角色引用：${mention.label}`);
    const character = candidates[0];
    const looks = mention.lookName
      ? character.looks.filter(l => normalizeLabel(l.name) === normalizeLabel(mention.lookName!))
      : character.looks.length === 1 ? character.looks : character.looks.filter(l => l.default);
    if (looks.length !== 1) throw new AppError(400, `请选择明确的角色造型：${mention.label}`);
    const look = looks[0];
    const ref = { characterId: character.id, lookId: look.id, lookVersionId: look.selectedVersionId };
    if (!refs.some(r => referenceKey(r) === referenceKey(ref))) refs.push(ref);
  }
  return refs;
}
export const referenceKey = (ref: CharacterRef) => `${ref.characterId}:${ref.lookId}:${ref.lookVersionId}`;
export function validateCharacterRef(library: CharacterLibrary, ref: CharacterRef): LookVersion {
  const character = library.characters.find(c => c.id === ref.characterId);
  const look = character?.looks.find(l => l.id === ref.lookId);
  if (!look) throw new AppError(400, '角色或造型不属于当前项目');
  const version = look.versions.find(v => v.id === ref.lookVersionId);
  if (!version || look.selectedVersionId !== ref.lookVersionId) throw new AppError(409, '造型版本不存在或已过期');
  return version;
}
