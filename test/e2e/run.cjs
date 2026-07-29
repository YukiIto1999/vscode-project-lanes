'use strict';

const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { buildDownloadOptions, launchVSCodeProcess, runScenario } = require('./runner.cjs');
const { resolveScenarios } = require('./scenarios.cjs');

const main = async () => {
  const selectedScenarios = resolveScenarios(process.argv.slice(2));
  const vscodeExecutablePath = await downloadAndUnzipVSCode(buildDownloadOptions());
  for (const scenario of selectedScenarios) {
    console.log(`Running E2E scenario: ${scenario.name}`);
    await runScenario(scenario, {
      launchVSCode: launchVSCodeProcess,
      vscodeExecutablePath,
    });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
