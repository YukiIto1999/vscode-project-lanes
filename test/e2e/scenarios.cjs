'use strict';

const path = require('node:path');

const scenarios = Object.freeze([
  Object.freeze({
    name: 'empty-workspace',
    workspaceFixture: path.join(__dirname, 'fixtures', 'empty.code-workspace'),
    suitePath: path.join(__dirname, 'suite', 'empty-workspace.cjs'),
  }),
  Object.freeze({
    name: 'workspace-bootstrap',
    fixtureRoot: path.join(__dirname, 'fixtures', 'workspace-bootstrap'),
    workspaceFixture: path.join(
      __dirname,
      'fixtures',
      'workspace-bootstrap',
      'workspace-bootstrap.code-workspace',
    ),
    suitePath: path.join(__dirname, 'suite', 'workspace-bootstrap.cjs'),
    launches: Object.freeze([
      Object.freeze({ phase: 'bootstrap' }),
      Object.freeze({ phase: 'restart' }),
    ]),
  }),
  Object.freeze({
    name: 'workspace-manual-initialization',
    fixtureRoot: path.join(__dirname, 'fixtures', 'workspace-manual-initialization'),
    workspaceFixture: path.join(
      __dirname,
      'fixtures',
      'workspace-manual-initialization',
      'workspace-manual-initialization.code-workspace',
    ),
    suitePath: path.join(__dirname, 'suite', 'workspace-manual-initialization.cjs'),
    launches: Object.freeze([
      Object.freeze({ phase: 'manual-first' }),
      Object.freeze({ phase: 'manual-restart' }),
      Object.freeze({ phase: 'initialize' }),
      Object.freeze({ phase: 'managed-restart' }),
    ]),
  }),
  Object.freeze({
    name: 'lane-switch-transaction',
    fixtureRoot: path.join(__dirname, 'fixtures', 'lane-switch-transaction'),
    workspaceFixture: path.join(
      __dirname,
      'fixtures',
      'lane-switch-transaction',
      'lane-switch-transaction.code-workspace',
    ),
    suitePath: path.join(__dirname, 'suite', 'lane-switch-transaction.cjs'),
    launches: Object.freeze([
      Object.freeze({ phase: 'bootstrap' }),
      Object.freeze({ phase: 'transaction' }),
      Object.freeze({ phase: 'restart' }),
    ]),
  }),
  Object.freeze({
    name: 'active-lane-reconciliation',
    fixtureRoot: path.join(__dirname, 'fixtures', 'active-lane-reconciliation'),
    workspaceFixture: path.join(
      __dirname,
      'fixtures',
      'active-lane-reconciliation',
      'active-lane-reconciliation.code-workspace',
    ),
    suitePath: path.join(__dirname, 'suite', 'active-lane-reconciliation.cjs'),
    launches: Object.freeze([
      Object.freeze({ phase: 'prepare-stale-cache' }),
      Object.freeze({ phase: 'reload-and-remove-link' }),
      Object.freeze({ phase: 'restore-missing-link' }),
    ]),
  }),
  Object.freeze({
    name: 'missing-lane-recovery',
    fixtureRoot: path.join(__dirname, 'fixtures', 'missing-lane-recovery'),
    workspaceFixture: path.join(
      __dirname,
      'fixtures',
      'missing-lane-recovery',
      'missing-lane-recovery.code-workspace',
    ),
    suitePath: path.join(__dirname, 'suite', 'missing-lane-recovery.cjs'),
    launches: Object.freeze([
      Object.freeze({ phase: 'prepare-missing-active' }),
      Object.freeze({ phase: 'locate-and-reconcile' }),
      Object.freeze({ phase: 'restart-and-switch-recovered' }),
    ]),
  }),
  Object.freeze({
    name: 'legacy-anchor-classification',
    fixtureRoot: path.join(__dirname, 'fixtures', 'legacy-anchor-classification'),
    workspaceFixture: path.join(
      __dirname,
      'fixtures',
      'legacy-anchor-classification',
      'legacy-anchor-classification.code-workspace',
    ),
    suitePath: path.join(__dirname, 'suite', 'legacy-anchor-classification.cjs'),
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
