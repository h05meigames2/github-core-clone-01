// mcp.ts — Model Context Protocol endpoint: the modern 2026-07-28 discovery
// handshake (server/discover) plus the legacy initialize handshake, tools/list
// and tools/call over plain JSON. Tools act on the same store as REST and
// GraphQL, so ids and objects agree across surfaces.

import { jsonResp, type ReqCtx, type Resp } from './http.ts';
import { VIEWER_LOGIN, type Label, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Look up an argument under any of its accepted names. */
function arg(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, names: string[]): string {
  const value = arg(args, names);
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, names: string[]): number | undefined {
  const value = arg(args, names);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

/** Split owner/repo from the arguments, honoring full_name and the viewer fallback. */
function resolveRepo(store: Store, args: Record<string, unknown>): { repo: Repo; owner: string; name: string } | null {
  let owner = stringArg(args, ['owner', 'owner_login', 'login']);
  let name = stringArg(args, ['repo', 'repository', 'repo_name']);
  const fullName = stringArg(args, ['full_name']);
  if (fullName !== '' && fullName.includes('/')) {
    const [fullOwner, ...rest] = fullName.split('/');
    if (owner === '') owner = fullOwner ?? '';
    if (name === '') name = rest.join('/');
  }
  if (name === '') name = stringArg(args, ['name']);
  if (owner === '') owner = VIEWER_LOGIN;
  if (name === '') return null;
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  return { repo, owner, name };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, rawArgs: unknown): { result?: Record<string, unknown>; errorCode?: number; errorMessage?: string } {
  const args = (rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { errorCode: -32601, errorMessage: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required ?? []) {
    const value = arg(args, [required]);
    if (value === undefined || value === null || value === '') {
      return { errorCode: -32602, errorMessage: `Missing required argument: ${required}` };
    }
  }

  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, ['name']);
      if (store.getRepo(VIEWER_LOGIN, repoName)) return { result: toolError(`Repository ${repoName} already exists`) };
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        description: stringArg(args, ['description']),
        private: arg(args, ['private']) === true,
      });
      return {
        result: toolResult({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner },
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
          html_url: `https://github.com/${repo.owner}/${repo.name}`,
          created_at: repo.createdAt,
        }),
      };
    }
    case 'get_repo': {
      const found = resolveRepo(store, args);
      if (!found) return { result: toolError('Repository not found') };
      const { repo } = found;
      return {
        result: toolResult({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner },
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
          html_url: `https://github.com/${repo.owner}/${repo.name}`,
          created_at: repo.createdAt,
        }),
      };
    }
    case 'create_issue': {
      const found = resolveRepo(store, args);
      if (!found) return { result: toolError('Repository not found') };
      const { repo } = found;
      const title = stringArg(args, ['title']);
      const body = stringArg(args, ['body', 'description']);
      const rawLabels = arg(args, ['labels']);
      const labels: Label[] = [];
      if (Array.isArray(rawLabels)) {
        for (const labelName of rawLabels) {
          if (typeof labelName !== 'string') continue;
          const label = repo.labels.get(labelName);
          if (!label) return { result: toolError(`Label "${labelName}" does not exist`) };
          labels.push(label);
        }
      }
      const issue = store.createIssue(repo, title, body, labels);
      return {
        result: toolResult({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
          created_at: issue.createdAt,
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
        }),
      };
    }
    case 'list_issues': {
      const found = resolveRepo(store, args);
      if (!found) return { result: toolError('Repository not found') };
      const { repo } = found;
      const state = stringArg(args, ['state']) || 'open';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return {
        result: toolResult({
          issues: issues.map((issue) => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels.map((label) => ({ name: label.name })),
            created_at: issue.createdAt,
          })),
          total_count: issues.length,
        }),
      };
    }
    case 'create_pull_request': {
      const found = resolveRepo(store, args);
      if (!found) return { result: toolError('Repository not found') };
      const { repo } = found;
      const created = store.createPull(
        repo,
        stringArg(args, ['title']),
        stringArg(args, ['body', 'description']),
        stringArg(args, ['head', 'head_ref', 'headRef']),
        stringArg(args, ['base', 'base_ref', 'baseRef']) || repo.defaultBranch,
      );
      if ('error' in created) return { result: toolError(created.error) };
      return {
        result: toolResult({
          id: created.id,
          number: created.number,
          title: created.title,
          body: created.body,
          state: created.state,
          head: { ref: created.headRef, sha: created.headSha },
          base: { ref: created.baseRef, sha: created.baseSha },
          created_at: created.createdAt,
          html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${created.number}`,
        }),
      };
    }
    case 'merge_pull_request': {
      const found = resolveRepo(store, args);
      if (!found) return { result: toolError('Repository not found') };
      const { repo } = found;
      const number = numberArg(args, ['pull_number', 'number', 'pr_number']);
      if (number === undefined) return { errorCode: -32602, errorMessage: 'Missing required argument: pull_number' };
      const pr = repo.pulls.find((entry) => entry.number === number);
      if (!pr) return { result: toolError('Pull request not found') };
      if (pr.state !== 'open') return { result: toolError('Pull request is already closed') };
      const sha = store.mergePull(repo, pr);
      if (sha === null) return { result: toolError('Merge conflict') };
      return {
        result: toolResult({
          number: pr.number,
          merged: true,
          sha,
          state: pr.state,
          merge_commit_sha: pr.mergeCommitSha,
          merged_at: pr.mergedAt,
        }),
      };
    }
    default:
      return { errorCode: -32601, errorMessage: `Unknown tool: ${name}` };
  }
}

export function handleMcp(store: Store, ctx: ReqCtx): Resp {
  if (ctx.bodyParseError) {
    return jsonResp(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const body = ctx.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResp(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const request = body as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {}) as Record<string, unknown>;

  const respond = (result: unknown): Resp => jsonResp(200, { jsonrpc: '2.0', id, result });
  const respondError = (code: number, message: string): Resp => jsonResp(200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover':
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      });
    case 'initialize':
      return respond({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      });
    case 'notifications/initialized':
      return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const outcome = callTool(store, toolName, params.arguments);
      if (outcome.errorCode !== undefined) return respondError(outcome.errorCode, outcome.errorMessage ?? 'Tool call failed');
      return respond(outcome.result ?? {});
    }
    default:
      if (method === '') return jsonResp(400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
      return respondError(-32601, `Method not found: ${method}`);
  }
}
