const assert = require('node:assert/strict');
const test = require('node:test');

const subject = (() => {
  try {
    return require('./inspect-checkpoint.cjs');
  } catch {
    return {};
  }
})();

const VSIX_NAME = 'project-lanes-linux-x64-0.1.13.vsix';
const CHECKSUM_NAME = `${VSIX_NAME}.sha256`;

const inspect = (options = {}) =>
  subject.inspectReleaseCheckpoint({
    tagExists: false,
    release: undefined,
    vsixName: VSIX_NAME,
    checksumName: CHECKSUM_NAME,
    ...options,
  });

test('classifies every safe release checkpoint state', () => {
  assert.equal(typeof subject.inspectReleaseCheckpoint, 'function');

  for (const [label, input, expected] of [
    [
      'uncreated release',
      {},
      {
        complete: false,
        releaseExists: false,
        tagExists: false,
        reuse: false,
        repairChecksum: false,
        download: 'none',
      },
    ],
    [
      'published release',
      {
        tagExists: true,
        release: {
          draft: false,
          assets: [{ name: VSIX_NAME }, { name: CHECKSUM_NAME }],
        },
      },
      {
        complete: true,
        releaseExists: true,
        tagExists: true,
        reuse: false,
        repairChecksum: false,
        download: 'none',
      },
    ],
    [
      'complete draft',
      {
        tagExists: true,
        release: {
          draft: true,
          assets: [{ name: CHECKSUM_NAME }, { name: VSIX_NAME }],
        },
      },
      {
        complete: false,
        releaseExists: true,
        tagExists: true,
        reuse: true,
        repairChecksum: false,
        download: 'all',
      },
    ],
    [
      'VSIX-only draft',
      {
        tagExists: true,
        release: {
          draft: true,
          assets: [{ name: VSIX_NAME }],
        },
      },
      {
        complete: false,
        releaseExists: true,
        tagExists: true,
        reuse: true,
        repairChecksum: true,
        download: 'vsix',
      },
    ],
    [
      'empty draft',
      {
        tagExists: true,
        release: { draft: true, assets: [] },
      },
      {
        complete: false,
        releaseExists: true,
        tagExists: true,
        reuse: false,
        repairChecksum: false,
        download: 'none',
      },
    ],
  ]) {
    assert.deepEqual(inspect(input), expected, label);
  }
});

test('rejects unsafe or inconsistent release checkpoint states', () => {
  assert.throws(
    () =>
      inspect({
        tagExists: true,
        release: null,
      }),
    /invalid shape/i,
  );

  assert.throws(
    () =>
      inspect({
        release: { draft: true, assets: [] },
      }),
    /without a fetched tag/i,
  );

  assert.throws(
    () =>
      inspect({
        tagExists: true,
        release: {
          draft: false,
          assets: [{ name: VSIX_NAME }],
        },
      }),
    /published release.*exact release assets/i,
  );

  for (const assets of [
    [{ name: CHECKSUM_NAME }],
    [{ name: VSIX_NAME }, { name: 'unexpected.txt' }],
    [{ name: VSIX_NAME }, { name: VSIX_NAME }],
  ]) {
    assert.throws(
      () =>
        inspect({
          tagExists: true,
          release: { draft: true, assets },
        }),
      /unsafe partial or unexpected asset set/i,
    );
  }
});
