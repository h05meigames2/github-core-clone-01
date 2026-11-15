// graphql.ts — GitHub GraphQL v4, a deliberately small subset: a hand-written
// recursive-descent parser plus an executor over the shared store. The subset
// covers the documented operations (viewer, repository, node, __type,
// issue/pull-request connections and the five mutations) and nothing else;
// anything outside it fails as a validation error, HTTP 200 with errors.

import { errResp, jsonResp, type ReqCtx, type Resp } from './http.ts';
import { VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------ tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (token: Token): void => {
    tokens.push(token);
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('Unterminated block string');
        push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\\n/g, '') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1];
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === '"') value += '"';
          else if (escaped === '\\') value += '\\';
          else if (escaped === '/') value += '/';
          else if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += escaped ?? '';
          j += 2;
          continue;
        }
        value += source[j];
        j++;
      }
      if (j >= source.length) throw new Error('Unterminated string');
      push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!match) throw new Error(`Unexpected character ${ch}`);
      const text = match[0];
      push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = match![0];
      push({ kind: 'name', value: text });
      i += text.length;
      continue;
    }
    throw new Error(`Unexpected character ${ch}`);
  }
  return tokens;
}

// -------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'Field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of document');
    this.pos++;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected name');
    if (value !== undefined && token.value !== value) throw new Error(`Expected ${value}`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', variables: [], selections: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token ${token.kind}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const kind = this.next().value as 'query' | 'mutation';
    let name: string | undefined;
    if (this.peek()?.kind === 'name') name = this.next().value;
    const variables: OperationNode['variables'] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // Skip the type (names, [ ] and !) until a default value or the next variable.
        while (true) {
          const token = this.peek();
          if (!token) throw new Error('Unexpected end of variable definition');
          if (token.kind === 'punct' && (token.value === '=' || token.value === ',' || token.value === ')')) break;
          this.next();
        }
        let defaultValue: ValueNode | undefined;
        if (this.isPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    return { kind, name, variables, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.pos >= this.tokens.length) throw new Error('Unterminated selection set');
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (next?.kind === 'name') {
          selections.push({ kind: 'FragmentSpread', name: this.next().value });
        } else {
          selections.push({ kind: 'InlineFragment', selections: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives are accepted and ignored.
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    let selections: SelectionNode[] | undefined;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct') {
      if (token.value === '$') return { kind: 'Variable', name: this.expectName() };
      if (token.value === '[') {
        const values: ValueNode[] = [];
        while (!this.isPunct(']')) values.push(this.parseValue());
        this.expectPunct(']');
        return { kind: 'List', values };
      }
      if (token.value === '{') {
        const fields: Array<{ name: string; value: ValueNode }> = [];
        while (!this.isPunct('}')) {
          const name = this.expectName();
          this.expectPunct(':');
          fields.push({ name, value: this.parseValue() });
        }
        this.expectPunct('}');
        return { kind: 'Object', fields };
      }
    }
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'int') return { kind: 'Int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'Float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error('Unexpected value');
  }
}

// ------------------------------------------------------------------- executor

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
}

/** A resolved object: its GraphQL type plus the store record it wraps. */
type Obj =
  | { __typename: 'Query' }
  | { __typename: 'User' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __typename: 'Ref'; repo: Repo; name: string; oid: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[] }
  | { __typename: 'PullRequestConnection'; repo: Repo; prs: PullRequest[] }
  | { __typename: 'IssueEdge'; repo: Repo; issue: Issue; cursor: string }
  | { __typename: 'PullRequestEdge'; repo: Repo; pr: PullRequest; cursor: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'FileConnection'; files: Array<{ path: string; additions: number; deletions: number; changeType: string }> }
  | { __typename: 'FileChange'; path: string; additions: number; deletions: number; changeType: string }
  | { __typename: '__Type'; name: string; kind: string; fields: string[] | null; enumValues: string[] | null }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'IssueComment'; repo: Repo; id: number; body: string }
  | { __typename: 'IssueCommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __typename: 'IssueMutationResult'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequestMutationResult'; repo: Repo; pr: PullRequest }
  | { __typename: 'CommentMutationResult'; repo: Repo; issue: Issue };

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt', 'author'],
  User: ['login', 'name', 'email', 'id'],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileChange: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node', 'cursor'],
};

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((child) => valueFromNode(child, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueFromNode(arg.value, ctx.variables);
  return out;
}

/** Decode a global id into the store's own kind names. */
function decodeNodeId(store: Store, id: string): { kind: 'repo' | 'issue' | 'pull'; owner: string; name: string; number: number } | null {
  const decoded = store.decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') return { kind: 'repo', owner: decoded.owner, name: decoded.name, number: decoded.n };
  if (decoded.kind === 'Issue') return { kind: 'issue', owner: decoded.owner, name: decoded.name, number: decoded.n };
  if (decoded.kind === 'PullRequest') return { kind: 'pull', owner: decoded.owner, name: decoded.name, number: decoded.n };
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | null): number | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/** Collect the fields of a selection set, expanding fragments that apply to `typeName`. */
function collectFields(selections: SelectionNode[], typeName: string, ctx: ExecCtx, out: FieldNode[] = []): FieldNode[] {
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      out.push(selection);
    } else if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        collectFields(selection.selections, typeName, ctx, out);
      }
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === '')) {
        collectFields(fragment.selections, typeName, ctx, out);
      }
    }
  }
  return out;
}

/** Execute a selection set against a resolved value. */
function executeSelections(typeName: string, value: unknown, selections: SelectionNode[] | undefined, ctx: ExecCtx): unknown {
  if (selections === undefined) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => executeSelections(typeName, entry, selections, ctx));
  const obj = value as Obj;
  const fields = collectFields(selections, typeName, ctx);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const responseName = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseName] = typeName;
      continue;
    }
    const resolved = resolveField(typeName, obj, field, ctx);
    if (resolved === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseName] = null;
      continue;
    }
    const { value: childValue, typeName: childType } = resolved;
    if (field.selections !== undefined) {
      out[responseName] = executeSelections(childType, childValue, field.selections, ctx);
    } else {
      out[responseName] = childValue;
    }
  }
  return out;
}

interface Resolved {
  value: unknown;
  typeName: string;
}

function asInput(value: unknown): Record<string, unknown> {
  return (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
}

function resolveField(typeName: string, obj: Obj, field: FieldNode, ctx: ExecCtx): Resolved | undefined {
  const args = argsOf(field, ctx);
  const store = ctx.store;

  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { value: { __typename: 'User' } as Obj, typeName: 'User' };
      case 'repository': {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo) return { value: null, typeName: 'Repository' };
        return { value: { __typename: 'Repository', repo } as Obj, typeName: 'Repository' };
      }
      case 'node': {
        const id = String(args.id ?? '');
        const decoded = decodeNodeId(store, id);
        if (!decoded) return { value: null, typeName: 'Repository' };
        const repo = store.getRepo(decoded.owner, decoded.name);
        if (!repo) return { value: null, typeName: 'Repository' };
        if (decoded.kind === 'repo') return { value: { __typename: 'Repository', repo } as Obj, typeName: 'Repository' };
        if (decoded.kind === 'issue') {
          const issue = repo.issues.find((entry) => entry.number === decoded.number);
          if (!issue) return { value: null, typeName: 'Issue' };
          return { value: { __typename: 'Issue', repo, issue } as Obj, typeName: 'Issue' };
        }
        if (decoded.kind === 'pull') {
          const pr = repo.pulls.find((entry) => entry.number === decoded.number);
          if (!pr) return { value: null, typeName: 'PullRequest' };
          return { value: { __typename: 'PullRequest', repo, pr } as Obj, typeName: 'PullRequest' };
        }
        return { value: null, typeName: 'Repository' };
      }
      case '__type': {
        const name = String(args.name ?? '');
        const typeInfo = lookupType(name);
        if (!typeInfo) return { value: null, typeName: '__Type' };
        return { value: typeInfo, typeName: '__Type' };
      }
      case 'createIssue':
      case 'closeIssue':
      case 'createPullRequest':
      case 'mergePullRequest':
      case 'addComment':
        return resolveMutation(field, ctx);
      default:
        return undefined;
    }
  }

  if (typeName === 'Repository') {
    const { repo } = obj as { repo: Repo };
    switch (field.name) {
      case 'id':
        return { value: store.globalId('repo', repo), typeName: 'String' };
      case 'databaseId':
        return { value: repo.id, typeName: 'Int' };
      case 'name':
        return { value: repo.name, typeName: 'String' };
      case 'nameWithOwner':
        return { value: `${repo.owner}/${repo.name}`, typeName: 'String' };
      case 'owner':
        return { value: { __typename: 'User' } as Obj, typeName: 'User' };
      case 'defaultBranchRef': {
        const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (oid === undefined) return { value: null, typeName: 'Ref' };
        return { value: { __typename: 'Ref', repo, name: repo.defaultBranch, oid } as Obj, typeName: 'Ref' };
      }
      case 'viewerPermission':
        return { value: 'ADMIN', typeName: 'String' };
      case 'hasIssuesEnabled':
        return { value: true, typeName: 'Boolean' };
      case 'issue': {
        const issue = repo.issues.find((entry) => entry.number === Number(args.number));
        if (!issue) return { value: null, typeName: 'Issue' };
        return { value: { __typename: 'Issue', repo, issue } as Obj, typeName: 'Issue' };
      }
      case 'issues':
        return { value: issueConnection(repo, args), typeName: 'IssueConnection' };
      case 'pullRequests':
        return { value: pullRequestConnection(repo, args), typeName: 'PullRequestConnection' };
      case 'pullRequest': {
        const pr = repo.pulls.find((entry) => entry.number === Number(args.number));
        if (!pr) return { value: null, typeName: 'PullRequest' };
        return { value: { __typename: 'PullRequest', repo, pr } as Obj, typeName: 'PullRequest' };
      }
      default:
        return undefined;
    }
  }

  if (typeName === 'Issue') {
    const { repo, issue } = obj as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return { value: store.globalId('issue', repo, issue.number), typeName: 'String' };
      case 'number':
        return { value: issue.number, typeName: 'Int' };
      case 'title':
        return { value: issue.title, typeName: 'String' };
      case 'body':
        return { value: issue.body, typeName: 'String' };
      case 'state':
        return { value: issue.state === 'open' ? 'OPEN' : 'CLOSED', typeName: 'String' };
      case 'createdAt':
        return { value: issue.createdAt, typeName: 'String' };
      case 'updatedAt':
        return { value: issue.updatedAt, typeName: 'String' };
      case 'url':
        return { value: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`, typeName: 'String' };
      case 'author':
        return { value: { __typename: 'User' } as Obj, typeName: 'User' };
      case 'repository':
        return { value: { __typename: 'Repository', repo } as Obj, typeName: 'Repository' };
      default:
        return undefined;
    }
  }

  if (typeName === 'PullRequest') {
    const { repo, pr } = obj as { repo: Repo; pr: PullRequest };
    switch (field.name) {
      case 'id':
        return { value: store.globalId('pull', repo, pr.number), typeName: 'String' };
      case 'number':
        return { value: pr.number, typeName: 'Int' };
      case 'title':
        return { value: pr.title, typeName: 'String' };
      case 'body':
        return { value: pr.body, typeName: 'String' };
      case 'headRefName':
        return { value: pr.headRef, typeName: 'String' };
      case 'baseRefName':
        return { value: pr.baseRef, typeName: 'String' };
      case 'mergeable':
        return { value: store.mergeable(repo, pr), typeName: 'String' };
      case 'state':
        return { value: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED', typeName: 'String' };
      case 'merged':
        return { value: pr.merged, typeName: 'Boolean' };
      case 'files': {
        const files = store.pullFiles(repo, pr).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status }));
        return { value: { __typename: 'FileConnection', files } as Obj, typeName: 'FileConnection' };
      }
      case 'createdAt':
        return { value: pr.createdAt, typeName: 'String' };
      case 'updatedAt':
        return { value: pr.updatedAt, typeName: 'String' };
      case 'author':
        return { value: { __typename: 'User' } as Obj, typeName: 'User' };
      default:
        return undefined;
    }
  }

  if (typeName === 'User') {
    switch (field.name) {
      case 'login':
        return { value: VIEWER_LOGIN, typeName: 'String' };
      case 'name':
        return { value: VIEWER_NAME, typeName: 'String' };
      case 'email':
        return { value: VIEWER_EMAIL, typeName: 'String' };
      case 'id':
        return { value: Buffer.from('User:adaiversen', 'utf8').toString('base64url'), typeName: 'String' };
      default:
        return undefined;
    }
  }

  if (typeName === 'Ref') {
    const { name, oid } = obj as { name: string; oid: string };
    switch (field.name) {
      case 'name':
        return { value: name, typeName: 'String' };
      case 'target':
        return { value: oid, typeName: 'String' };
      default:
        return undefined;
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    const record = obj as { name?: string };
    if (field.name === 'name' && typeof record.name === 'string') return { value: record.name, typeName: 'String' };
    return undefined;
  }

  if (typeName === 'IssueComment') {
    const record = obj as { repo: Repo; id: number; body: string };
    if (field.name === 'id') return { value: store.globalId('comment', record.repo, record.id), typeName: 'String' };
    if (field.name === 'body') return { value: record.body, typeName: 'String' };
    return undefined;
  }

  if (typeName === 'IssueCommentEdge') {
    const edge = obj as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
    if (field.name === 'node') return { value: { __typename: 'IssueComment', repo: edge.repo, id: edge.comment.id, body: edge.comment.body } as Obj, typeName: 'IssueComment' };
    if (field.name === 'cursor') return { value: cursorFor(edge.comment.id), typeName: 'String' };
    return undefined;
  }

  if (typeName === 'IssueConnection') {
    const { repo, issues } = obj as { repo: Repo; issues: Issue[] };
    const window = obj as unknown as Record<string, unknown>;
    switch (field.name) {
      case 'nodes':
        return { value: issues.map((issue) => ({ __typename: 'Issue', repo, issue }) as Obj), typeName: 'Issue' };
      case 'edges':
        return { value: issues.map((issue) => ({ __typename: 'IssueEdge', repo, issue, cursor: cursorFor(issue.number) }) as Obj), typeName: 'IssueEdge' };
      case 'pageInfo':
        return { value: { __typename: 'PageInfo', hasNextPage: Boolean(window.__hasNextPage), endCursor: (window.__endCursor as string | null) ?? null } as Obj, typeName: 'PageInfo' };
      case 'totalCount':
        return { value: issues.length, typeName: 'Int' };
      default:
        return undefined;
    }
  }

  if (typeName === 'PullRequestConnection') {
    const { repo, prs } = obj as { repo: Repo; prs: PullRequest[] };
    const window = obj as unknown as Record<string, unknown>;
    switch (field.name) {
      case 'nodes':
        return { value: prs.map((pr) => ({ __typename: 'PullRequest', repo, pr }) as Obj), typeName: 'PullRequest' };
      case 'edges':
        return { value: prs.map((pr) => ({ __typename: 'PullRequestEdge', repo, pr, cursor: cursorFor(pr.number) }) as Obj), typeName: 'PullRequestEdge' };
      case 'pageInfo':
        return { value: { __typename: 'PageInfo', hasNextPage: Boolean(window.__hasNextPage), endCursor: (window.__endCursor as string | null) ?? null } as Obj, typeName: 'PageInfo' };
      case 'totalCount':
        return { value: prs.length, typeName: 'Int' };
      default:
        return undefined;
    }
  }

  if (typeName === 'IssueEdge') {
    const { repo, issue, cursor } = obj as { repo: Repo; issue: Issue; cursor: string };
    if (field.name === 'node') return { value: { __typename: 'Issue', repo, issue } as Obj, typeName: 'Issue' };
    if (field.name === 'cursor') return { value: cursor, typeName: 'String' };
    return undefined;
  }

  if (typeName === 'PullRequestEdge') {
    const { repo, pr, cursor } = obj as { repo: Repo; pr: PullRequest; cursor: string };
    if (field.name === 'node') return { value: { __typename: 'PullRequest', repo, pr } as Obj, typeName: 'PullRequest' };
    if (field.name === 'cursor') return { value: cursor, typeName: 'String' };
    return undefined;
  }

  if (typeName === 'PageInfo') {
    const info = obj as { hasNextPage: boolean; endCursor: string | null };
    switch (field.name) {
      case 'hasNextPage':
        return { value: info.hasNextPage, typeName: 'Boolean' };
      case 'endCursor':
        return { value: info.endCursor, typeName: 'String' };
      case 'hasPreviousPage':
        return { value: false, typeName: 'Boolean' };
      case 'startCursor':
        return { value: null, typeName: 'String' };
      default:
        return undefined;
    }
  }

  if (typeName === 'FileConnection') {
    const { files } = obj as { files: Array<{ path: string; additions: number; deletions: number; changeType: string }> };
    switch (field.name) {
      case 'nodes':
        return { value: files.map((file) => ({ __typename: 'FileChange', ...file }) as Obj), typeName: 'FileChange' };
      case 'edges':
        return { value: files.map((file) => ({ __typename: 'FileChange', ...file }) as Obj), typeName: 'FileChange' };
      case 'pageInfo':
        return { value: { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as Obj, typeName: 'PageInfo' };
      case 'totalCount':
        return { value: files.length, typeName: 'Int' };
      default:
        return undefined;
    }
  }

  if (typeName === 'FileChange') {
    const file = obj as { path: string; additions: number; deletions: number; changeType: string };
    switch (field.name) {
      case 'path':
        return { value: file.path, typeName: 'String' };
      case 'additions':
        return { value: file.additions, typeName: 'Int' };
      case 'deletions':
        return { value: file.deletions, typeName: 'Int' };
      case 'changeType':
        return { value: file.changeType, typeName: 'String' };
      default:
        return undefined;
    }
  }

  if (typeName === '__Type') {
    const info = obj as { name: string; kind: string; fields: string[] | null; enumValues: string[] | null };
    switch (field.name) {
      case 'name':
        return { value: info.name, typeName: 'String' };
      case 'kind':
        return { value: info.kind, typeName: 'String' };
      case 'fields':
        return { value: info.fields === null ? null : info.fields.map((name) => ({ __typename: '__Field', name }) as Obj), typeName: '__Field' };
      case 'enumValues':
        return { value: info.enumValues === null ? null : info.enumValues.map((name) => ({ __typename: '__EnumValue', name }) as Obj), typeName: '__EnumValue' };
      default:
        return undefined;
    }
  }

  if (typeName === 'IssueMutationResult') {
    const { repo, issue } = obj as { repo: Repo; issue: Issue };
    if (field.name === 'issue') return { value: { __typename: 'Issue', repo, issue } as Obj, typeName: 'Issue' };
    if (field.name === 'clientMutationId') return { value: null, typeName: 'String' };
    return undefined;
  }

  if (typeName === 'PullRequestMutationResult') {
    const { repo, pr } = obj as { repo: Repo; pr: PullRequest };
    if (field.name === 'pullRequest') return { value: { __typename: 'PullRequest', repo, pr } as Obj, typeName: 'PullRequest' };
    if (field.name === 'clientMutationId') return { value: null, typeName: 'String' };
    return undefined;
  }

  if (typeName === 'CommentMutationResult') {
    const { repo, issue } = obj as { repo: Repo; issue: Issue };
    if (field.name === 'commentEdge') {
      const comment = issue.comments[issue.comments.length - 1];
      if (!comment) return { value: null, typeName: 'IssueCommentEdge' };
      return { value: { __typename: 'IssueCommentEdge', repo, issue, comment } as Obj, typeName: 'IssueCommentEdge' };
    }
    if (field.name === 'comment') {
      const comment = issue.comments[issue.comments.length - 1];
      if (!comment) return { value: null, typeName: 'IssueComment' };
      return { value: { __typename: 'IssueComment', repo, id: comment.id, body: comment.body } as Obj, typeName: 'IssueComment' };
    }
    if (field.name === 'clientMutationId') return { value: null, typeName: 'String' };
    return undefined;
  }

  return undefined;
}

function lookupType(name: string): Obj | null {
  if (name === 'SearchType') {
    return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'] } as Obj;
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return { __typename: '__Type', name, kind: 'OBJECT', fields, enumValues: null } as Obj;
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Obj {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = asInput(args.orderBy);
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
  if (field === 'CREATED_AT') {
    issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.min(args.first, 100) : 30;
  const after = cursorNumber(typeof args.after === 'string' ? args.after : null);
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
  }
  // The page window is kept on the connection object so pageInfo can see it.
  const page = issues.slice(0, first);
  const connection = { __typename: 'IssueConnection', repo, issues: page } as Obj;
  (connection as unknown as Record<string, unknown>).__hasNextPage = issues.length > first;
  (connection as unknown as Record<string, unknown>).__endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return connection;
}

function pullRequestConnection(repo: Repo, args: Record<string, unknown>): Obj {
  let prs = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    prs = prs.filter((pr) => wanted.has(pr.merged ? 'MERGED' : pr.state.toUpperCase()));
  }
  const orderBy = asInput(args.orderBy);
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  prs.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.min(args.first, 100) : 30;
  const after = cursorNumber(typeof args.after === 'string' ? args.after : null);
  if (after !== null) {
    prs = prs.filter((pr) => (direction === 'ASC' ? pr.number > after : pr.number < after));
  }
  const page = prs.slice(0, first);
  const connection = { __typename: 'PullRequestConnection', repo, prs: page } as Obj;
  (connection as unknown as Record<string, unknown>).__hasNextPage = prs.length > first;
  (connection as unknown as Record<string, unknown>).__endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return connection;
}

function resolveMutation(field: FieldNode, ctx: ExecCtx): Resolved | undefined {
  const args = argsOf(field, ctx);
  const input = asInput(args.input);
  const store = ctx.store;

  if (field.name === 'createIssue') {
    const decoded = decodeNodeId(store, String(input.repositoryId ?? ''));
    if (!decoded) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return { value: null, typeName: 'IssueMutationResult' };
    }
    const repo = store.getRepo(decoded.owner, decoded.name);
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return { value: null, typeName: 'IssueMutationResult' };
    }
    const issue = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    return { value: { __typename: 'IssueMutationResult', repo, issue } as Obj, typeName: 'IssueMutationResult' };
  }

  if (field.name === 'closeIssue') {
    const decoded = decodeNodeId(store, String(input.issueId ?? ''));
    if (!decoded) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return { value: null, typeName: 'IssueMutationResult' };
    }
    const repo = store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.find((entry) => entry.number === decoded.number);
    if (!issue || !repo) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return { value: null, typeName: 'IssueMutationResult' };
    }
    issue.state = 'closed';
    issue.updatedAt = store.nowIso();
    return { value: { __typename: 'IssueMutationResult', repo, issue } as Obj, typeName: 'IssueMutationResult' };
  }

  if (field.name === 'createPullRequest') {
    const decoded = decodeNodeId(store, String(input.repositoryId ?? ''));
    if (!decoded) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return { value: null, typeName: 'PullRequestMutationResult' };
    }
    const repo = store.getRepo(decoded.owner, decoded.name);
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return { value: null, typeName: 'PullRequestMutationResult' };
    }
    const created = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch));
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return { value: null, typeName: 'PullRequestMutationResult' };
    }
    return { value: { __typename: 'PullRequestMutationResult', repo, pr: created } as Obj, typeName: 'PullRequestMutationResult' };
  }

  if (field.name === 'mergePullRequest') {
    const decoded = decodeNodeId(store, String(input.pullRequestId ?? ''));
    if (!decoded) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return { value: null, typeName: 'PullRequestMutationResult' };
    }
    const repo = store.getRepo(decoded.owner, decoded.name);
    const pr = repo?.pulls.find((entry) => entry.number === decoded.number);
    if (!pr || !repo) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return { value: null, typeName: 'PullRequestMutationResult' };
    }
    const sha = store.mergePull(repo, pr);
    if (sha === null) {
      ctx.errors.push({ message: 'Merge conflict' });
      return { value: null, typeName: 'PullRequestMutationResult' };
    }
    return { value: { __typename: 'PullRequestMutationResult', repo, pr } as Obj, typeName: 'PullRequestMutationResult' };
  }

  if (field.name === 'addComment') {
    const decoded = decodeNodeId(store, String(input.subjectId ?? ''));
    if (!decoded) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return { value: null, typeName: 'CommentMutationResult' };
    }
    const repo = store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.find((entry) => entry.number === decoded.number);
    if (!issue || !repo) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return { value: null, typeName: 'CommentMutationResult' };
    }
    const now = store.nowIso();
    issue.comments.push({ id: repo.nextCommentId++, body: String(input.body ?? ''), createdAt: now, updatedAt: now });
    return { value: { __typename: 'CommentMutationResult', repo, issue } as Obj, typeName: 'CommentMutationResult' };
  }

  return undefined;
}

// ------------------------------------------------------------------- handler

function executeOne(store: Store, body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query === '') {
    return { errors: [{ message: 'query is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : 'GraphQL syntax error' }] };
  }
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables) ? body.variables : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation =
    operationName !== undefined
      ? document.operations.find((entry) => entry.name === operationName)
      : document.operations[0];
  if (!operation) return { errors: [{ message: 'Unknown operation' }] };
  const ctx: ExecCtx = { store, variables, errors: [], fragments: document.fragments };
  for (const variable of operation.variables) {
    if (ctx.variables[variable.name] === undefined && variable.defaultValue !== undefined) {
      ctx.variables[variable.name] = valueFromNode(variable.defaultValue, ctx.variables);
    }
  }
  const data = executeSelections('Query', { __typename: 'Query' } as Obj, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphql(store: Store, ctx: ReqCtx): Resp {
  if (ctx.bodyParseError) return errResp(400, 'Invalid JSON body');
  const body = ctx.body;
  if (Array.isArray(body)) {
    return jsonResp(200, body.map((entry) => executeOne(store, asInput(entry))));
  }
  if (body !== null && typeof body === 'object') {
    return jsonResp(200, executeOne(store, body as Record<string, unknown>));
  }
  return errResp(400, 'Invalid JSON body');
}
