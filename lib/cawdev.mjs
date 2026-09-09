// A tiny cawdev API client. Plain Node, zero dependencies — see CLAUDE.md:
// a zero-dep file is one anyone can read before running it against their
// repositories, and every tool here is meant to be read.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Reads CAWDEV_URL / CAWDEV_TOKEN / CAWDEV_PROJECT from the environment, or
 * from a .env beside the repository root.
 *
 * Read on every call rather than cached at import: editing .env should not
 * need a restart. (R8's MCP server keeps the same rule — dycrypt learned it
 * the hard way, and losing it is how an agent ends up writing to the wrong
 * platform for an hour.)
 */
export async function readConfig(startDirectory = process.cwd()) {
  const fromEnv = {
    url: process.env.CAWDEV_URL,
    token: process.env.CAWDEV_TOKEN,
    project: process.env.CAWDEV_PROJECT,
  };

  const fromFile = await readDotEnv(startDirectory);
  const config = {
    url: (fromEnv.url ?? fromFile.CAWDEV_URL ?? 'http://localhost:4200').replace(/\/+$/, ''),
    token: fromEnv.token ?? fromFile.CAWDEV_TOKEN,
    project: fromEnv.project ?? fromFile.CAWDEV_PROJECT,
    // Where each value came from, so a surprising result can be traced.
    source: {
      url: fromEnv.url ? 'environment' : fromFile.CAWDEV_URL ? '.env' : 'default',
      token: fromEnv.token ? 'environment' : fromFile.CAWDEV_TOKEN ? '.env' : 'unset',
      project: fromEnv.project ? 'environment' : fromFile.CAWDEV_PROJECT ? '.env' : 'unset',
    },
  };
  return config;
}

async function readDotEnv(startDirectory) {
  let directory = resolve(startDirectory);
  for (let depth = 0; depth < 5; depth++) {
    try {
      const text = await readFile(join(directory, '.env'), 'utf8');
      const values = {};
      for (const line of text.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
      return values;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return {};
}

/** Throws with the API's own message, which is the one that explains the rule. */
export async function call(config, path, { method = 'GET', body } = {}) {
  if (!config.token) {
    throw new Error(
      'No CAWDEV_TOKEN. Mint one in the console under Agent tokens, then put it in ' +
        'the environment or a .env file.',
    );
  }

  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const parsed = text ? safeJson(text) : null;

  if (!response.ok) {
    const detail = parsed?.message ?? text ?? `HTTP ${response.status}`;
    throw new Error(`${method} ${path} -> ${response.status}: ${detail}`);
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

/** Resolves the project slug, preferring an explicit argument. */
export function resolveProject(config, explicit) {
  const slug = explicit ?? config.project;
  if (!slug) {
    throw new Error(
      'No project. Pass one as an argument, or set CAWDEV_PROJECT in the environment or .env.',
    );
  }
  return slug;
}
