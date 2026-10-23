import type { Job, ProjectEvent, Storyboard } from '../domain/storyboard.js';
import type { CharacterLibrary } from '../domain/characters.js';
import type { PortraitJob } from '../storage/portrait-jobs.js';

interface Context {
  jobs?: Job[]; portraitJobs?: PortraitJob[]; characterLibrary?: CharacterLibrary; storyboard?: Storyboard | null;
}

// Translate persisted event codes at display time so old projects benefit too.
// Only known fields are rendered; raw provider errors/payloads stay out of the log.
export function describeEvent(event: Pick<ProjectEvent, 'type' | 'data'>, context: Context = {}): string {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as Record<string, unknown> : {};
  const portrait = context.portraitJobs?.find(job => job.id === data.jobId);
  const character = context.characterLibrary?.characters.find(c => c.id === (portrait?.characterId ?? data.characterId));
  const look = character?.looks.find(l => l.id === (portrait?.lookId ?? data.lookId));
  const role = character ? `：${character.name}${look ? ` · ${look.name}` : ''}` : '';
  const job = context.jobs?.find(j => j.id === data.jobId);
  const kind = job?.kind ?? data.kind;
  const shot = context.storyboard?.shots.find(s => s.id === (job?.shotId ?? data.shotId));
  const subject = shot ? `：${shot.title}` : '';
  const version = typeof data.revision === 'number' && Number.isInteger(data.revision) && data.revision > 0 ? data.revision : undefined;
  const shots = typeof data.shots === 'number' && Number.isInteger(data.shots) && data.shots > 0 ? data.shots : undefined;
  switch (event.type) {
    case 'project.created': return '故事项目已创建';
    case 'project.v2_enabled': return '已启用角色参考，可设置角色与参考图';
    case 'planning.started': return 'AI 开始规划故事分镜';
    case 'planning.failed': return '分镜规划失败，请查看页面错误提示';
    case 'storyboard.updated': return `分镜已保存${version ? `（第 ${version} 版${shots ? `，共 ${shots} 个镜头` : ''}）` : ''}`;
    case 'project.approved': return `分镜已确认${version ? `（第 ${version} 版）` : ''}，可以开始生成`;
    case 'character.created': return '新角色已添加';
    case 'character.updated': return `角色设定已保存${role}`;
    case 'characters.approved': return '角色库已定稿，角色与参考图已确认';
    case 'portrait.started': return `开始生成角色候选图${role}${data.simulated === true ? '（离线测试）' : ''}`;
    case 'portrait.succeeded': return `角色候选图已生成${role}，请查看并确认参考图`;
    case 'portrait.failed': return data.unknown === true ? `角色候选图提交状态待核实${role}，请先核实云端任务，避免重复付费` : `角色候选图生成失败${role}，请查看角色卡上的错误提示`;
    case 'generation.started': return `开始生成镜头素材并拼接成片${data.simulated === true ? '（离线测试）' : ''}`;
    case 'generation.failed': return '本次生成未完成，请查看任务状态及错误提示';
    case 'job.started': return kind === 'compose' ? '开始拼接成片' : kind === 'image' ? `开始生成镜头预览图${subject}` : kind === 'video' ? `开始生成镜头视频${subject}` : '生成任务已开始';
    case 'job.succeeded': return kind === 'compose' ? '成片拼接已完成' : kind === 'image' ? `镜头预览图已生成${subject}` : kind === 'video' ? `镜头视频已生成${subject}` : '生成任务已完成';
    case 'project.ready': return '成片已完成，可预览或下载';
    case 'keyframe.started': return `开始生成分镜首帧${subject}`;
    case 'keyframe.succeeded': return `分镜首帧已生成${subject}，请审阅画面`;
    case 'keyframe.failed': return data.unknown === true ? `首帧提交状态待核实${subject}，请先核实云端任务` : `首帧生成失败${subject}，请查看生产记录`;
    case 'keyframe.selected': return `已切换首帧候选版本${subject}，请重新确认整组首帧`;
    case 'keyframes.approved': return '整组首帧已确认，可以提交视频生成';
    case 'video.started': return data.resuming === true ? `继续查询已有云端视频任务${subject}` : `开始生成首帧驱动视频${subject}`;
    case 'video.succeeded': return `首帧视频已生成${subject}`;
    case 'video.failed': return data.unknown === true ? `视频提交状态待核实${subject}，已阻止自动重提` : `视频生成或下载未完成${subject}，请查看生产记录`;
    default: return '执行状态已更新';
  }
}
