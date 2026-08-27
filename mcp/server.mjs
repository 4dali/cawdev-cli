#!/usr/bin/env node
// cawdev's MCP server: a coding agent's view of a project's roadmap and
// changelog. Plain Node, zero dependencies, stdio JSON-RPC.
//
// Drop it into any repository's .mcp.json — see README.md.
//
// It is deliberately a *translation*. The API's verbs were built to mirror
// these tools one-for-one (R4, R5), so there is no second implementation here
// with its own opinions about what a status means. If a rule seems to be
// missing from this file, it is because the server enforces it and the refusal
// is passed through verbatim — the API's message is the one that explains the
// rule.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const NAME = 'cawdev';
const VERSION = '0.1.0';

/** MCP revision we implement. A client asking for another is echoed its own. */
const PROTOCOL_VERSION = '2024-11-05';

// --- configuration ----------------------------------------------------------

/**
 * Read on EVERY call, never cached.
 *
 * dycrypt learned this the hard way and the lesson is worth keeping: an agent
 * that has been writing to the wrong platform for an hour, because someone
 * edited .env and the server was still holding the old value, is a bad
 * afternoon. Re-reading a small file per call costs nothing next to an HTTP
 * round trip.
 */
async function readConfig() {
  const fromFile = await readDotEnv(process.cwd());
  const url = process.env.CAWDEV_URL ?? fromFile.values.CAWDEV_URL;
  const token = process.env.CAWDEV_TOKEN ?? fromFile.values.CAWDEV_TOKEN;
  const project = process.env.CAWDEV_PROJECT ?? fromFile.values.CAWDEV_PROJECT;

  return {
    url: (url ?? 'http://localhost:8091').replace(/\/+$/, ''),
    token,
    project,
    // Where each value came from. roadmap_where reports this, because "which
    // platform am I actually talking to" is the first question when a call goes
    // somewhere unexpected.
    from: {
      url: process.env.CAWDEV_URL ? 'environment' : fromFile.values.CAWDEV_URL ? fromFile.path : 'default',
      token: process.env.CAWDEV_TOKEN ? 'environment' : fromFile.values.CAWDEV_TOKEN ? fromFile.path : 'unset',
      project: process.env.CAWDEV_PROJECT
        ? 'environment'
        : fromFile.values.CAWDEV_PROJECT
          ? fromFile.path
          : 'unset',
    },
  };
}

async function readDotEnv(startDirectory) {
  let directory = resolve(startDirectory);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(directory, '.env');
    try {
      const text = await readFile(candidate, 'utf8');
      const values = {};
      for (const line of text.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
      return { values, path: candidate };
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return { values: {}, path: null };
}

// --- talking to cawdev ------------------------------------------------------

class CawdevError extends Error {}

async function api(config, path, { method = 'GET', body } = {}) {
  if (!config.token) {
    throw new CawdevError(
      'No CAWDEV_TOKEN. Mint one in the cawdev console under Agent tokens, then set it in ' +
        'the environment or a .env file beside this repository. Run roadmap_where to see ' +
        'where this server is looking.',
    );
  }

  let response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (failure) {
    throw new CawdevError(
      `Could not reach cawdev at ${config.url} (${failure.message}). ` +
        'Is it running? roadmap_where shows which URL this server is using and where it read it.',
    );
  }

  const text = await response.text();
  const parsed = text ? safeJson(text) : null;

  if (!response.ok) {
    // The API's own message explains the rule that was hit — a missing scope, a
    // status that needs a branch. Passing it through verbatim is the point of
    // this server being a translation.
    throw new CawdevError(parsed?.message ?? `${method} ${path} failed: HTTP ${response.status}`);
  }
  return parsed;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Which project a call is about.
 *
 * A token granted exactly one project needs no argument — that is the common
 * case and asking for it every time is noise. A multi-project token must say,
 * and being told *which* projects it can see is more useful than being told it
 * guessed wrong.
 */
async function resolveProject(config, requested) {
  const identity = await api(config, '/api/agent/whoami');
  const reachable = identity.projects.map((project) => project.slug);

  if (requested) {
    if (!reachable.includes(requested)) {
      throw new CawdevError(
        `This token cannot reach "${requested}". It can reach: ${
          reachable.length ? reachable.join(', ') : '(nothing — check its grants in the console)'
        }`,
      );
    }
    return requested;
  }

  if (config.project) {
    if (!reachable.includes(config.project)) {
      throw new CawdevError(
        `CAWDEV_PROJECT is "${config.project}" (from ${config.from.project}), but this token ` +
          `cannot reach it. It can reach: ${reachable.join(', ') || '(nothing)'}`,
      );
    }
    return config.project;
  }

  if (reachable.length === 1) {
    return reachable[0];
  }
  if (reachable.length === 0) {
    throw new CawdevError(
      'This token has no projects. Check its grants in the cawdev console under Agent tokens.',
    );
  }
  throw new CawdevError(
    `This token can reach several projects, so say which: ${reachable.join(', ')}. ` +
      'Pass `project`, or set CAWDEV_PROJECT.',
  );
}

// --- the tools --------------------------------------------------------------

const PROJECT_ARGUMENT = {
  project: {
    type: 'string',
    description:
      'Project slug. Optional when the token grants exactly one project, or CAWDEV_PROJECT is set.',
  },
};

const TOOLS = [
  {
    name: 'roadmap_where',
    description:
      'Which cawdev this is talking to, which token it is using, where each was read from, ' +
      'and who the platform says you are. Run this first when a call goes somewhere unexpected.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (config) => {
      const lines = [
        `platform: ${config.url}  (from ${config.from.url})`,
        `token:    ${config.token ? `${config.token.slice(0, 11)}…` : '(unset)'}  (from ${config.from.token})`,
        `project:  ${config.project ?? '(unset)'}  (from ${config.from.project})`,
        `cwd:      ${process.cwd()}`,
        '',
      ];
      try {
        const identity = await api(config, '/api/agent/whoami');
        lines.push(
          `you are:  ${identity.kind} "${identity.label}" owned by ${identity.ownerEmail}`,
          identity.tokenRevoked ? 'WARNING: this token is revoked.' : '',
          '',
          identity.projects.length ? 'reachable projects:' : 'reachable projects: (none)',
        );
        for (const project of identity.projects) {
          lines.push(
            `  ${project.slug}${project.archived ? ' (archived)' : ''} — ${project.name}` +
              `\n    scopes: ${project.scopes.join(', ') || '(none usable)'}` +
              `\n    owner's role there: ${project.ownerRole}`,
          );
        }
      } catch (failure) {
        lines.push(`the platform refused: ${failure.message}`);
      }
      return lines.filter((line) => line !== '').join('\n');
    },
  },

  {
    name: 'roadmap_statuses',
    description:
      'The six roadmap statuses, what each means, and what each one requires — CODING a branch, ' +
      'SHIPPED a version, DECLINED a reason. Read this rather than guessing.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (config) => {
      const statuses = await api(config, '/api/roadmap/statuses');
      return statuses
        .map(
          (status) =>
            `${status.display}${status.requires ? `  (requires a ${status.requires})` : ''}\n    ${status.meaning}`,
        )
        .join('\n');
    },
  },

  {
    name: 'roadmap_list',
    description:
      'A project\'s roadmap entries, optionally filtered by status. Use brief=true to survey ' +
      'without pulling every entry\'s body into context.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        status: {
          type: 'string',
          enum: ['CONSIDERING', 'PLANNED', 'IN_PROGRESS', 'CODING', 'SHIPPED', 'DECLINED'],
        },
        brief: { type: 'boolean', description: 'Omit bodies. Default true.' },
      },
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const brief = args.brief !== false;
      const query = new URLSearchParams();
      if (args.status) query.set('status', args.status);
      query.set('brief', String(brief));

      const entries = await api(config, `/api/projects/${slug}/roadmap?${query}`);
      if (!entries.length) {
        return `${slug} has no matching entries.`;
      }
      return entries.map((entry) => formatEntry(entry, { brief })).join('\n\n');
    },
  },

  {
    name: 'roadmap_get',
    description: 'One roadmap entry in full, including its body.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_ARGUMENT, number: { type: 'integer' } },
      required: ['number'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      return formatEntry(await api(config, `/api/projects/${slug}/roadmap/${args.number}`), {});
    },
  },

  {
    name: 'roadmap_create',
    description:
      'Create a roadmap entry. The platform allocates its permanent R-number. Defaults to ' +
      'PLANNED; a status that requires something must be given it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown.' },
        status: {
          type: 'string',
          enum: ['CONSIDERING', 'PLANNED', 'IN_PROGRESS', 'CODING', 'SHIPPED', 'DECLINED'],
        },
        branch: { type: 'string' },
        version: { type: 'string' },
        reason: { type: 'string' },
        section: { type: 'string', description: 'Which part of the roadmap, e.g. "Phase 2 — …".' },
        related: { type: 'array', items: { type: 'integer' } },
      },
      required: ['title'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/roadmap`, {
        method: 'POST',
        body: pick(args, ['title', 'body', 'status', 'branch', 'version', 'reason', 'section', 'related']),
      });
      return `Created R${entry.number} in ${slug}.\n\n${formatEntry(entry, {})}`;
    },
  },

  {
    name: 'roadmap_update',
    description:
      'Edit an entry\'s title, body, section or related ids. Use roadmap_set_status to move it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        number: { type: 'integer' },
        title: { type: 'string' },
        body: { type: 'string' },
        section: { type: 'string' },
        related: { type: 'array', items: { type: 'integer' } },
      },
      required: ['number'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/roadmap/${args.number}`, {
        method: 'PATCH',
        body: pick(args, ['title', 'body', 'section', 'related']),
      });
      return `Updated R${entry.number}.\n\n${formatEntry(entry, {})}`;
    },
  },

  {
    name: 'roadmap_set_status',
    description:
      'Move an entry to a status. Any status may move to any other — the rules are about what ' +
      'a status must carry, not a permitted path. CODING needs a branch, SHIPPED a version.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        number: { type: 'integer' },
        status: {
          type: 'string',
          enum: ['CONSIDERING', 'PLANNED', 'IN_PROGRESS', 'CODING', 'SHIPPED', 'DECLINED'],
        },
        branch: { type: 'string' },
        version: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['number', 'status'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/roadmap/${args.number}/status`, {
        method: 'POST',
        body: pick(args, ['status', 'branch', 'version', 'reason']),
      });
      return `R${entry.number} is now ${entry.statusDisplay}.\n\n${formatEntry(entry, {})}`;
    },
  },

  {
    name: 'roadmap_decline',
    description:
      'Decline an entry, with a reason. This is the only exit an entry has — there is no delete. ' +
      'The reason is the point: it stops the idea being proposed again.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_ARGUMENT, number: { type: 'integer' }, reason: { type: 'string' } },
      required: ['number', 'reason'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/roadmap/${args.number}/decline`, {
        method: 'POST',
        body: { reason: args.reason },
      });
      return `R${entry.number} declined.\n\n${formatEntry(entry, {})}`;
    },
  },

  {
    name: 'changelog_list',
    description: 'A project\'s changelog, grouped by release, newest first.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_ARGUMENT, version: { type: 'string', description: 'Only this release.' } },
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const query = args.version ? `?version=${encodeURIComponent(args.version)}` : '';
      const releases = await api(config, `/api/projects/${slug}/changelog${query}`);
      if (!releases.length) return `${slug} has no changelog entries.`;

      return releases
        .map((release) => {
          const head = `## ${release.version}${release.hasBreaking ? '  (contains breaking changes)' : ''}`;
          const lines = release.entries.map(
            (entry) =>
              `  [${entry.number}] ${entry.category}${entry.breaking ? ' BREAKING' : ''}: ${entry.text}`,
          );
          return [head, ...lines].join('\n');
        })
        .join('\n\n');
    },
  },

  {
    name: 'changelog_get',
    description: 'One changelog entry.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_ARGUMENT, number: { type: 'integer' } },
      required: ['number'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/changelog/${args.number}`);
      return formatChangelogEntry(entry);
    },
  },

  {
    name: 'changelog_add',
    description:
      'Add a changelog entry. With no version it goes to Unreleased. Set breaking when the ' +
      'reader must act — that is the field they scan for.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        category: { type: 'string', enum: ['ADDED', 'CHANGED', 'FIXED', 'REMOVED', 'SECURITY'] },
        text: { type: 'string', description: 'What changed.' },
        version: { type: 'string' },
        breaking: { type: 'boolean' },
      },
      required: ['category', 'text'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/changelog`, {
        method: 'POST',
        body: pick(args, ['category', 'text', 'version', 'breaking']),
      });
      return `Added changelog entry ${entry.number} to ${entry.version}.\n\n${formatChangelogEntry(entry)}`;
    },
  },

  {
    name: 'changelog_update',
    description:
      'Edit a changelog entry, including moving it to a release when the work ships. There is ' +
      'no delete — correct the text instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        number: { type: 'integer' },
        category: { type: 'string', enum: ['ADDED', 'CHANGED', 'FIXED', 'REMOVED', 'SECURITY'] },
        text: { type: 'string' },
        version: { type: 'string' },
        breaking: { type: 'boolean' },
      },
      required: ['number'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/changelog/${args.number}`, {
        method: 'PATCH',
        body: pick(args, ['category', 'text', 'version', 'breaking']),
      });
      return `Updated changelog entry ${entry.number}.\n\n${formatChangelogEntry(entry)}`;
    },
  },
];

// There is no roadmap_delete or changelog_delete, and there will not be. The
// API has no such endpoint either: DECLINED with a reason is the only exit.

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function formatEntry(entry, { brief }) {
  const lines = [`R${entry.number} — ${entry.title}`, `  status: ${entry.statusDisplay}`];
  if (entry.branch) lines.push(`  branch: ${entry.branch}`);
  if (entry.version) lines.push(`  version: ${entry.version}`);
  if (entry.declinedReason) lines.push(`  declined because: ${entry.declinedReason}`);
  if (entry.section) lines.push(`  section: ${entry.section}`);
  if (entry.related?.length) lines.push(`  related: ${entry.related.map((n) => `R${n}`).join(', ')}`);
  if (!brief && entry.body) lines.push('', entry.body);
  return lines.join('\n');
}

function formatChangelogEntry(entry) {
  return (
    `[${entry.number}] ${entry.version} — ${entry.category}` +
    `${entry.breaking ? ' (BREAKING)' : ''}\n  ${entry.text}`
  );
}

// --- JSON-RPC over stdio ----------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return reply(id, {
        // Echo the client's revision when it names one: an agreed-on version we
        // both understand beats insisting on ours.
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // Notifications carry no id and expect no reply.

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });

    case 'tools/call': {
      const tool = TOOLS.find((candidate) => candidate.name === params?.name);
      if (!tool) {
        return replyError(id, -32602, `No such tool: ${params?.name}`);
      }
      // Configuration is re-read here, per call, on purpose. See readConfig.
      const config = await readConfig();
      try {
        const text = await tool.handler(config, params.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (failure) {
        // A refusal is a *result*, not a transport error: the agent should read
        // it, understand which rule it hit, and try something else — not see
        // the tool call itself fail.
        return reply(id, {
          content: [{ type: 'text', text: failure.message }],
          isError: true,
        });
      }
    }

    default:
      if (id === undefined) return; // Unknown notification: ignore.
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

const input = createInterface({ input: process.stdin });

// In-flight calls, so closing stdin does not cut off a reply that is still
// being computed. A piped session — printf ... | node server.mjs — closes stdin
// the moment it has written, which is *before* any HTTP round trip has
// returned. Exiting on close loses those replies, and the transcript shows a
// request with no response.
let inFlight = 0;
let inputClosed = false;

function exitWhenDone() {
  if (inputClosed && inFlight === 0) {
    process.exit(0);
  }
}

input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return replyError(null, -32700, 'Parse error: each message must be one line of JSON.');
  }

  inFlight += 1;
  handle(message)
    .catch((failure) => replyError(message.id ?? null, -32603, failure.message))
    .finally(() => {
      inFlight -= 1;
      exitWhenDone();
    });
});

// stdin closing is how an MCP client says goodbye — once we have answered.
input.on('close', () => {
  inputClosed = true;
  exitWhenDone();
});
