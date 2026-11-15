// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, over the shared in-memory store.
// Every reply is JSON; a repository under another owner is 404, never 403.

import { hashObject, parseTree } from './gitproto.ts';
import { errResp, jsonResp, noContentResp, type ReqCtx, type Resp } from './http.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Issue, type Label, type PullRequest, type Repo, type Store } from './store.ts';

const SHA40 = /^[0-9a-f]{40}$/i;

function userObject(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.globalId('repo', repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.globalId('issue', repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullObject(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: store.globalId('pull', repo, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: store.mergeable(repo, pr) === 'MERGEABLE',
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function bodyObject(ctx: ReqCtx): Record<string, unknown> {
  return (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function parsePagination(ctx: ReqCtx): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

/** Paginate `items`, answering the page plus a GitHub Link header. */
function paginate<T>(ctx: ReqCtx, items: readonly T[]): { page: T[]; link: string | null } {
  const { page, perPage } = parsePagination(ctx);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const base = `http://${ctx.host}${ctx.path}`;
  const query = new URLSearchParams(ctx.query);
  const linkFor = (p: number, rel: string): string => {
    query.set('page', String(p));
    query.set('per_page', String(perPage));
    return `<${base}?${query.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  if (totalPages > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(totalPages, 'last'));
  }
  return { page: [...pageItems], link: links.length ? links.join(', ') : null };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

/** Resolve /repos/{owner}/{repo} from the path; null when the shape does not match. */
function repoFromPath(store: Store, segments: string[], ownerIndex: number): { repo: Repo; owner: string; name: string } | null {
  const owner = segments[ownerIndex];
  const name = segments[ownerIndex + 1];
  if (owner === undefined || name === undefined) return null;
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  return { repo, owner, name };
}

export function handleRest(store: Store, ctx: ReqCtx): Resp | null {
  const seg = ctx.segments;
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'v3') return null;
  const rest = seg.slice(2);
  const method = ctx.method;

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: '',
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    });
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
      const body = bodyObject(ctx);
      const name = stringField(body, 'name');
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return errResp(422, 'Invalid repository name');
      if (store.getRepo(VIEWER_LOGIN, name)) return errResp(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: stringField(body, 'description'),
        private: body.private === true,
      });
      return jsonResp(201, repoObject(store, repo));
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(ctx, repos.map((repo) => repoObject(store, repo)));
      return jsonResp(200, page, linkHeaders(link));
    }
    return errResp(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const found = repoFromPath(store, rest, 1);
    if (!found) return errResp(404, 'Not Found');
    const { repo, owner, name } = found;
    const tail = rest.slice(3);

    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') return jsonResp(200, repoObject(store, repo));
      if (method === 'PATCH') {
        if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
        const body = bodyObject(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updatedAt = store.nowIso();
        return jsonResp(200, repoObject(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return noContentResp();
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/git/refs...
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
        const body = bodyObject(ctx);
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (!ref.startsWith('refs/') || !SHA40.test(sha)) return errResp(422, 'Invalid ref or sha');
        if (!repo.objects.has(sha)) return errResp(422, 'Object does not exist');
        if (repo.refs.has(ref)) return errResp(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return jsonResp(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const fullRef = `refs/${ref}`;
        const oid = repo.refs.get(fullRef);
        if (oid === undefined) return errResp(404, 'Not Found');
        return jsonResp(200, { ref: fullRef, object: { sha: oid, type: 'commit' } });
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/branches[/{branch}]
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! }, protected: false }));
        return jsonResp(200, branches);
      }
      if (method === 'GET' && tail.length >= 2) {
        const branch = tail.slice(1).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (oid === undefined) return errResp(404, 'Not Found');
        return jsonResp(200, { name: branch, commit: { sha: oid }, protected: false });
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/commits[?sha=]
    if (tail[0] === 'commits') {
      if (method === 'GET' && tail.length === 1) {
        const ref = ctx.query.get('sha') ?? repo.defaultBranch;
        const commits = store.listCommits(repo, ref);
        const body = commits.map((commit) => ({
          sha: commit.sha,
          commit: { message: commit.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
          author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        }));
        const { page, link } = paginate(ctx, body);
        return jsonResp(200, page, linkHeaders(link));
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/contents/{path}
    if (tail[0] === 'contents') {
      return handleContents(store, repo, ctx, tail.slice(1));
    }

    // /repos/{o}/{r}/labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
        const body = bodyObject(ctx);
        const labelName = stringField(body, 'name');
        if (labelName === '') return errResp(422, 'Invalid label name');
        const color = typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed';
        const existing = repo.labels.get(labelName);
        if (existing) return jsonResp(201, { name: existing.name, color: existing.color, description: existing.description });
        const label: Label = { name: labelName, color, description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(labelName, label);
        return jsonResp(201, { name: label.name, color: label.color, description: label.description });
      }
      if (method === 'GET' && tail.length === 1) {
        return jsonResp(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (tail[0] === 'issues') {
      return handleIssues(store, repo, ctx, tail.slice(1));
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (tail[0] === 'pulls') {
      return handlePulls(store, repo, ctx, tail.slice(1));
    }

    return errResp(404, 'Not Found');
  }

  return errResp(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function handleContents(store: Store, repo: Repo, ctx: ReqCtx, pathParts: string[]): Resp {
  const path = pathParts.join('/');
  const method = ctx.method;
  if (path === '') return errResp(404, 'Not Found');
  const body = bodyObject(ctx);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : (ctx.query.get('ref') ?? repo.defaultBranch);

  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const treeOid = store.refTree(repo, ref);
    if (treeOid === null) return errResp(404, 'Not Found');
    const files = store.flattenTree(repo, treeOid);
    const exact = files.get(path);
    if (exact) {
      const object = repo.objects.get(exact.oid)!;
      return jsonResp(200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: object.data.toString('base64'),
        sha: exact.oid,
      });
    }
    // A directory: every direct child (file or subdirectory) under the path.
    const prefix = `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, file] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { type: 'file', name: rest, path: filePath, sha: file.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          // The directory's tree oid: walk the tree to find it.
          const dirSha = findDirSha(store, repo, treeOid, `${path}/${dirName}`);
          children.set(dirName, { type: 'dir', name: dirName, path: `${path}/${dirName}`, sha: dirSha ?? '' });
        }
      }
    }
    if (children.size === 0) return errResp(404, 'Not Found');
    return jsonResp(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
  }

  if (method === 'PUT') {
    if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
    const message = stringField(body, 'message');
    const contentB64 = stringField(body, 'content');
    if (message === '' || contentB64 === '') return errResp(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return errResp(422, 'content is not valid base64');
    }
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    const treeOid = tip === undefined ? null : store.refTree(repo, branchRef);
    const files = treeOid === null ? new Map<string, { mode: string; oid: string }>() : store.flattenTree(repo, treeOid);
    const existing = files.get(path);
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing) {
      if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return errResp(409, 'sha does not match the current blob');
    } else if (sha !== undefined) {
      return errResp(422, 'sha does not match any existing file');
    }
    const blobSha = hashObject('blob', content);
    store.putObject(repo, 'blob', content);
    files.set(path, { mode: '100644', oid: blobSha });
    const { commitSha } = store.commitFiles(repo, branch, [...files.entries()].map(([p, f]) => ({ path: p, mode: f.mode, oid: f.oid })), message);
    const status = existing ? 200 : 201;
    return jsonResp(status, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
    const branchRef = `refs/heads/${branch}`;
    const treeOid = store.refTree(repo, branchRef);
    if (treeOid === null) return errResp(404, 'Not Found');
    const files = store.flattenTree(repo, treeOid);
    const existing = files.get(path);
    if (!existing) return errResp(404, 'Not Found');
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return errResp(409, 'sha does not match the current blob');
    files.delete(path);
    const message = stringField(body, 'message') || `Delete ${path}`;
    const { commitSha } = store.commitFiles(repo, branch, [...files.entries()].map(([p, f]) => ({ path: p, mode: f.mode, oid: f.oid })), message);
    return jsonResp(200, { commit: { sha: commitSha, message } });
  }

  return errResp(404, 'Not Found');
}

/** The tree oid of a nested directory path, by walking the tree. */
function findDirSha(store: Store, repo: Repo, treeOid: string, dirPath: string): string | null {
  const segments = dirPath.split('/');
  let current = treeOid;
  for (const segment of segments) {
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- issues

function handleIssues(store: Store, repo: Repo, ctx: ReqCtx, tail: string[]): Resp {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'POST') {
      if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
      const body = bodyObject(ctx);
      const title = stringField(body, 'title');
      if (title === '') return errResp(422, 'title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const labels: Label[] = [];
      for (const labelName of labelNames) {
        const label = repo.labels.get(labelName);
        if (!label) return errResp(422, `Label "${labelName}" does not exist`);
        labels.push(label);
      }
      const issue = store.createIssue(repo, title, stringField(body, 'body'), labels);
      return jsonResp(201, issueObject(store, repo, issue));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, link } = paginate(ctx, issues.map((issue) => issueObject(store, repo, issue)));
      return jsonResp(200, page, linkHeaders(link));
    }
    return errResp(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isSafeInteger(number) || number <= 0) return errResp(404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) return errResp(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return jsonResp(200, issueObject(store, repo, issue));
    if (method === 'PATCH') {
      if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
      const body = bodyObject(ctx);
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = store.nowIso();
      return jsonResp(200, issueObject(store, repo, issue));
    }
    return errResp(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
      const body = bodyObject(ctx);
      const commentBody = stringField(body, 'body');
      if (commentBody === '') return errResp(422, 'body is required');
      const now = store.nowIso();
      const comment = { id: repo.nextCommentId++, body: commentBody, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      return jsonResp(201, { id: comment.id, node_id: store.globalId('comment', repo, comment.id), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: comment.createdAt, updated_at: comment.updatedAt });
    }
    if (method === 'GET') {
      return jsonResp(
        200,
        issue.comments.map((comment) => ({ id: comment.id, node_id: store.globalId('comment', repo, comment.id), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: comment.createdAt, updated_at: comment.updatedAt })),
      );
    }
    return errResp(404, 'Not Found');
  }

  return errResp(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePulls(store: Store, repo: Repo, ctx: ReqCtx, tail: string[]): Resp {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'POST') {
      if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
      const body = bodyObject(ctx);
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base') || repo.defaultBranch;
      if (title === '' || head === '') return errResp(422, 'title and head are required');
      const created = store.createPull(repo, title, stringField(body, 'body'), head, base);
      if ('error' in created) return errResp(422, created.error);
      return jsonResp(201, pullObject(store, repo, created));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(ctx, pulls.map((pr) => pullObject(store, repo, pr)));
      return jsonResp(200, page, linkHeaders(link));
    }
    return errResp(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isSafeInteger(number) || number <= 0) return errResp(404, 'Not Found');
  const pr = repo.pulls.find((entry) => entry.number === number);
  if (!pr) return errResp(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return jsonResp(200, pullObject(store, repo, pr));
    return errResp(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, store.pullFiles(repo, pr));
  }

  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return errResp(404, 'Not Found');
    if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
    if (pr.state !== 'open') return errResp(405, 'Pull request is already closed');
    const mergeSha = store.mergePull(repo, pr);
    if (mergeSha === null) return errResp(405, 'Merge conflict');
    return jsonResp(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
  }

  return errResp(404, 'Not Found');
}
