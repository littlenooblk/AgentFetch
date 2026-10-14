#!/usr/bin/env node
import { Command } from 'commander';
import { CapabilityRegistry } from '../registry/index.js';

const program = new Command().name('agent-fetch-registry').description('查看和确认 AgentFetch 持久化能力').option('--file <path>', 'registry JSON 文件路径');
program.command('list').option('--domain <domain>').option('--status <status>').option('--text <text>').action((options, command) => {
  const registry = new CapabilityRegistry(command.parent?.opts().file);
  console.log(JSON.stringify(registry.query({ domain: options.domain, status: options.status, text: options.text }), null, 2));
});
program.command('confirm <id>').action((id, _options, command) => {
  const registry = new CapabilityRegistry(command.parent?.opts().file);
  console.log(JSON.stringify(registry.confirm(id), null, 2));
});
program.command('disable <id>').action((id, _options, command) => {
  const registry = new CapabilityRegistry(command.parent?.opts().file);
  console.log(JSON.stringify(registry.updateStatus(id, 'disabled'), null, 2));
});
program.parseAsync().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
