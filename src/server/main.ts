import { config as dotenv } from 'dotenv';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { Repository } from '../storage/repository.js';
import { Workflow } from '../workflow/workflow.js';
import { PiDirector } from '../director/pi-director.js';
import { FfmpegComposer, MockMedia } from '../media/ffmpeg.js';
import { OpenRouterMedia, DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_RESOLUTION, DEFAULT_VIDEO_MODEL } from '../media/openrouter.js';
import { createApp } from './app.js';
import { resolveDirectorConfig } from '../config/providers.js';
import { CharacterService } from '../characters/service.js';
import { M2Service } from '../production/m2.js';
import { createFrameTransport } from '../media/frame-transport.js';
import { MediaQueue, resolveConcurrency } from '../media/queue.js';

dotenv({ path: '.env.local', quiet: true });
const mediaQueue = new MediaQueue(resolveConcurrency(process.env));
const host = '127.0.0.1'; const port = Number(process.env.PORT || 4310);
// Reject an already occupied port before opening the live database or recovering jobs.
await new Promise<void>((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen({ host, port }, () => probe.close(error => error ? reject(error) : resolve()));
});
const demo = process.argv.includes('--demo');
const root = resolve(process.env.STORY_AGENT_DATA_DIR || (demo ? './data/demo' : './data/live')); await mkdir(root, { recursive: true });
const repo = new Repository(join(root, 'story.db'));
const orKey = process.env.OPENROUTER_API_KEY || '';
const director = resolveDirectorConfig(process.env);
let planner = new PiDirector({ ...director, allowedDurations: Array.from({ length: 11 }, (_, i) => i + 5) });
if (demo) {
  const { board } = await import('../../tests/fixtures.js'); const { scriptedStream } = await import('../../tests/scripted-model.js');
  planner = new PiDirector({ apiKey: 'test-fixture', stream: (...args) => demoStream(...args) });
  let demoStream = scriptedStream(board(Number(process.env.STORY_AGENT_DEMO_SHOTS || 3)));
  const original = planner.plan.bind(planner); planner.plan = (...args) => { demoStream = scriptedStream(board(Number(process.env.STORY_AGENT_DEMO_SHOTS || 3))); return original(...args); };
}
const media = demo ? new MockMedia() : new OpenRouterMedia({ apiKey: orKey, videoModel: process.env.VIDEO_MODEL, imageModel: process.env.IMAGE_MODEL, resolution: process.env.VIDEO_RESOLUTION || '480p', imageResolution: process.env.IMAGE_RESOLUTION, diagnosticRoot: join(root, 'diagnostics') });
const workflow = new Workflow(repo, planner, media, new FfmpegComposer(), root, mediaQueue);
const m2 = new M2Service(repo, root, media, new FfmpegComposer(), demo ? undefined : createFrameTransport(), mediaQueue);
const characters = new CharacterService(repo, root, demo ? { simulated: true, validatePortraitReference: async () => ({}), portrait: (prompt, output) => media.image({ id: 'portrait-fixture', title: '测试角色图', description: prompt, camera: '正面', imagePrompt: prompt, videoPrompt: prompt, duration: 1, characterIds: [] }, output) } : media as OpenRouterMedia, mediaQueue);
const app = await createApp({ repo, workflow, characters, m2, dataRoot: root, staticRoot: resolve('dist'), publicConfig: {
  plannerConfigured: demo || Boolean(director.apiKey), mediaConfigured: demo || Boolean(orKey), simulated: demo,
  plannerProvider: demo ? 'offline-fixture' : director.provider,
  plannerModel: demo ? 'Pi 脚本模型替身（非真实 AI）' : director.model, imageModel: demo ? '测试色卡' : process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL, imageResolution: demo ? '测试色卡尺寸' : process.env.IMAGE_RESOLUTION || DEFAULT_IMAGE_RESOLUTION,
  videoModel: demo ? '测试片段' : process.env.VIDEO_MODEL || DEFAULT_VIDEO_MODEL, resolution: process.env.VIDEO_RESOLUTION || '480p', maxShots: 20, characterLibraryEnabled: true, m2Enabled: true,
  imageConcurrency: mediaQueue.limits.image, videoConcurrency: mediaQueue.limits.video,
} });
await characters.recover();
await m2.recover();
await workflow.recover();
await app.listen({ host, port });
console.log(`Story Agent: http://127.0.0.1:${process.env.PORT || 4310}${demo ? ' [OFFLINE TEST FIXTURES — NOT AI MEDIA]' : ''}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { if (stopping) return; stopping = true; await app.close(); await characters.idle(); await m2.idle(); await workflow.idle(); repo.close(); process.exit(0); });
