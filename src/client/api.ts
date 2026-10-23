async function read<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error([value.error, value.details?.map((x: { path: string; message: string }) => `${x.path}: ${x.message}`).join('；')].filter(Boolean).join('：'));
  return value;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return read(await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }));
}
export async function uploadPortrait<T>(path: string, revision: number, file: File): Promise<T> {
  return read(await fetch(`/api${path}`, { method: 'PUT', headers: { 'Content-Type': file.type, 'x-library-revision': String(revision) }, body: file }));
}
