// store.ts — the forge's in-memory store: repositories, git objects and refs,
// issues, pull requests, labels and comments. One process, one store, no disk.
// A deterministic logical clock (fixed epoch + a counter) keeps every timestamp
// identical across runs, so a replayed trial sees the same bytes.

import { buildCommit, buildTree, collectReachable, hashObject, isAncestor, isOid, mergeBase, parseCommit, parseTree, type GitObject, type GitObjectType, type TreeEntry } from './gitproto.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

const CLOCK_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextId: number;
  nextCommentId: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private clockSeq = 0;

  /** A deterministic timestamp: the epoch plus one second per call, ISO format. */
  nowIso(): string {
    this.clockSeq += 1;
    return new Date((CLOCK_EPOCH_SEC + this.clockSeq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The logical clock as Unix seconds (for commit author lines). */
  nowSec(): number {
    this.clockSeq += 1;
    return CLOCK_EPOCH_SEC + this.clockSeq;
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.repoIdSeq++,
      name,
      owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.clockSeq,
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextId: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Flatten a tree into path -> {mode, oid} for blob entries only. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else if (entry.mode !== '160000') {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /** Build a tree (creating tree objects) from flat path entries. */
  buildTreeFromFiles(repo: Repo, files: ReadonlyArray<{ path: string; mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const file of files) {
      const segments = file.path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, { mode: file.mode, oid: file.oid });
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid of a ref (branch name or oid), or null when it cannot be resolved. */
  refTree(repo: Repo, ref: string): string | null {
    const oid = this.resolveRef(repo, ref);
    if (oid === null) return null;
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return parseCommit(object.data).tree;
    if (object.type === 'tree') return oid;
    return null;
  }

  /** Resolve a branch name, a full ref, or an oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    return oid ?? null;
  }

  /** Create a commit on a branch: new tree from `files` (flat path list), parent = branch tip. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: ReadonlyArray<{ path: string; mode: string; oid: string }>,
    message: string,
  ): { commitSha: string; treeSha: string } {
    const treeSha = this.buildTreeFromFiles(repo, files);
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const parents = parent !== undefined ? [parent] : [];
    const ts = this.nowSec();
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commitData = buildCommit({
      tree: treeSha,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
      timestamp: ts,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, treeSha };
  }

  /** The commit history reachable from `ref`, newest first (by commit timestamp, then discovery). */
  listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string; timestamp: number }> {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const out: Array<{ sha: string; message: string; timestamp: number }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const authorTs = Number.parseInt(commit.author.split(' ').slice(-2, -1)[0] ?? '0', 10) || 0;
      out.push({ sha: oid, message: commit.message, timestamp: authorTs });
      for (const parent of commit.parents) queue.push(parent);
    }
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }

  // ------------------------------------------------------------ issues / pulls

  globalId(kind: 'repo' | 'issue' | 'pull' | 'comment', repo: Repo, n?: number): string {
    const raw =
      kind === 'repo'
        ? `Repository:${repo.owner}/${repo.name}:${repo.id}`
        : kind === 'issue'
          ? `Issue:${repo.owner}/${repo.name}:${n}`
          : kind === 'pull'
            ? `PullRequest:${repo.owner}/${repo.name}:${n}`
            : `Comment:${repo.owner}/${repo.name}:${n}`;
    return Buffer.from(raw, 'utf8').toString('base64url');
  }

  decodeGlobalId(id: string): { kind: string; owner: string; name: string; n: number } | null {
    try {
      const raw = Buffer.from(id, 'base64url').toString('utf8');
      const match = /^(Repository|Issue|PullRequest|Comment):([^/]+)\/([^:]+):(\d+)$/.exec(raw);
      if (!match) return null;
      return { kind: match[1]!, owner: match[2]!, name: match[3]!, n: Number(match[4]) };
    } catch {
      return null;
    }
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = this.nowIso();
    const issue: Issue = {
      id: repo.nextId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.clockSeq,
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (headSha === null) return { error: `head ref ${head} does not exist` };
    if (baseSha === null) return { error: `base ref ${base} does not exist` };
    const existing = repo.pulls.find((pr) => pr.headRef === head && pr.baseRef === base && pr.state === 'open');
    if (existing) return { error: `a pull request from ${head} to ${base} is already open (#${existing.number})` };
    const now = this.nowIso();
    const baseOid = mergeBase(headSha, baseSha, this.lookup(repo));
    const pr: PullRequest = {
      id: repo.nextId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeBaseSha: baseOid,
      createdSeq: this.clockSeq,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pr);
    return pr;
  }

  /** The changed files between the PR's merge-base and its head, against the base tip. */
  pullFiles(repo: Repo, pr: PullRequest): PullFile[] {
    const baseTree = this.refTree(repo, pr.baseSha) ?? '';
    const headTree = this.refTree(repo, pr.headSha) ?? '';
    const baseFiles = baseTree === '' ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === '' ? new Map() : this.flattenTree(repo, headTree);
    const out: PullFile[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (inBase && !inHead) {
        const oldLines = this.blobLines(repo, inBase.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: oldLines, changes: oldLines });
      } else if (!inBase && inHead) {
        const newLines = this.blobLines(repo, inHead.oid);
        out.push({ filename: path, status: 'added', additions: newLines, deletions: 0, changes: newLines });
      } else if (inBase && inHead && inBase.oid !== inHead.oid) {
        const oldLines = this.blobLines(repo, inBase.oid);
        const newLines = this.blobLines(repo, inHead.oid);
        out.push({ filename: path, status: 'modified', additions: newLines, deletions: oldLines, changes: newLines + oldLines });
      }
    }
    return out;
  }

  private blobLines(repo: Repo, oid: string): number {
    const object = repo.objects.get(oid);
    if (!object) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /** Whether merging `pr` would conflict (three-way merge against the merge-base). */
  pullConflict(repo: Repo, pr: PullRequest): boolean {
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (baseTip === null) return true;
    const mergeBaseSha = pr.mergeBaseSha ?? mergeBase(pr.headSha, baseTip, this.lookup(repo));
    if (mergeBaseSha === null) return false;
    const baseOfMerge = this.refTree(repo, mergeBaseSha);
    const oursTree = this.refTree(repo, baseTip);
    const theirsTree = this.refTree(repo, pr.headSha);
    const baseFiles = baseOfMerge ? this.flattenTree(repo, baseOfMerge) : new Map();
    const oursFiles = oursTree ? this.flattenTree(repo, oursTree) : new Map();
    const theirsFiles = theirsTree ? this.flattenTree(repo, theirsTree) : new Map();
    const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid ?? null;
      const o = oursFiles.get(path)?.oid ?? null;
      const t = theirsFiles.get(path)?.oid ?? null;
      if (t !== b && o !== b && t !== o) return true;
    }
    return false;
  }

  /** Squash-merge `pr` onto its base branch. Returns the merge commit sha, or null on conflict. */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    if (pr.state !== 'open' || pr.merged) return null;
    if (this.pullConflict(repo, pr)) return null;
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (baseTip === null) return null;
    const mergeBaseSha = pr.mergeBaseSha ?? mergeBase(pr.headSha, baseTip, this.lookup(repo));
    const baseOfMerge = mergeBaseSha ? this.refTree(repo, mergeBaseSha) : null;
    const oursTree = this.refTree(repo, baseTip);
    const theirsTree = this.refTree(repo, pr.headSha);
    const baseFiles = baseOfMerge ? this.flattenTree(repo, baseOfMerge) : new Map();
    const oursFiles = oursTree ? this.flattenTree(repo, oursTree) : new Map();
    const theirsFiles = theirsTree ? this.flattenTree(repo, theirsTree) : new Map();
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid ?? null;
      const o = oursFiles.get(path);
      const t = theirsFiles.get(path);
      if (t !== undefined && (t.oid !== b || o === undefined)) {
        // Theirs changed (or added) the path: take theirs.
        if (t.oid !== b) merged.set(path, { mode: t.mode, oid: t.oid });
        else if (o !== undefined) merged.set(path, { mode: o.mode, oid: o.oid });
      } else if (o !== undefined) {
        merged.set(path, { mode: o.mode, oid: o.oid });
      }
      // A path theirs deleted (t undefined, o defined, b defined) stays deleted when ours did not change it.
      if (t === undefined && o !== undefined && b !== null && o.oid === b) merged.delete(path);
    }
    const treeSha = this.buildTreeFromFiles(repo, [...merged.entries()].map(([path, file]) => ({ path, mode: file.mode, oid: file.oid })));
    const ts = this.nowSec();
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`;
    const commitData = buildCommit({
      tree: treeSha,
      parents: [baseTip],
      message,
      author: who,
      committer: who,
      timestamp: ts,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.nowIso();
    pr.mergeCommitSha = mergeSha;
    pr.baseSha = mergeSha;
    pr.updatedAt = pr.mergedAt;
    return mergeSha;
  }

  /** 'MERGEABLE' | 'CONFLICTING' for a pull request (UNKNOWN when a side is missing). */
  mergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.merged) return 'MERGEABLE';
    if (this.resolveRef(repo, pr.headRef) === null || this.resolveRef(repo, pr.baseRef) === null) return 'UNKNOWN';
    return this.pullConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
  }

  isAncestorIn(repo: Repo, ancestor: string, descendant: string): boolean {
    return isAncestor(ancestor, descendant, this.lookup(repo));
  }

  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo));
  }
}
