'use strict';

const path = require('node:path');

const scenarios = Object.freeze([
  Object.freeze({
    name: 'empty-workspace',
    workspaceFixture: path.join(__dirname, 'fixtures', 'empty.code-workspace'),
    extensionTestsPath: path.join(__dirname, 'suite', 'empty-workspace.cjs'),
  }),
]);

const resolveScenarios = (requestedNames, availableScenarios = scenarios) => {
  const byName = new Map(availableScenarios.map((scenario) => [scenario.name, scenario]));
  const selected =
    requestedNames.length === 0
      ? [...availableScenarios]
      : requestedNames.map((name) => {
          const scenario = byName.get(name);
          if (!scenario) throw new Error(`Unknown E2E scenario: ${name}`);
          return scenario;
        });

  if (selected.length === 0) throw new Error('No E2E scenarios selected');
  return selected;
};

module.exports = { resolveScenarios, scenarios };
