/**
 * Core pipeline materializer.
 *
 * Reads pipeline and step entities from the rit store and generates
 * an executable runner module that can match triggers, resolve
 * dependencies, and execute steps.
 */

import type { Repository } from '@rit/core';
import type { AstEntityWrite } from '@rit/sigil/src/projector.js';
import { materialize as sigilMaterialize } from '@rit/sigil/src/materializer.js';

// --- Entity interfaces ---

export interface PipelineEntity {
  name: string;
  trigger: string;
  description: string;
}

export interface StepEntity {
  pipeline: string;
  name: string;
  command: string;
  action: string;
  order: number;
  dependsOn: string[];
  description: string;
  env: string;
}

export interface GeneratedModule {
  moduleId: string;
  code: string;
}

// --- Entity readers ---

export async function readPipelines(repo: Repository): Promise<PipelineEntity[]> {
  const pipelines: PipelineEntity[] = [];

  for await (const key of repo.keys('pipeline:*')) {
    const name = key.slice('pipeline:'.length);
    const fields = await repo.hgetall(key);
    if (!fields.name || !fields.trigger) continue;

    pipelines.push({
      name,
      trigger: fields.trigger,
      description: fields.description || '',
    });
  }

  return pipelines;
}

export async function readSteps(repo: Repository): Promise<StepEntity[]> {
  const steps: StepEntity[] = [];

  for await (const key of repo.keys('step:*')) {
    const fields = await repo.hgetall(key);
    if (!fields.pipeline || !fields.name) continue;

    steps.push({
      pipeline: fields.pipeline,
      name: fields.name,
      command: fields.command || '',
      action: fields.action || '',
      order: Number(fields.order) || 0,
      dependsOn: fields.dependsOn ? fields.dependsOn.split(',').map(s => s.trim()).filter(Boolean) : [],
      description: fields.description || '',
      env: fields.env || '',
    });
  }

  return steps;
}

// --- Sigil module reading ---

async function readSigilModule(repo: Repository, moduleId: string): Promise<string | null> {
  const writes: AstEntityWrite[] = [];

  const moduleFields = await repo.hgetall(`module:${moduleId}`);
  if (Object.keys(moduleFields).length === 0) return null;
  writes.push({ key: `module:${moduleId}`, fields: moduleFields });

  for await (const key of repo.keys(`ast:${moduleId}.*`)) {
    const fields = await repo.hgetall(key);
    if (Object.keys(fields).length > 0) {
      writes.push({ key, fields });
    }
  }

  if (writes.length <= 1) return null;
  return sigilMaterialize(writes);
}

// --- Trigger matching ---

function matchTrigger(trigger: string, event: string, branch: string): boolean {
  if (event !== 'push') return trigger === 'manual';

  const parts = trigger.split(':');
  if (parts[0] !== 'push') return false;

  const pattern = parts[1] || '*';
  if (pattern === '*') return true;
  return pattern === branch;
}

// --- Dependency resolution ---

function topoSort(steps: StepEntity[]): StepEntity[] {
  const byName = new Map<string, StepEntity>();
  for (const s of steps) byName.set(s.name, s);

  const visited = new Set<string>();
  const sorted: StepEntity[] = [];

  function visit(step: StepEntity) {
    if (visited.has(step.name)) return;
    visited.add(step.name);

    for (const depRef of step.dependsOn) {
      // dependsOn refs are like "step:pipeline:deploy:build" or just "build"
      const depName = depRef.includes(':') ? depRef.split(':').pop()! : depRef;
      const dep = byName.get(depName);
      if (dep) visit(dep);
    }

    sorted.push(step);
  }

  // Sort by order first, then topological
  const byOrder = [...steps].sort((a, b) => a.order - b.order);
  for (const step of byOrder) visit(step);

  return sorted;
}

// --- Code generation ---

function indent(s: string, prefix: string): string {
  return s.split('\n').map(l => l.length > 0 ? prefix + l : l).join('\n');
}

function dedent(s: string): string {
  const lines = s.split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const ind = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (ind < minIndent) minIndent = ind;
  }
  if (minIndent === Infinity || minIndent === 0) return s;
  return lines.map(l => l.slice(minIndent)).join('\n');
}

async function generateStepFunction(
  step: StepEntity,
  repo: Repository,
): Promise<{ name: string; code: string; isAction: boolean }> {
  const fnName = `step_${step.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

  // If the step has an action (Sigil module reference), materialize it
  if (step.action) {
    const body = await readSigilModule(repo, step.action);
    if (body) {
      const bodyCode = dedent(body.trim());
      return {
        name: fnName,
        code: `async function ${fnName}(ctx: StepContext): Promise<StepResult> {\n${indent(bodyCode, '  ')}\n}`,
        isAction: true,
      };
    }
  }

  // Fall back to command execution
  if (step.command) {
    const envSetup = step.env
      ? `  const env = { ...process.env, ...${step.env} };\n`
      : '  const env = process.env;\n';

    return {
      name: fnName,
      code: [
        `async function ${fnName}(ctx: StepContext): Promise<StepResult> {`,
        envSetup,
        `  const proc = Bun.spawn(['sh', '-c', ${JSON.stringify(step.command)}], {`,
        `    env,`,
        `    stdout: 'pipe',`,
        `    stderr: 'pipe',`,
        `  });`,
        ``,
        `  const stdout = await new Response(proc.stdout).text();`,
        `  const stderr = await new Response(proc.stderr).text();`,
        `  const exitCode = await proc.exited;`,
        ``,
        `  return {`,
        `    output: stdout + (stderr ? '\\n' + stderr : ''),`,
        `    success: exitCode === 0,`,
        `  };`,
        `}`,
      ].join('\n'),
      isAction: false,
    };
  }

  return {
    name: fnName,
    code: `async function ${fnName}(ctx: StepContext): Promise<StepResult> {\n  return { output: 'No command or action defined', success: false };\n}`,
    isAction: false,
  };
}

// --- Main materializer ---

export async function generateRunnerModule(repo: Repository): Promise<GeneratedModule[]> {
  const pipelines = await readPipelines(repo);
  const allSteps = await readSteps(repo);

  if (pipelines.length === 0) return [];

  const sections: string[] = [];

  // Type definitions
  sections.push(`// Generated pipeline runner`);
  sections.push(`// Do not edit; materialized from pipeline entities.`);
  sections.push('');
  sections.push(`interface StepContext {`);
  sections.push(`  pipeline: string;`);
  sections.push(`  step: string;`);
  sections.push(`  branch: string;`);
  sections.push(`  commitHash: string;`);
  sections.push(`  env: Record<string, string>;`);
  sections.push(`}`);
  sections.push('');
  sections.push(`interface StepResult {`);
  sections.push(`  output: string;`);
  sections.push(`  success: boolean;`);
  sections.push(`}`);
  sections.push('');
  sections.push(`interface PipelineResult {`);
  sections.push(`  pipeline: string;`);
  sections.push(`  status: 'success' | 'failure';`);
  sections.push(`  steps: Array<{ name: string; status: 'success' | 'failure'; output: string }>;`);
  sections.push(`}`);
  sections.push('');

  // Trigger matcher
  sections.push(`function matchTrigger(trigger: string, event: string, branch: string): boolean {`);
  sections.push(`  if (event !== 'push') return trigger === 'manual';`);
  sections.push(`  const parts = trigger.split(':');`);
  sections.push(`  if (parts[0] !== 'push') return false;`);
  sections.push(`  const pattern = parts[1] || '*';`);
  sections.push(`  if (pattern === '*') return true;`);
  sections.push(`  return pattern === branch;`);
  sections.push(`}`);
  sections.push('');

  // Pipeline definitions (static data)
  const pipelineDefs: string[] = [];
  for (const p of pipelines) {
    const pipelineSteps = allSteps
      .filter(s => s.pipeline === p.name || s.pipeline === `pipeline:${p.name}`)
    const sorted = topoSort(pipelineSteps);

    pipelineDefs.push(`  ${JSON.stringify(p.name)}: {`);
    pipelineDefs.push(`    trigger: ${JSON.stringify(p.trigger)},`);
    pipelineDefs.push(`    steps: [${sorted.map(s => JSON.stringify(s.name)).join(', ')}],`);
    pipelineDefs.push(`  },`);
  }
  sections.push(`const pipelines: Record<string, { trigger: string; steps: string[] }> = {`);
  sections.push(pipelineDefs.join('\n'));
  sections.push(`};`);
  sections.push('');

  // Step functions
  const stepFnMap: Map<string, string> = new Map();
  for (const step of allSteps) {
    const fn = await generateStepFunction(step, repo);
    sections.push(fn.code);
    sections.push('');
    stepFnMap.set(step.name, fn.name);
  }

  // Step dispatch map
  sections.push(`const stepFns: Record<string, (ctx: StepContext) => Promise<StepResult>> = {`);
  for (const [stepName, fnName] of stepFnMap) {
    sections.push(`  ${JSON.stringify(stepName)}: ${fnName},`);
  }
  sections.push(`};`);
  sections.push('');

  // Event reporter type
  sections.push(`type EventReporter = (event: {`);
  sections.push(`  type: 'pipeline-start' | 'step-start' | 'step-complete' | 'pipeline-complete';`);
  sections.push(`  pipeline: string;`);
  sections.push(`  step?: string;`);
  sections.push(`  status?: string;`);
  sections.push(`  output?: string;`);
  sections.push(`  timestamp: string;`);
  sections.push(`}) => Promise<void>;`);
  sections.push('');

  // Main runner function
  sections.push(`export async function runMatchingPipelines(`);
  sections.push(`  event: string,`);
  sections.push(`  branch: string,`);
  sections.push(`  commitHash: string,`);
  sections.push(`  report: EventReporter,`);
  sections.push(`): Promise<PipelineResult[]> {`);
  sections.push(`  const results: PipelineResult[] = [];`);
  sections.push('');
  sections.push(`  for (const [name, def] of Object.entries(pipelines)) {`);
  sections.push(`    if (!matchTrigger(def.trigger, event, branch)) continue;`);
  sections.push('');
  sections.push(`    await report({ type: 'pipeline-start', pipeline: name, timestamp: new Date().toISOString() });`);
  sections.push('');
  sections.push(`    const stepResults: PipelineResult['steps'] = [];`);
  sections.push(`    let failed = false;`);
  sections.push('');
  sections.push(`    for (const stepName of def.steps) {`);
  sections.push(`      if (failed) {`);
  sections.push(`        stepResults.push({ name: stepName, status: 'failure', output: 'Skipped (prior step failed)' });`);
  sections.push(`        continue;`);
  sections.push(`      }`);
  sections.push('');
  sections.push(`      await report({ type: 'step-start', pipeline: name, step: stepName, timestamp: new Date().toISOString() });`);
  sections.push('');
  sections.push(`      const fn = stepFns[stepName];`);
  sections.push(`      if (!fn) {`);
  sections.push(`        stepResults.push({ name: stepName, status: 'failure', output: 'No step function found' });`);
  sections.push(`        failed = true;`);
  sections.push(`        await report({ type: 'step-complete', pipeline: name, step: stepName, status: 'failure', output: 'No step function found', timestamp: new Date().toISOString() });`);
  sections.push(`        continue;`);
  sections.push(`      }`);
  sections.push('');
  sections.push(`      const result = await fn({ pipeline: name, step: stepName, branch, commitHash, env: {} });`);
  sections.push(`      const status = result.success ? 'success' : 'failure';`);
  sections.push(`      stepResults.push({ name: stepName, status, output: result.output });`);
  sections.push(`      if (!result.success) failed = true;`);
  sections.push('');
  sections.push(`      await report({ type: 'step-complete', pipeline: name, step: stepName, status, output: result.output, timestamp: new Date().toISOString() });`);
  sections.push(`    }`);
  sections.push('');
  sections.push(`    const pipelineStatus = failed ? 'failure' : 'success';`);
  sections.push(`    results.push({ pipeline: name, status: pipelineStatus, steps: stepResults });`);
  sections.push(`    await report({ type: 'pipeline-complete', pipeline: name, status: pipelineStatus, timestamp: new Date().toISOString() });`);
  sections.push(`  }`);
  sections.push('');
  sections.push(`  return results;`);
  sections.push(`}`);

  return [{
    moduleId: 'pipeline-runner',
    code: sections.join('\n'),
  }];
}

// --- Exports for direct use (non-materialized) ---

export { matchTrigger, topoSort };
