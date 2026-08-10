'use strict';

const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const packageMetadata = require('../../package.json');
const { buildDownloadOptions, runInstalledVSIXVerification } = require('./runner.cjs');

const USAGE = 'Usage: node test/e2e/run-vsix.cjs <vsixPath> <previousVersion> <previousVsixPath>';

const main = async ({
  argv = process.argv.slice(2),
  environment = process.env,
  packageMetadata: candidatePackage = packageMetadata,
  downloadVSCode = downloadAndUnzipVSCode,
  runVerification = runInstalledVSIXVerification,
} = {}) => {
  if (argv.length !== 3) throw new Error(USAGE);
  const [vsixPath, baselineVersion, baselineVsixPath] = argv;
  const vscodeExecutablePath = await downloadVSCode(buildDownloadOptions(environment));
  await runVerification({
    vscodeExecutablePath,
    vsixPath,
    candidateVersion: candidatePackage.version,
    baselineVersion,
    baselineVsixPath,
  });
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
