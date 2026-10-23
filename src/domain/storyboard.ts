import { z } from 'zod';

export const MAX_SHOTS = 20;
const text = z.string().trim().min(1).max(6000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const storyboardSchema = z.object({
  title: text.max(120), style: text.max(2000),
  characters: z.array(z.object({ id, name: text.max(100), description: text.max(2000) })).max(30),
  shots: z.array(z.object({ id, title: text.max(120), description: text, camera: text.max(1000),
    imagePrompt: text, videoPrompt: text, duration: z.number().finite().positive(), characterIds: z.array(id).max(30),
    characterRefs: z.array(z.object({ characterId: id, lookId: id, lookVersionId: id }).strict()).max(30).optional() })).min(1).max(MAX_SHOTS),
}).superRefine((b, ctx) => {
  const unique = (ids: string[], name: string) => { if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `${name} ID 重复` }); };
  unique(b.characters.map(c => c.id), '角色'); unique(b.shots.map(s => s.id), '镜头');
  const ids = new Set(b.characters.map(c => c.id));
  b.shots.forEach((s, i) => { if (s.characterIds.some(x => !ids.has(x))) ctx.addIssue({ code: 'custom', path: ['shots', i, 'characterIds'], message: '引用了不存在的角色' }); });
});
export type Storyboard = z.infer<typeof storyboardSchema>;
export function validateStoryboard(value: unknown): Storyboard { return storyboardSchema.parse(value); }
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export type ProjectStatus = 'draft' | 'planning' | 'awaiting_approval' | 'approved' | 'generating' | 'ready' | 'failed';
export interface Project {
  id: string; story: string; workflowVersion?: 2; revision: number; storyboard: Storyboard | null; status: ProjectStatus;
  approvedRevision: number | null; finalArtifactId: string | null; error: string | null; createdAt: string; updatedAt: string;
}
export interface Job {
  id: string; projectId: string; revision: number; kind: 'image' | 'video' | 'compose'; shotId: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'; attempts: number; artifactId: string | null; error: string | null;
  providerTaskId?: string; createdAt: string; updatedAt: string;
}
export interface Artifact { id: string; projectId: string; revision: number; shotId: string | null; kind: Job['kind']; path: string; mime: string; bytes: number; sha256: string; simulated: boolean; createdAt: string; }
export interface ProjectEvent { id: number; projectId: string; type: string; data: unknown; createdAt: string; }
