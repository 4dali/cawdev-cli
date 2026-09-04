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
import {
  coveredBy,
  suggestionFor,
  summaryOf,
  withinCeiling,
} from '../lib/tool-rules.mjs';

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

/**
 * The run this token belongs to, for the orchestration tools.
 *
 * A plain `cawd_` token gets a refusal that says what it is missing rather than
 * a confusing 404: these tools only mean anything inside a run, and an agent
 * holding the wrong token should be told so plainly.
 */
async function requireRun(config) {
  const identity = await api(config, '/api/agent/whoami');
  if (!identity.runId) {
    throw new CawdevError(
      'This tool needs a run. The token in use is a plain cawd_ token, which can read and write ' +
        'the roadmap and changelog but is not attached to any run. A run token (cawdr_) is ' +
        'minted by the runner when a run starts and handed to the session it spawns.',
    );
  }
  const project = identity.projects[0]?.slug;
  if (!project) {
    throw new CawdevError('This run token has no project. Its run may have ended.');
  }
  return { runId: identity.runId, project };
}

/** How long ask_user waits before handing back a pending question. */
function askTimeoutSeconds() {
  // Overridable so a test does not have to wait ten minutes to exercise the
  // pending path.
  const configured = Number(process.env.CAWDEV_ASK_TIMEOUT_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : 600;
}

/**
 * Waits for an answer, re-polling quietly.
 *
 * The platform's long poll returns after at most 25 seconds, so a genuine wait
 * is many polls. Doing that here rather than in the agent means the agent
 * experiences one natural blocking ask, while the person experiences an inbox
 * item — which is the whole shape R10 is after.
 */
async function pollForAnswer(config, project, runId, questionId, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const response = await fetch(
      `${config.url}/api/projects/${project}/runs/${runId}/questions/${questionId}/answer` +
        `?wait=${Math.min(25, Math.max(1, remaining))}`,
      { headers: { authorization: `Bearer ${config.token}` } },
    );
    if (response.status === 200) {
      return await response.json();
    }
    if (response.status !== 204) {
      const text = await response.text();
      throw new CawdevError(safeJson(text)?.message ?? `waiting failed: HTTP ${response.status}`);
    }
    // 204 means "not yet" — ask again.
  }
  return null;
}

/**
 * The answer, with the argument that produced it.
 *
 * A question can be passed round before somebody answers it (R36), and the
 * opinions collected on the way are on the question. Showing them matters: the
 * answer is often "do the second one", and the reasoning that settled it lives
 * in the thread rather than in the sentence you were handed.
 */
function renderAnswer(answered) {
  const said = (answered.opinions ?? [])
    .map((opinion) => `  ${opinion.authorEmail}: ${opinion.body}`)
    .join('\n');

  const answer = `${answered.answeredByEmail} answered:\n\n${answered.answer}`;
  return said ? `${answer}\n\nWhat people said before deciding:\n${said}` : answer;
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
      'The eight roadmap statuses, what each means, and what each one requires — CODING a ' +
      'branch, MERGED the merge, SHIPPED a version, DECLINED a reason. REVIEW, between CODING ' +
      'and MERGED, requires nothing. Read this rather than guessing.',
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
          enum: [
            'CONSIDERING',
            'PLANNED',
            'IN_PROGRESS',
            'CODING',
            'REVIEW',
            'DONE',
            'MERGED',
            'SHIPPED',
            'DECLINED',
          ],
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
    description:
      'One roadmap entry in full, including its body and the discussion on it. Read the ' +
      'comments before proposing anything about this entry: they are where an objection was ' +
      'answered, and re-proposing what was talked out three months ago is the thing they exist ' +
      'to stop.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_ARGUMENT, number: { type: 'integer' } },
      required: ['number'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/roadmap/${args.number}`);
      const comments = await api(
        config,
        `/api/projects/${slug}/roadmap/${args.number}/comments`,
      );
      return formatEntry(entry, { comments });
    },
  },

  {
    name: 'code_map',
    description:
      "The shape of this project's code: every directory, how many files it holds, and which " +
      'directories depend on which. READ THIS BEFORE GREPPING AROUND A REPOSITORY YOU DO NOT ' +
      'KNOW. It is one call, it is already computed, and it answers "where does this live" and ' +
      '"what would I break" without opening a single file — the same questions a dozen searches ' +
      'answer more slowly and less completely.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        under: {
          type: 'string',
          description:
            'Only this directory and below, e.g. "backend/src/main/java". Omit for the whole ' +
            'project, which is the right first call.',
        },
      },
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const map = await codeMapOrNothing(config, slug);
      if (!map) {
        return `No machine has mapped ${slug} yet, so there is nothing to read here. ` +
          'Work as you would have anyway.';
      }
      return formatCodeMap(map, args.under);
    },
  },

  {
    name: 'file_deps',
    description:
      'What one file imports, and what imports it. Use it before changing a file: the second ' +
      'half is the blast radius, and it is the half that grepping for a filename does not give ' +
      'you reliably.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        path: {
          type: 'string',
          description: 'Repository-relative, e.g. "tools/runner/runner.mjs".',
        },
      },
      required: ['path'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const map = await codeMapOrNothing(config, slug);
      if (!map) {
        return `No machine has mapped ${slug} yet, so there is nothing to read here.`;
      }
      return formatFileDeps(map, args.path);
    },
  },

  {
    name: 'roadmap_comment',
    description:
      'Say something about an entry, beside the entry rather than inside it. Use it for the ' +
      'argument: an objection, a measurement, why an obvious approach was not taken. The body ' +
      'is where a settled conclusion is written down — edit that when the discussion reaches ' +
      'one. Comments cannot be deleted, by you or by anyone.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        number: { type: 'integer' },
        body: { type: 'string', description: 'Markdown.' },
      },
      required: ['number', 'body'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      await api(config, `/api/projects/${slug}/roadmap/${args.number}/comments`, {
        method: 'POST',
        body: { body: args.body },
      });
      return `Commented on R${args.number} in ${slug}. It cannot be deleted — that is the point.`;
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
          enum: [
            'CONSIDERING',
            'PLANNED',
            'IN_PROGRESS',
            'CODING',
            'REVIEW',
            'DONE',
            'MERGED',
            'SHIPPED',
            'DECLINED',
          ],
        },
        branch: { type: 'string' },
        merge: { type: 'string', description: 'What MERGED needs: the PR, the merge commit, or the sha.' },
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
        body: pick(args, ['title', 'body', 'status', 'branch', 'merge', 'version', 'reason', 'section', 'related']),
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
      'a status must carry, not a permitted path. CODING needs a branch, MERGED the merge — the ' +
      'PR, the merge commit or the sha — and SHIPPED a version. REVIEW, between the two, needs ' +
      'nothing: it is work that is written and waiting to be read, and a session that has ' +
      'opened a pull request and finished belongs there rather than in CODING. Move a card to ' +
      'MERGED when its pull request lands; the branch may then be deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGUMENT,
        number: { type: 'integer' },
        status: {
          type: 'string',
          enum: [
            'CONSIDERING',
            'PLANNED',
            'IN_PROGRESS',
            'CODING',
            'REVIEW',
            'DONE',
            'MERGED',
            'SHIPPED',
            'DECLINED',
          ],
        },
        branch: { type: 'string' },
        merge: { type: 'string', description: 'What MERGED needs: the PR, the merge commit, or the sha.' },
        version: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['number', 'status'],
    },
    handler: async (config, args) => {
      const slug = await resolveProject(config, args.project);
      const entry = await api(config, `/api/projects/${slug}/roadmap/${args.number}/status`, {
        method: 'POST',
        body: pick(args, ['status', 'branch', 'merge', 'version', 'reason']),
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

  // --- orchestration: only meaningful inside a run -------------------------

  {
    name: 'task_current',
    description:
      'What you are working on: the roadmap entry, its branch, and everything already said and ' +
      'asked on this run. Call it first, and again whenever you are unsure where you are — a ' +
      'resumed or confused session re-orients from this alone.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (config) => {
      const { runId, project } = await requireRun(config);
      const run = await api(config, `/api/projects/${project}/runs/${runId}`);
      const entry = await api(config, `/api/projects/${project}/roadmap/${run.entryNumber}`);
      const messages = await api(config, `/api/projects/${project}/runs/${runId}/messages`);
      const questions = await api(config, `/api/projects/${project}/runs/${runId}/questions`);
      // The discussion comes with the card, not only from roadmap_get. This is
      // where a session reads what it is building, and an argument nobody sees
      // at the start is an argument that gets had again.
      const comments = await api(
        config,
        `/api/projects/${project}/roadmap/${run.entryNumber}/comments`,
      );
      // Every session this card has already had — R38. Its own try, because a
      // history that cannot be read is not a reason to fail the one call a
      // resumed session re-orients from: the entry and the branch matter more,
      // and the honest consequence of not knowing is to say nothing about it.
      const history = await api(
        config,
        `/api/projects/${project}/roadmap/${run.entryNumber}/runs`,
      ).catch(() => []);

      const lines = [];

      // R74. A card that was sent back leads with WHY, before the card's own
      // text — because the card's text is the original specification, and the
      // only honest reading of it alone is "build this". The instruction is:
      // fix what is listed; the branch already holds the work.
      if (entry.rejection) {
        lines.push(
          '=== THIS CARD WAS REVIEWED AND SENT BACK. FIX WHAT IS LISTED — DO NOT REBUILD IT ===',
          `The work is already on branch ${run.branch}. A previous session finished on it, ` +
            `and ${entry.rejection.decidedByEmail ?? 'the reviewer'} read it and said:`,
          '',
          entry.rejection.note,
          '',
          'Address that. The card below is the original task, for context only.',
          '',
        );
      }

      lines.push(
        `project: ${project}`,
        `branch:  ${run.branch}`,
        `run:     ${run.state}${run.runnerName ? ` on ${run.runnerName}` : ''}`,
        `started by ${run.startedByEmail}`,
        '',
        formatEntry(entry, { comments }),
      );

      // What happened the other times. A session is told the entry and the
      // branch but not that two previous runs on this card failed, which is
      // exactly what a session about to repeat them needs. This run is left
      // out: everything about it is already above and below.
      const before = history.filter((item) => item.run.id !== runId);
      if (before.length) {
        lines.push('', `--- this card has been worked on before (${before.length}) ---`);
        for (const { run: past, commits } of before) {
          lines.push(formatPastRun(past, commits));
        }
      }

      if (messages.length) {
        lines.push('', '--- what you have reported so far ---');
        for (const message of messages) {
          lines.push(`[${message.kind}] ${message.body}`);
        }
      }
      if (questions.length) {
        lines.push('', '--- what you have asked ---');
        for (const question of questions) {
          lines.push(
            `Q: ${question.question}`,
            question.answered
              ? `A: ${question.answer}  (${question.answeredByEmail})`
              : `A: still waiting  (question_id ${question.id})`,
          );
          // Who it went to, and what they said. A resumed session that cannot
          // see this reads "still waiting" and concludes it has been ignored,
          // when in fact somebody passed it to a colleague an hour ago.
          for (const share of question.shares ?? []) {
            if (share.open) {
              lines.push(
                share.kind === 'DECIDE'
                  ? `   handed to ${share.sharedWithEmail} to decide, by ${share.sharedByEmail}`
                  : `   ${share.sharedByEmail} asked ${share.sharedWithEmail} what they think`,
              );
            }
          }
          for (const opinion of question.opinions ?? []) {
            lines.push(`   ${opinion.authorEmail} thinks: ${opinion.body}`);
          }
        }
      }
      return lines.join('\n');
    },
  },

  {
    name: 'report',
    description:
      'Say what is happening. `progress` as often as useful; `done` when the work is finished, ' +
      'naming the branch and any PR; `blocked` when something stops you that a person must ' +
      'resolve. done and blocked also end the run — you do not need a separate step.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['progress', 'done', 'blocked'] },
        body: { type: 'string', description: 'Markdown. Say what actually happened.' },
      },
      required: ['kind', 'body'],
    },
    handler: async (config, args) => {
      const { runId, project } = await requireRun(config);
      const message = await api(config, `/api/projects/${project}/runs/${runId}/messages`, {
        method: 'POST',
        body: { kind: args.kind.toUpperCase(), body: args.body },
      });

      // done and blocked END the run, and a run's token expires with it — so
      // there is no reading the run back afterwards. Say what happened from
      // what we know, and tell the agent its token is now spent, which is the
      // thing it most needs to hear.
      const ended = { DONE: 'FINISHED', BLOCKED: 'FAILED' }[message.kind];
      if (ended) {
        return (
          `Reported ${message.kind}. The run is ${ended} and this token has expired with it — ` +
          `there is nothing further to do here.`
        );
      }

      const run = await api(config, `/api/projects/${project}/runs/${runId}`);
      return `Reported ${message.kind}. The run is ${run.state}.`;
    },
  },

  {
    name: 'propose_entry',
    description:
      'Record something an audit found, as a proposed roadmap entry. A PERSON decides which ' +
      'proposals become entries — you are not creating one, you are suggesting it. Severity is ' +
      '"critical" (broken, unsafe, or loses data), "medium" (it will hurt, but not today) or ' +
      '"minor" (worth doing, nobody is bleeding). Write each one as an entry would be written, ' +
      'and say where in the code you saw it. Only an audit session may use this.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['critical', 'medium', 'minor'] },
        title: { type: 'string', description: 'Short enough to scan in a list.' },
        body: {
          type: 'string',
          description:
            'Markdown: what and why, a **Build:** list, and a **Done when:** condition.',
        },
      },
      required: ['severity', 'title', 'body'],
    },
    handler: async (config, args) => {
      const { runId, project } = await requireRun(config);
      const proposal = await api(config, `/api/projects/${project}/runs/${runId}/proposals`, {
        method: 'POST',
        body: {
          severity: args.severity.toUpperCase(),
          title: args.title,
          body: args.body,
        },
      });
      return (
        `Proposed #${proposal.seq}: ${proposal.severity} — ${proposal.title}. ` +
        `It is not on the roadmap: somebody will decide.`
      );
    },
  },

  {
    name: 'ask_user',
    description:
      'Ask the person who started this run, and wait for their answer. Use it when a decision is ' +
      'genuinely theirs — not to check work you can check yourself. Blocks for up to ten ' +
      'minutes; if nobody has answered by then it returns a question_id for await_answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional one-click choices. They can still answer in free text.',
        },
      },
      required: ['question'],
    },
    handler: async (config, args) => {
      const { runId, project } = await requireRun(config);
      const asked = await api(config, `/api/projects/${project}/runs/${runId}/questions`, {
        method: 'POST',
        body: { question: args.question, options: args.options },
      });

      const answered = await pollForAnswer(config, project, runId, asked.id, askTimeoutSeconds());
      if (answered) {
        return renderAnswer(answered);
      }
      return (
        `Nobody has answered yet. The run is WAITING_ON_USER and the question is in their ` +
        `inbox.\n\nCall await_answer with question_id ${asked.id} to keep waiting. Do not ` +
        `guess an answer and carry on — you asked because the decision was theirs.`
      );
    },
  },

  {
    name: 'await_answer',
    description:
      'Resume waiting for a question ask_user handed back. Between the two you experience one ' +
      'natural blocking ask; the person experiences an inbox item.',
    inputSchema: {
      type: 'object',
      properties: { question_id: { type: 'string' } },
      required: ['question_id'],
    },
    handler: async (config, args) => {
      const { runId, project } = await requireRun(config);
      const answered = await pollForAnswer(
        config,
        project,
        runId,
        args.question_id,
        askTimeoutSeconds(),
      );
      if (answered) {
        return renderAnswer(answered);
      }
      return `Still nothing. Call await_answer again with question_id ${args.question_id}.`;
    },
  },

  {
    name: 'approve',
    description:
      'INTERNAL — Claude Code calls this itself as --permission-prompt-tool when no rule covers ' +
      'a tool call. Do not call it yourself: it decides whether YOUR next call is allowed, and ' +
      'calling it directly asks a person a question about nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
    },
    handler: async (config, args) => decide(config, args),
  },
];

/**
 * The permission decision, as Claude Code reads it — R51.
 *
 * <p>Returned as JSON text, which is the wire format the CLI expects from a
 * permission-prompt tool: `{behavior: "allow", updatedInput}` or
 * `{behavior: "deny", message}`.
 *
 * THIS FUNCTION NEVER THROWS. Every other tool here turns a failure into an
 * error result the agent reads and works around; this one cannot. A malformed
 * answer to a permission question is not a refusal — it is a session that
 * stops without saying why, which is the failure R51 exists to end. So an
 * unreachable platform, a bad response, anything at all, comes back as a deny
 * carrying the reason.
 */
async function decide(config, args) {
  const toolName = String(args.tool_name ?? '');
  const input = args.input && typeof args.input === 'object' ? args.input : {};

  try {
    const { runId, project } = await requireRun(config);

    // What this project has already decided, filtered by what THIS MACHINE is
    // willing to have applied with nobody watching. The ceiling is enforced
    // here as well as at spawn because a rule added while the session was
    // running has never been through the runner at all.
    //
    // ITS OWN TRY, and this is the whole point of it: reading the rules is an
    // optimisation — "has somebody already said yes to this" — and a failure to
    // read them is a fact about the platform, not about this call. Sharing the
    // catch below made an unreachable rules endpoint deny every single call
    // without ever asking anybody, because the POST that raises the question
    // sits after this line. A run against an API too old to have the endpoint
    // reported itself blocked on npm, ng and most of Bash for a whole session,
    // and nothing appeared in anyone's inbox. Unreadable rules means no rule
    // applies, which means ask — the direction everything here fails in.
    const live = (await liveRules(config, project))
      .filter((pattern) => withinCeiling(grantable(), pattern));

    const covered = coveredBy(live, toolName, input);
    if (covered) {
      return allow(input, `covered by this project's rule ${covered}`);
    }

    // What somebody already allowed for the rest of THIS run — R60.
    //
    // Deliberately NOT filtered by the ceiling, and it is the one place in this
    // file where that is true. R51's ceiling is about rules that apply when
    // nobody is watching: a project rule reaches sessions that have not started
    // yet, so the machine's owner has the last word on it. A session grant
    // reaches no session but this one, was made by a person looking at this
    // command, and dies when the run does. Filtering it would leave the console
    // offering a button that does nothing on every machine with a narrow
    // grantable — which is the default, and the reason this session stopped.
    //
    // Its own try, like liveRules and for the same reason: not knowing what was
    // granted is a fact about the platform, not about this call, and the honest
    // consequence is to ask again rather than to deny.
    const granted = coveredBy(await sessionRules(config, project, runId), toolName, input);
    if (granted) {
      return allow(input, `allowed for this session by ${granted}`);
    }

    const asked = await api(config, `/api/projects/${project}/runs/${runId}/approvals`, {
      method: 'POST',
      body: {
        toolName,
        toolInput: JSON.stringify(input),
        summary: summaryOf(toolName, input),
        suggestion: suggestionFor(toolName, input, { skillServers: skillServers() }),
        toolUseId: args.tool_use_id,
      },
    });

    const decided = await pollForDecision(config, project, runId, asked.id);
    if (decided?.state === 'ALLOWED') {
      return allow(input, decided.reason ?? 'allowed by a person');
    }
    if (decided?.state === 'DENIED') {
      return deny(
        `${decided.reason ?? 'A person refused this.'} Do not try to work around it — report ` +
          `blocked and say what you needed, or ask for a different approach.`,
      );
    }
    // EXPIRED, or the poll gave up before the platform expired it. Same answer
    // either way, and the difference is on the run for whoever reads it later.
    return deny(
      `Nobody answered this permission request in time. Do not retry it in a loop: report ` +
        `blocked, say exactly what you needed to run and why, and let a person allow it.`,
    );
  } catch (failure) {
    return deny(
      `cawdev could not be asked whether this is allowed (${failure.message}). Treating that as ` +
        `no. If this persists, report blocked rather than retrying.`,
    );
  }
}

function allow(updatedInput, reason) {
  // `updatedInput` echoed back unchanged. The hook exists to say yes or no,
  // not to rewrite what the agent was about to do behind its back.
  return JSON.stringify({ behavior: 'allow', updatedInput, reason });
}

function deny(message) {
  return JSON.stringify({ behavior: 'deny', message });
}

/**
 * The project's stored rules, or none when they cannot be read.
 *
 * Never throws. The caller is deciding a permission and must reach the point
 * where it asks a person; an endpoint that 404s, times out or answers with
 * nonsense is not an answer about this call, so it counts as "no rule covers
 * it". The session then asks, which is what it would have done anyway had the
 * project stored nothing.
 */
async function liveRules(config, project) {
  try {
    const rules = await api(config, `/api/projects/${project}/tool-rules`);
    return (rules ?? []).map((rule) => rule?.pattern).filter((pattern) => typeof pattern === 'string');
  } catch {
    return [];
  }
}

/**
 * What has already been allowed for the rest of this run, or none — R60.
 *
 * Never throws, for the reason `liveRules` does not: the caller is deciding a
 * permission and must reach the point where it asks a person. An endpoint that
 * 404s — an older API, which is the normal case during an upgrade — is not an
 * answer about this call, so it counts as "nothing has been granted" and the
 * session asks. That is what it would have done anyway before R60 existed.
 */
async function sessionRules(config, project, runId) {
  try {
    const rules = await api(config, `/api/projects/${project}/runs/${runId}/tool-rules`);
    return (rules ?? []).map((rule) => rule?.pattern).filter((p) => typeof p === 'string');
  } catch {
    return [];
  }
}

/**
 * What this machine is willing to have applied unattended.
 *
 * Put in the environment by the runner when it spawns the session. Absent
 * means an empty ceiling, which is the safe reading: no stored rule applies on
 * its own and every call is asked about. A machine that wants otherwise says
 * so in its own config file, on the machine, by its owner.
 */
function grantable() {
  try {
    const parsed = JSON.parse(process.env.CAWDEV_GRANTABLE ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Which of this session's MCP servers are skills — R76.
 *
 * Put in the environment by the runner, which is the only thing that knows: it
 * composed the config. Absent means none, which is the safe reading — every
 * suggestion is then the single tool, which is narrower than a server.
 *
 * It changes ONE thing: the pattern offered to the person a stopped session is
 * waiting on. A project turned CodeGraph on as one capability, so the offer is
 * `mcp__codegraph` rather than the tool that happened to be called first. It
 * grants nothing by itself — a person still says yes, and R60's session rule is
 * what carries it.
 */
function skillServers() {
  try {
    const parsed = JSON.parse(process.env.CAWDEV_SKILL_SERVERS ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((each) => typeof each === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Waits for somebody to decide, for as long as the platform will hold it open.
 *
 * Bounded a little beyond the platform's own expiry so the two cannot both be
 * waiting on each other: if the sweep is late, this gives up and denies, which
 * is the same answer the sweep would have produced.
 */
async function pollForDecision(config, project, runId, approvalId) {
  const deadline = Date.now() + approvalTimeoutSeconds() * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const response = await fetch(
      `${config.url}/api/projects/${project}/runs/${runId}/approvals/${approvalId}/decision` +
        `?wait=${Math.min(25, Math.max(1, remaining))}`,
      { headers: { authorization: `Bearer ${config.token}` } },
    );
    if (response.status === 200) {
      return await response.json();
    }
    if (response.status !== 204) {
      const text = await response.text();
      throw new CawdevError(safeJson(text)?.message ?? `waiting failed: HTTP ${response.status}`);
    }
    // 204 means "still pending" — ask again.
  }
  return null;
}

/** A little past the platform's own fifteen-minute expiry. Overridable for tests. */
function approvalTimeoutSeconds() {
  const configured = Number(process.env.CAWDEV_APPROVAL_TIMEOUT_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : 960;
}

// There is no roadmap_delete or changelog_delete, and there will not be. The
// API has no such endpoint either: DECLINED with a reason is the only exit.
// The same goes for comments — nothing here removes one, and nothing there
// does either.

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * The project's code map, or null if nobody has taken one — R77.
 *
 * <p>Null rather than a throw: a project nobody has mapped is the ordinary
 * case, not an error, and a tool that fails there teaches the session to stop
 * calling it.
 */
async function codeMapOrNothing(config, slug) {
  try {
    const stored = await api(config, `/api/projects/${slug}/code-map`);
    const graph = JSON.parse(stored.graph);
    return {
      ...stored,
      files: Array.isArray(graph.files) ? graph.files : [],
      edges: Array.isArray(graph.edges) ? graph.edges : [],
    };
  } catch {
    return null;
  }
}

/** Everything at or under a directory. */
function under(path, directory) {
  return !directory || path === directory || path.startsWith(`${directory}/`);
}

/**
 * The map as a session should read it: directories, sizes, and what they lean on.
 *
 * <p>Directories rather than files, because four hundred filenames is the thing
 * the session was going to produce for itself and the reason this tool exists.
 * A directory with what it depends on is orientation; a file list is a `find`.
 */
function formatCodeMap(map, directory) {
  const dirs = new Map();
  for (const file of map.files) {
    if (!under(file.path, directory)) continue;
    dirs.set(file.dir, (dirs.get(file.dir) ?? 0) + 1);
  }
  if (!dirs.size) {
    return directory
      ? `Nothing under ${directory}. Check the path — this map has ${map.files.length} files.`
      : 'This project has no source files on the map.';
  }

  // Folded to directories, so "frontend leans on core" is one line rather than
  // forty. The count is what makes it worth reading: a dependency used once and
  // one used ninety times are different facts about a design.
  const between = new Map();
  for (const edge of map.edges) {
    if (!under(edge.from, directory) || !under(edge.to, directory)) continue;
    const from = edge.from.split('/').slice(0, -1).join('/');
    const to = edge.to.split('/').slice(0, -1).join('/');
    if (from === to) continue;
    const key = `${from} -> ${to}`;
    between.set(key, (between.get(key) ?? 0) + edge.weight);
  }

  const lines = [
    `${map.files.length} files in ${dirs.size} directories`
      + (directory ? ` under ${directory}` : '')
      + (map.headSha ? `, mapped at ${map.headSha.slice(0, 7)}` : '')
      + (map.stale ? ' (the branch has moved since)' : ''),
    '',
    'DIRECTORIES, largest first:',
  ];
  for (const [dir, count] of [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) {
    lines.push(`  ${String(count).padStart(4)}  ${dir || '(root)'}`);
  }

  const heavy = [...between.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  if (heavy.length) {
    lines.push('', 'WHAT LEANS ON WHAT, heaviest first:');
    for (const [pair, weight] of heavy) {
      lines.push(`  ${String(weight).padStart(4)}  ${pair}`);
    }
  }
  return lines.join('\n');
}

/**
 * One file's dependencies, both ways.
 *
 * <p>The second list is the one worth having: what would break. Searching for a
 * filename finds the string, misses re-exports and relative paths written from
 * a different directory, and cannot tell an import from a mention in a comment.
 */
function formatFileDeps(map, path) {
  const known = map.files.some((file) => file.path === path);
  if (!known) {
    const near = map.files
      .filter((file) => file.path.endsWith(`/${path.split('/').pop()}`))
      .slice(0, 8)
      .map((file) => `  ${file.path}`);
    return `${path} is not on this map.`
      + (near.length ? `\n\nDid you mean:\n${near.join('\n')}` : '');
  }

  const imports = map.edges.filter((edge) => edge.from === path);
  const importers = map.edges.filter((edge) => edge.to === path);
  const lines = [path, ''];

  lines.push(imports.length ? 'IT IMPORTS:' : 'It imports nothing inside this repository.');
  for (const edge of imports.sort((a, b) => b.weight - a.weight)) {
    lines.push(`  ${edge.to}${edge.weight > 1 ? ` (${edge.weight}x)` : ''}`);
  }

  lines.push('');
  lines.push(importers.length
    ? `IMPORTED BY ${importers.length} — this is what changing it reaches:`
    : 'Nothing in this repository imports it.');
  for (const edge of importers.sort((a, b) => b.weight - a.weight)) {
    lines.push(`  ${edge.from}${edge.weight > 1 ? ` (${edge.weight}x)` : ''}`);
  }
  return lines.join('\n');
}

function formatEntry(entry, { brief, comments }) {
  const lines = [`R${entry.number} — ${entry.title}`, `  status: ${entry.statusDisplay}`];
  if (entry.branch) lines.push(`  branch: ${entry.branch}`);
  if (entry.merge) lines.push(`  merged: ${entry.merge}`);
  if (entry.version) lines.push(`  version: ${entry.version}`);
  if (entry.declinedReason) lines.push(`  declined because: ${entry.declinedReason}`);
  if (entry.section) lines.push(`  section: ${entry.section}`);
  if (entry.related?.length) lines.push(`  related: ${entry.related.map((n) => `R${n}`).join(', ')}`);
  // Said in a survey, where the comments themselves are not fetched: an entry
  // with an argument attached should be visibly different from one without,
  // even in a list. Omitted at zero rather than written as "comments: 0".
  if (brief && entry.commentCount) lines.push(`  comments: ${entry.commentCount}`);
  // R38. Both omitted at zero and at null: a card nobody has run anything on,
  // written by a person, is the ordinary case and says nothing about itself.
  if (entry.runCount) lines.push(`  runs so far: ${entry.runCount}`);
  if (entry.createdBy) {
    lines.push(`  written by: a ${entry.createdBy.profile} session, `
      + `under ${entry.createdBy.startedByEmail}`);
  }
  if (!brief && entry.body) lines.push('', entry.body);
  if (comments?.length) lines.push('', formatComments(comments));
  return lines.join('\n');
}

/**
 * One earlier attempt at this card — R38.
 *
 * How it ended first, because that is the whole reason to read it: a card that
 * failed twice on the same branch is telling you something the status does not.
 * The commits are named rather than counted — a resumed session wants to know
 * whether the work it is about to do is already sitting on that branch.
 *
 * Deliberately no transcript. It is minutes of reading, it is on the run's own
 * page, and putting nine of them here would fill the context of the session
 * this is supposed to orient.
 */
function formatPastRun(past, commits = []) {
  const took = past.startedAt && past.finishedAt
    ? `, ${Math.round((Date.parse(past.finishedAt) - Date.parse(past.startedAt)) / 60000)}m`
    : '';
  const lines = [
    `[${past.state}${took}] ${past.createdAt ?? ''} on ${past.branch ?? '(no branch)'}`
      + ` — ${past.model ?? 'the runner default'}, started by ${past.startedByEmail}`,
  ];
  if (past.exitSummary) lines.push(`  ended: ${past.exitSummary}`);
  // Whether it left the machine at all: commits that were never pushed are not
  // on the branch a later session checks out.
  if (past.prUrl) lines.push(`  pull request: ${past.prUrl}`);
  else if (past.pushState) lines.push(`  push: ${past.pushState}`);
  for (const commit of commits) {
    lines.push(`  ${commit.sha.slice(0, 8)} ${commit.subject}`);
  }
  if (!commits.length) lines.push('  committed nothing');
  return lines.join('\n');
}

/**
 * The discussion, oldest first.
 *
 * A run's comment is attributed to the run — "a session" — because that is who
 * said it; the account it went out under is named too, since a reader deciding
 * how much weight to give an argument wants both.
 */
function formatComments(comments) {
  const lines = [`--- the discussion (${comments.length}) ---`];
  for (const comment of comments) {
    const who = comment.authorRunId
      ? `a session, under ${comment.authorEmail}`
      : comment.authorEmail;
    lines.push(
      `[${comment.createdAt}] ${who}${comment.editedAt ? ' (edited)' : ''}`,
      comment.body,
      '',
    );
  }
  return lines.join('\n').trimEnd();
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
