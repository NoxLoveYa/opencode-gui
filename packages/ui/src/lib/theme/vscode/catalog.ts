import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { importVSCodeTheme } from './import';
import { requireTheme } from '../definition';

const extensionSchema = z.object({
  namespace: z.string(), name: z.string(), version: z.string(), label: z.string(),
  icon: z.string().url().refine((url) => {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['open-vsx.org', 'openvsx.eclipsecontent.org'].includes(parsed.hostname);
  }).nullable(),
});
export type ThemeExtension = z.infer<typeof extensionSchema>;

export async function searchThemeCatalog(query: string, signal: AbortSignal) {
  const response = await runtimeFetch('/api/config/themes/catalog/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal,
  });
  if (!response.ok) throw new Error('catalog');
  return z.object({ items: z.array(extensionSchema).max(24) }).parse(await response.json()).items;
}

export async function readThemePackage(extension: ThemeExtension, signal: AbortSignal) {
  const response = await runtimeFetch('/api/config/themes/catalog/package', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(extension), signal,
  });
  if (!response.ok) throw new Error('catalog');
  const { items } = z.object({ items: z.array(z.object({ path: z.string(), name: z.string(), text: z.string(), error: z.boolean() })).max(40) }).parse(await response.json());
  return items.map((item, index) => {
    const key = `${index}:${item.path}`;
    try {
      if (item.error) throw new Error('invalid');
      const definition = importVSCodeTheme(item.text, item.path);
      // Manifest labels are display names, even when they resemble a slug.
      definition.metadata.name = item.name;
      definition.metadata.author = extension.namespace;
      return { status: 'ready' as const, key, name: item.name, definition, theme: requireTheme(definition) };
    } catch {
      return { status: 'invalid' as const, key, name: item.name };
    }
  });
}

export type ThemeVariants = Awaited<ReturnType<typeof readThemePackage>>;

// Each package is a full VSIX download, so reads are shared per extension and capped.
export function createThemePackageLoader(signal: AbortSignal, concurrency = 3) {
  const cache = new Map<string, Promise<ThemeVariants>>();
  const waiting: Array<() => void> = [];
  let active = 0;

  const acquire = async () => {
    if (active < concurrency) { active++; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };

  return (extension: ThemeExtension) => {
    const key = `${extension.namespace}/${extension.name}/${extension.version}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        await acquire();
        try { return await readThemePackage(extension, signal); } finally { release(); }
      })();
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  };
}
