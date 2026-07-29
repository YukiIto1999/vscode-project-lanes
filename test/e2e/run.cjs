'use strict';

const { runTests } = require('@vscode/test-electron');
const { runScenario } = require('./runner.cjs');
const { resolveScenarios } = require('./scenarios.cjs');

const main = async () => {
  const selectedScenarios = resolveScenarios(process.argv.slice(2));
  for (const scenario of selectedScenarios) {
    console.log(`Running E2E scenario: ${scenario.name}`);
    await runScenario(scenario, { runTests });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
