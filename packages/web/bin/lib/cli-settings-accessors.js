// Minimal settings.json access for CLI contexts (connect-url, pairing
// candidate building) that must not load the full web settings runtime.
//
// The running app already treats settings.json as a shared store — the relay
// identity, tunnels, notifications, the Electron main, and ssh-manager all
// read-modify-write it. This accessor must therefore mirror the settings
// runtime's guarantees or it will corrupt or regenerate shared state:
//
//   - ATOMIC writes (write tmp, rename into place). A plain writeFile can
//     interleave with a concurrent reader in the running app; the reader sees
//     a half-written file, its lenient read maps it to `{}`, and relay
//     identity logic then mints a NEW serverId — orphaning every paired
//     device. The tmp+rename below means no reader can ever observe a partial
//     file.
//
//   - A STRICT read that THROWS on corrupt/unreadable payloads, gating relay
//     identity regeneration. Only a genuinely missing file means "no
//     settings"; any other failure (corrupt JSON, EACCES, transient I/O,
//     non-object payload) must propagate so callers never confuse a broken
//     read with first run and mint a replacement signing/encryption keypair.

import { writeFileDurable } from '../../server/lib/shared/durable-write.js';

export const createSettingsAccessors = ({ fsPromises, path, dataDir, settingsFileName }) => {
  const settingsPath = path.join(dataDir, settingsFileName);

  const readSettingsFromDiskMigrated = async () => {
    try {
      return JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));
    } catch {
      return {};
    }
  };

  const readSettingsStrict = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const corruptSettingsError = (cause) =>
      new Error(`Settings file is corrupt or unreadable: ${settingsPath} (fix or remove it, then retry)`, { cause });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw corruptSettingsError(error);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw corruptSettingsError(new Error('non-object payload'));
    }
    return parsed;
  };

  const writeSettingsToDisk = async (settings) => {
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileDurable(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600, fsPromises });
    if (process.platform !== 'win32') {
      await fsPromises.chmod(settingsPath, 0o600);
    }
  };

  return { readSettingsFromDiskMigrated, readSettingsStrict, writeSettingsToDisk };
};
