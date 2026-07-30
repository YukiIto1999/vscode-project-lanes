const fs = require('node:fs');

const exactAssetSet = (assets, expected) =>
  assets.length === expected.length && assets.every((name, index) => name === expected[index]);

const inspectReleaseCheckpoint = ({ tagExists, release, vsixName, checksumName }) => {
  const base = {
    complete: false,
    releaseExists: release !== undefined,
    tagExists,
    reuse: false,
    repairChecksum: false,
    download: 'none',
  };

  if (release === undefined) return base;
  if (!tagExists) {
    throw new Error('Release exists without a fetched tag');
  }
  if (
    release === null ||
    typeof release !== 'object' ||
    typeof release.draft !== 'boolean' ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('Release checkpoint JSON has an invalid shape');
  }

  const assetNames = release.assets.map((asset) => asset?.name).sort();
  if (assetNames.some((name) => typeof name !== 'string')) {
    throw new Error('Release checkpoint JSON has an invalid asset');
  }
  const expectedNames = [checksumName, vsixName].sort();

  if (!release.draft) {
    if (!exactAssetSet(assetNames, expectedNames)) {
      throw new Error('Published release does not contain the exact release assets');
    }
    return { ...base, complete: true };
  }

  if (exactAssetSet(assetNames, expectedNames)) {
    return { ...base, reuse: true, download: 'all' };
  }
  if (exactAssetSet(assetNames, [vsixName])) {
    return {
      ...base,
      reuse: true,
      repairChecksum: true,
      download: 'vsix',
    };
  }
  if (assetNames.length === 0) return base;

  throw new Error('Draft release has an unsafe partial or unexpected asset set');
};

const parseCli = (arguments_) => {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: node inspect-checkpoint.cjs --tag-exists <true|false> --vsix-name <name> --checksum-name <name> [--release-file <path>]',
      );
    }
    values[flag.slice(2)] = value;
  }
  if (
    !['true', 'false'].includes(values['tag-exists']) ||
    !values['vsix-name'] ||
    !values['checksum-name']
  ) {
    throw new Error(
      'Usage: node inspect-checkpoint.cjs --tag-exists <true|false> --vsix-name <name> --checksum-name <name> [--release-file <path>]',
    );
  }
  return values;
};

const runCli = () => {
  const values = parseCli(process.argv.slice(2));
  const release = values['release-file']
    ? JSON.parse(fs.readFileSync(values['release-file'], 'utf8'))
    : undefined;
  const state = inspectReleaseCheckpoint({
    tagExists: values['tag-exists'] === 'true',
    release,
    vsixName: values['vsix-name'],
    checksumName: values['checksum-name'],
  });
  for (const [name, value] of Object.entries({
    complete: state.complete,
    release_exists: state.releaseExists,
    tag_exists: state.tagExists,
    reuse: state.reuse,
    repair_checksum: state.repairChecksum,
    download: state.download,
  })) {
    process.stdout.write(`${name}=${String(value)}\n`);
  }
};

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { inspectReleaseCheckpoint };
