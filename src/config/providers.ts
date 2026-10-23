import { AppError } from '../domain/storyboard.js';

type Provider = 'deepseek' | 'openrouter';
export interface DirectorConfig { provider: Provider; apiKey: string; model: string; baseUrl: string; }
export function resolveDirectorConfig(env: Record<string, string | undefined>): DirectorConfig {
  const selected = env.DIRECTOR_PROVIDER?.trim();
  if (selected && selected !== 'deepseek' && selected !== 'openrouter') throw new AppError(503, 'DIRECTOR_PROVIDER 仅支持 deepseek / openrouter');
  let endpointProvider: Provider | undefined;
  let endpoint: string | undefined;
  if (env.DIRECTOR_BASE_URL?.trim()) {
    let url: URL;
    try { url = new URL(env.DIRECTOR_BASE_URL.trim()); } catch { throw new AppError(503, '导演端点 URL 无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AppError(503, '导演端点必须为不含凭据的官方 HTTPS 地址');
    if (url.hostname === 'api.deepseek.com') endpointProvider = 'deepseek';
    else if (['openrouter.ai', 'eu.openrouter.ai', 'us.openrouter.ai'].includes(url.hostname)) endpointProvider = 'openrouter';
    else throw new AppError(503, '导演端点不是已支持的官方供应商地址');
    endpoint = url.toString().replace(/\/$/, '');
  }
  if (selected && endpointProvider && selected !== endpointProvider) throw new AppError(503, '导演供应商与端点不一致，请检查 DIRECTOR_PROVIDER / DIRECTOR_BASE_URL');
  const provider: Provider = selected as Provider || endpointProvider || (env.DEEPSEEK_API_KEY?.trim() ? 'deepseek' : 'openrouter');
  const model = env.DIRECTOR_MODEL?.trim() || (provider === 'deepseek' ? 'deepseek-flash' : 'deepseek/deepseek-v4.1-flash-1017');
  if (provider === 'deepseek' && model.includes('/')) throw new AppError(503, 'DeepSeek 直连模型请使用 deepseek-flash，不能使用 OpenRouter 命名空间');
  return { provider, apiKey: (provider === 'deepseek' ? env.DEEPSEEK_API_KEY : env.OPENROUTER_API_KEY)?.trim() || '', model,
    baseUrl: endpoint || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://openrouter.ai/api/v1') };
}
