import { test, expect } from 'vitest';
import { resolveDirectorConfig } from '../src/config/providers.js';

test('prefers official DeepSeek for reasoning and visual understanding when both keys exist', () => {
  expect(resolveDirectorConfig({ DEEPSEEK_API_KEY: 'deepseek-fixture', OPENROUTER_API_KEY: 'router-fixture' })).toEqual({ provider: 'deepseek', apiKey: 'deepseek-fixture', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
});
test('can explicitly use OpenRouter with its matching key and model ID', () => {
  expect(resolveDirectorConfig({ DIRECTOR_PROVIDER: 'openrouter', DEEPSEEK_API_KEY: 'deepseek-fixture', OPENROUTER_API_KEY: 'router-fixture' })).toMatchObject({ provider: 'openrouter', apiKey: 'router-fixture', model: 'deepseek/deepseek-v4.1-flash-1017' });
});
test('missing DeepSeek credential never forwards the OpenRouter credential to DeepSeek', () => {
  expect(resolveDirectorConfig({ DIRECTOR_PROVIDER: 'deepseek', OPENROUTER_API_KEY: 'router-fixture' }).apiKey).toBe('');
});
test('existing endpoint determines provider when no explicit provider was selected', () => {
  expect(resolveDirectorConfig({ DIRECTOR_BASE_URL: 'https://api.deepseek.com/', DEEPSEEK_API_KEY: 'deepseek-fixture', OPENROUTER_API_KEY: 'router-fixture' })).toMatchObject({ provider: 'deepseek', apiKey: 'deepseek-fixture' });
});
test('rejects conflicting endpoint/provider instead of leaking a key to the other provider', () => {
  expect(() => resolveDirectorConfig({ DIRECTOR_PROVIDER: 'deepseek', DIRECTOR_BASE_URL: 'https://openrouter.ai/api/v1', DEEPSEEK_API_KEY: 'deepseek-fixture' })).toThrow(/供应商|端点/);
});
test('rejects unknown endpoints and DeepSeek model IDs in OpenRouter namespace', () => {
  expect(() => resolveDirectorConfig({ DIRECTOR_BASE_URL: 'https://untrusted.example/v1' })).toThrow(/端点/);
  expect(() => resolveDirectorConfig({ DIRECTOR_PROVIDER: 'deepseek', DIRECTOR_MODEL: 'deepseek/deepseek-v4.1-flash-1017' })).toThrow(/模型/);
});
test('unconfigured local service can start and report missing credentials', () => {
  expect(resolveDirectorConfig({})).toMatchObject({ provider: 'openrouter', apiKey: '' });
});
