const fs = require('node:fs');
const path = require('node:path');

const JSZip = require('jszip');

const TARGET = 'linux-x64';
const ALLOWED_FILES = require('./vsix-files.json');
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_ZIP_COMMENT_SIZE = 0xffff;

const readJson = (contents, label) => {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
};

const expectedArtifactName = (packageJson) =>
  `${packageJson.name}-${TARGET}-${packageJson.version}.vsix`;

const findEndOfCentralDirectory = (archive) => {
  const minimumOffset = Math.max(
    0,
    archive.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ZIP_COMMENT_SIZE,
  );
  for (
    let offset = archive.length - END_OF_CENTRAL_DIRECTORY_SIZE;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('end of central directory not found');
};

const readCentralDirectoryNames = (archive) => {
  if (archive.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw new Error('archive is too short');
  }

  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('multi-disk ZIP archives are not supported');
  }
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported');
  }
  if (endOffset + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength !== archive.length) {
    throw new Error('invalid ZIP comment length');
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset > archive.length || centralDirectoryEnd !== endOffset) {
    throw new Error('invalid central directory bounds');
  }

  const names = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > centralDirectoryEnd ||
      archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error(`invalid central directory entry ${index + 1}`);
    }

    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const entryCommentLength = archive.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (entryEnd > centralDirectoryEnd) {
      throw new Error(`truncated central directory entry ${index + 1}`);
    }

    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset = entryEnd;
  }

  if (offset !== centralDirectoryEnd) {
    throw new Error('central directory entry count does not match its size');
  }

  return names;
};

const assertSafeArchivePaths = (names) => {
  const seen = new Set();
  for (const name of names) {
    if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(name)) {
      throw new Error(`VSIX contains an absolute path: ${name}`);
    }

    const normalized = name.replaceAll('\\', '/');
    if (normalized.split('/').includes('..')) {
      throw new Error(`VSIX contains a traversal path: ${name}`);
    }
    if (seen.has(normalized)) {
      throw new Error(`VSIX contains a duplicate entry: ${name}`);
    }
    seen.add(normalized);
  }
};

const forbiddenReason = (name) => {
  const normalized = name.replaceAll('\\', '/');
  const segments = normalized.toLowerCase().split('/');
  const basename = segments.at(-1);

  if (basename === '.release-notes.md') {
    return 'release notes scratch file';
  }
  if (basename.endsWith('.map')) {
    return 'source map';
  }
  if (
    segments.some((segment) =>
      ['.git', '.github', '.vscode', '.claude', '.playwright-mcp'].includes(segment),
    ) ||
    ['.mcp.json', 'agents.md', 'claude.md'].includes(basename)
  ) {
    return 'repository internal';
  }
  if (
    segments.some(
      (segment) =>
        segment === '.env' ||
        segment.startsWith('.env.') ||
        ['.npmrc', '.pypirc', '.netrc', 'credentials', 'secrets'].includes(segment),
    ) ||
    /\.(?:key|pem|p12|pfx)$/.test(basename) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(basename)
  ) {
    return 'secret file';
  }

  return undefined;
};

const assertExactFileSet = (names) => {
  for (const name of names) {
    const reason = forbiddenReason(name);
    if (reason) {
      throw new Error(`VSIX contains a forbidden ${reason}: ${name}`);
    }
  }

  const actual = new Set(names);
  const allowed = new Set(ALLOWED_FILES);
  const missing = ALLOWED_FILES.filter((name) => !actual.has(name));
  const unexpected = names.filter((name) => !allowed.has(name));

  if (missing.length > 0) {
    throw new Error(`VSIX is missing allowlisted files: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    throw new Error(`VSIX contains unexpected files: ${unexpected.join(', ')}`);
  }
};

const parseIdentity = (manifest) => {
  const identityMatches = [...manifest.matchAll(/<Identity\b([^>]*)\/?>/gi)];
  if (identityMatches.length !== 1) {
    throw new Error('extension.vsixmanifest must contain exactly one Identity element');
  }
  const [identityMatch] = identityMatches;

  const attributes = {};
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of identityMatch[1].matchAll(attributePattern)) {
    attributes[match[1]] = match[2] ?? match[3];
  }
  return attributes;
};

const readZipText = async (zip, name) => {
  const entry = zip.file(name);
  if (!entry) {
    throw new Error(`VSIX is missing ${name}`);
  }
  return entry.async('string');
};

const assertMatchesReference = async (candidateArchive, candidateZip, referencePath, repoRoot) => {
  await verifyVsix(referencePath, { repoRoot });
  const referenceArchive = fs.readFileSync(referencePath);
  let referenceZip;
  try {
    referenceZip = await JSZip.loadAsync(referenceArchive, { checkCRC32: true });
  } catch (error) {
    throw new Error(`Invalid reference VSIX ZIP: ${error.message}`);
  }

  for (const name of ALLOWED_FILES) {
    const [candidateBytes, referenceBytes] = await Promise.all([
      candidateZip.file(name).async('nodebuffer'),
      referenceZip.file(name).async('nodebuffer'),
    ]);
    if (!candidateBytes.equals(referenceBytes)) {
      throw new Error(`VSIX entry bytes differ from the packaged reference: ${name}`);
    }
  }

  if (!candidateArchive.equals(referenceArchive)) {
    throw new Error('VSIX archive metadata differs from the packaged reference');
  }
};

const assertPackageMetadata = (repoPackage, extensionPackage) => {
  for (const field of ['name', 'publisher', 'version', 'main']) {
    if (extensionPackage[field] !== repoPackage[field]) {
      throw new Error(`extension/package.json ${field} does not match repository package.json`);
    }
  }
};

const assertManifestMetadata = (repoPackage, identity) => {
  const expected = {
    Id: repoPackage.name,
    Publisher: repoPackage.publisher,
    Version: repoPackage.version,
    TargetPlatform: TARGET,
  };

  for (const [field, value] of Object.entries(expected)) {
    if (identity[field] !== value) {
      throw new Error(
        `extension.vsixmanifest ${field} must be ${value}, received ${identity[field]}`,
      );
    }
  }
};

const verifyVsix = async (vsixPath, options = {}) => {
  const repoRoot = path.resolve(options.repoRoot ?? path.join(__dirname, '../..'));
  const repoPackage = readJson(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    'repository package.json',
  );
  const expectedName = expectedArtifactName(repoPackage);
  if (path.basename(vsixPath) !== expectedName) {
    throw new Error(
      `Artifact filename must be ${expectedName}, received ${path.basename(vsixPath)}`,
    );
  }

  const archive = fs.readFileSync(vsixPath);
  let rawNames;
  try {
    rawNames = readCentralDirectoryNames(archive);
  } catch (error) {
    throw new Error(`Invalid VSIX ZIP: ${error.message}`);
  }
  assertSafeArchivePaths(rawNames);

  let zip;
  try {
    zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  } catch (error) {
    throw new Error(`Invalid VSIX ZIP: ${error.message}`);
  }

  const names = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
  const sortedRawNames = [...rawNames].sort();
  assertExactFileSet(sortedRawNames);
  assertExactFileSet(names);

  if (
    names.length !== sortedRawNames.length ||
    names.some((name, index) => name !== sortedRawNames[index])
  ) {
    throw new Error('Invalid VSIX ZIP: decoded ZIP paths do not match central directory paths');
  }

  const extensionPackage = readJson(
    await readZipText(zip, 'extension/package.json'),
    'extension/package.json',
  );
  assertPackageMetadata(repoPackage, extensionPackage);

  const identity = parseIdentity(await readZipText(zip, 'extension.vsixmanifest'));
  assertManifestMetadata(repoPackage, identity);

  const packagedMain = zip.file(`extension/${repoPackage.main.replace(/^\.\//, '')}`);
  if (!packagedMain) {
    throw new Error(`VSIX is missing extension/${repoPackage.main}`);
  }
  const [packagedDist, repoDist] = await Promise.all([
    packagedMain.async('nodebuffer'),
    fs.promises.readFile(path.join(repoRoot, repoPackage.main)),
  ]);
  if (!packagedDist.equals(repoDist)) {
    throw new Error(`extension/dist/extension.js bytes do not match the repository build`);
  }

  if (options.referencePath) {
    await assertMatchesReference(archive, zip, path.resolve(options.referencePath), repoRoot);
  }

  return {
    artifactName: path.basename(vsixPath),
    fileCount: names.length,
    size: archive.length,
  };
};

const runCli = async () => {
  const [vsixPath, referenceFlag, referencePath, ...rest] = process.argv.slice(2);
  if (
    !vsixPath ||
    rest.length > 0 ||
    (referenceFlag !== undefined && (referenceFlag !== '--reference' || !referencePath))
  ) {
    throw new Error('Usage: node verify-vsix.cjs <artifact.vsix> [--reference <artifact.vsix>]');
  }

  const result = await verifyVsix(path.resolve(vsixPath), {
    referencePath: referencePath ? path.resolve(referencePath) : undefined,
  });
  process.stdout.write(
    `Verified ${result.artifactName}: ${result.fileCount} files, ${result.size} bytes\n`,
  );
};

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  expectedArtifactName,
  verifyVsix,
};
