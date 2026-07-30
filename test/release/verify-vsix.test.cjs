const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const JSZip = require('jszip');
const crc32 = require('jszip/lib/crc32');

const subject = (() => {
  try {
    return require('./verify-vsix.cjs');
  } catch {
    return {};
  }
})();

const EXPECTED_FILES = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/LICENSE.txt',
  'extension/changelog.md',
  'extension/dist/extension.js',
  'extension/media/icon.png',
  'extension/media/icon.svg',
  'extension/node_modules/@vscode/ripgrep-linux-x64/LICENSE',
  'extension/node_modules/@vscode/ripgrep-linux-x64/bin/rg',
  'extension/node_modules/@vscode/ripgrep-linux-x64/package.json',
  'extension/node_modules/node-pty/LICENSE',
  'extension/node_modules/node-pty/build/Release/pty.node',
  'extension/node_modules/node-pty/lib/eventEmitter2.js',
  'extension/node_modules/node-pty/lib/index.js',
  'extension/node_modules/node-pty/lib/terminal.js',
  'extension/node_modules/node-pty/lib/unixTerminal.js',
  'extension/node_modules/node-pty/lib/utils.js',
  'extension/node_modules/node-pty/package.json',
  'extension/package.json',
  'extension/readme.md',
  'extension/resources/shell-integration/lanes-bash.sh',
  'extension/resources/shell-integration/zsh/.zlogin',
  'extension/resources/shell-integration/zsh/.zprofile',
  'extension/resources/shell-integration/zsh/.zshenv',
  'extension/resources/shell-integration/zsh/.zshrc',
];

const REPO_PACKAGE = {
  name: 'project-lanes',
  publisher: 'yukiito1999',
  version: '0.1.12',
  main: './dist/extension.js',
};

const DIST_BYTES = Buffer.from('module.exports = { activate() {} };\n');

const identityManifest = (attributes = {}) => {
  const identity = {
    Language: 'en-US',
    Id: REPO_PACKAGE.name,
    Version: REPO_PACKAGE.version,
    Publisher: REPO_PACKAGE.publisher,
    TargetPlatform: 'linux-x64',
    ...attributes,
  };
  const serialized = Object.entries(identity)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ');

  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0">
  <Metadata><Identity ${serialized}/></Metadata>
</PackageManifest>`;
};

const createFixture = async (t, options = {}) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-vsix-test-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify(REPO_PACKAGE, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repoRoot, 'dist', 'extension.js'), DIST_BYTES);

  const files = new Map(EXPECTED_FILES.map((name) => [name, Buffer.from(`fixture:${name}\n`)]));
  files.set(
    'extension/package.json',
    Buffer.from(`${JSON.stringify({ ...REPO_PACKAGE, ...options.extensionPackage }, null, 2)}\n`),
  );
  files.set(
    'extension.vsixmanifest',
    Buffer.from(options.manifest ?? identityManifest(options.identity)),
  );
  files.set('extension/dist/extension.js', options.distBytes ?? DIST_BYTES);

  for (const missing of options.missing ?? []) {
    files.delete(missing);
  }
  for (const [name, contents = 'unexpected'] of options.extras ?? []) {
    files.set(name, Buffer.from(contents));
  }

  const artifactName = options.artifactName ?? 'project-lanes-linux-x64-0.1.12.vsix';
  const vsixPath = path.join(repoRoot, artifactName);

  if (options.rawEntries) {
    fs.writeFileSync(vsixPath, createRawZip(options.rawEntries(files)));
  } else if (options.malformed) {
    fs.writeFileSync(vsixPath, Buffer.from('not a zip'));
  } else {
    const zip = new JSZip();
    for (const [name, contents] of files) {
      zip.file(name, contents, {
        createFolders: false,
        date: new Date('2020-01-01T00:00:00.000Z'),
        unixPermissions: options.permissions?.[name],
      });
    }
    fs.writeFileSync(
      vsixPath,
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        platform: 'UNIX',
      }),
    );
  }

  return { repoRoot, vsixPath };
};

const createRawZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, value, unicodeName] of entries) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(value);
    const checksum = crc32(contents) >>> 0;
    const extra = (() => {
      if (!unicodeName) return Buffer.alloc(0);
      const unicodeNameBytes = Buffer.from(unicodeName);
      const unicodePath = Buffer.alloc(9 + unicodeNameBytes.length);
      unicodePath.writeUInt16LE(0x7075, 0);
      unicodePath.writeUInt16LE(5 + unicodeNameBytes.length, 2);
      unicodePath.writeUInt8(1, 4);
      unicodePath.writeUInt32LE(crc32(nameBytes) >>> 0, 5);
      unicodeNameBytes.copy(unicodePath, 9);
      return unicodePath;
    })();
    const generalPurposeFlags = unicodeName ? 0 : 0x0800;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(generalPurposeFlags, 6);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(extra.length, 28);
    localParts.push(localHeader, nameBytes, extra, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(generalPurposeFlags, 8);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(extra.length, 30);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes, extra);

    localOffset += localHeader.length + nameBytes.length + extra.length + contents.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
};

test('accepts the exact linux-x64 release artifact contract', async (t) => {
  assert.equal(typeof subject.verifyVsix, 'function');
  const fixture = await createFixture(t);

  const result = await subject.verifyVsix(fixture.vsixPath, {
    repoRoot: fixture.repoRoot,
  });

  assert.equal(result.fileCount, EXPECTED_FILES.length);
  assert.equal(result.artifactName, path.basename(fixture.vsixPath));
  assert.equal(result.size, fs.statSync(fixture.vsixPath).size);
});

test('requires the exact artifact filename', async (t) => {
  const fixture = await createFixture(t, { artifactName: 'project-lanes.vsix' });

  await assert.rejects(
    subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
    /artifact filename.*project-lanes-linux-x64-0\.1\.12\.vsix/i,
  );
});

test('requires every allowlisted file and rejects unexpected files', async (t) => {
  const missing = await createFixture(t, {
    missing: ['extension/media/icon.svg'],
  });
  await assert.rejects(
    subject.verifyVsix(missing.vsixPath, { repoRoot: missing.repoRoot }),
    /missing.*extension\/media\/icon\.svg/i,
  );

  const unexpected = await createFixture(t, {
    extras: [['extension/notes.txt']],
  });
  await assert.rejects(
    subject.verifyVsix(unexpected.vsixPath, { repoRoot: unexpected.repoRoot }),
    /unexpected.*extension\/notes\.txt/i,
  );
});

for (const [label, file, expected] of [
  ['release notes scratch file', '.release-notes.md', /release notes/i],
  ['secret file', 'extension/.env.production', /secret/i],
  ['source map', 'extension/dist/extension.js.map', /source map/i],
  ['repository internals', 'extension/.git/config', /repository internal/i],
]) {
  test(`rejects ${label}`, async (t) => {
    const fixture = await createFixture(t, { extras: [[file]] });

    await assert.rejects(
      subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
      expected,
    );
  });
}

for (const [label, rawName, expected] of [
  ['traversal paths', '../secret.txt', /traversal/i],
  ['absolute POSIX paths', '/secret.txt', /absolute/i],
  ['absolute Windows paths', 'C:\\secret.txt', /absolute/i],
]) {
  test(`rejects ${label}`, async (t) => {
    const fixture = await createFixture(t, {
      rawEntries: (files) => [...files, [rawName, Buffer.from('secret')]],
    });

    await assert.rejects(
      subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
      expected,
    );
  });
}

test('rejects duplicate archive entries before JSZip can overwrite them', async (t) => {
  const fixture = await createFixture(t, {
    rawEntries: (files) => [...files, ['extension/package.json', Buffer.from('{}')]],
  });

  await assert.rejects(
    subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
    /duplicate.*extension\/package\.json/i,
  );
});

test('rejects a Unicode path extra field that decodes to another file', async (t) => {
  const fixture = await createFixture(t, {
    rawEntries: (files) =>
      [...files].map(([name, value]) =>
        name === 'extension/media/icon.svg'
          ? [name, value, 'extension/.env.production']
          : [name, value],
      ),
  });

  await assert.rejects(
    subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
    /decoded ZIP paths do not match central directory paths|secret file/i,
  );
});

for (const [field, value] of [
  ['name', 'other-extension'],
  ['publisher', 'other-publisher'],
  ['version', '9.9.9'],
  ['main', './other.js'],
]) {
  test(`requires extension/package.json ${field} to match the repository`, async (t) => {
    const fixture = await createFixture(t, {
      extensionPackage: { [field]: value },
    });

    await assert.rejects(
      subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
      new RegExp(`package\\.json.*${field}`, 'i'),
    );
  });
}

for (const [field, value] of [
  ['Id', 'other-extension'],
  ['Publisher', 'other-publisher'],
  ['Version', '9.9.9'],
  ['TargetPlatform', 'darwin-arm64'],
]) {
  test(`requires extension.vsixmanifest ${field}`, async (t) => {
    const fixture = await createFixture(t, {
      identity: { [field]: value },
    });

    await assert.rejects(
      subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
      new RegExp(`vsixmanifest.*${field}`, 'i'),
    );
  });
}

test('requires packaged dist bytes to match the repository build', async (t) => {
  const fixture = await createFixture(t, {
    distBytes: Buffer.from('different build'),
  });

  await assert.rejects(
    subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
    /dist\/extension\.js.*bytes/i,
  );
});

test('requires every reused VSIX entry to match a freshly packaged reference', async (t) => {
  const reference = await createFixture(t);
  const reused = await createFixture(t, {
    extras: [['extension/node_modules/node-pty/lib/index.js', 'tampered runtime']],
  });

  await assert.rejects(
    subject.verifyVsix(reused.vsixPath, {
      repoRoot: reused.repoRoot,
      referencePath: reference.vsixPath,
    }),
    /entry bytes differ.*extension\/node_modules\/node-pty\/lib\/index\.js/i,
  );
});

test('requires reused VSIX archive metadata to match the packaged reference', async (t) => {
  const ripgrep = 'extension/node_modules/@vscode/ripgrep-linux-x64/bin/rg';
  const reference = await createFixture(t, {
    permissions: { [ripgrep]: 0o100755 },
  });
  const reused = await createFixture(t, {
    permissions: { [ripgrep]: 0o100644 },
  });

  await assert.rejects(
    subject.verifyVsix(reused.vsixPath, {
      repoRoot: reused.repoRoot,
      referencePath: reference.vsixPath,
    }),
    /archive metadata differs from the packaged reference/i,
  );
});

test('rejects a manifest with a decoy Identity element', async (t) => {
  const decoy = identityManifest();
  const actual = identityManifest({ Version: '9.9.9' });
  const fixture = await createFixture(t, {
    manifest: `<!-- ${decoy} -->\n${actual}`,
  });

  await assert.rejects(
    subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
    /vsixmanifest.*exactly one Identity/i,
  );
});

test('rejects malformed ZIP input', async (t) => {
  const fixture = await createFixture(t, { malformed: true });

  await assert.rejects(
    subject.verifyVsix(fixture.vsixPath, { repoRoot: fixture.repoRoot }),
    /invalid VSIX ZIP/i,
  );
});
