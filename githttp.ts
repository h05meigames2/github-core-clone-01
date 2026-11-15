// githttp.ts — git smart HTTP: info/refs (v0 + v2 advertisements), ls-refs,
// upload-pack (protocol v2 and v0, with shallow fetches), and receive-pack
// (v0, report-status, side-band-64k, delete-refs, fast-forward-only updates).

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitproto.ts';
import { DEFAULT_BRANCH, type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0';

export interface GitRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, sorted, with peeled targets for annotated tags. */
function refLines(repo: Repo): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  const out: RefLine[] = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetObject = repo.objects.get(target);
        if (targetObject) entry.peeled = target;
      }
    }
    out.push(entry);
  }
  return out;
}

function uploadCaps(): string {
  return `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
}

function receiveCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** The v0 advertisement body for a service, with the `# service=` preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps() : receiveCaps();
  const refs = refLines(repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`];
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    // HEAD first, carrying the capabilities; then every ref, peeled tags after their tag.
    const headOid = headTip ?? refs.find((r) => r.name.startsWith('refs/heads/'))?.oid ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The protocol v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, req: GitRequest): GitResponse {
  const match = /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/.exec(req.path);
  if (!match) return err(404, 'Not Found');
  const [, owner, repoName] = match;
  const service = req.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return err(400, 'unknown service');
  const repo = store.getRepo(owner!, repoName!);
  if (!repo) return err(404, 'Not Found');
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, service));
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
  return ok('application/x-git-upload-pack-advertisement', v0Advertisement(repo, service));
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** The objects to send for a fetch: reachable from wants (depth-limited), minus what the client holds. */
function fetchPlan(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string) => repo.objects.get(oid);
  // What the client already holds: the closure of haves, stopping at its shallow boundaries.
  const held = new Set<string>();
  const shallowSet = new Set(args.shallow);
  const heldQueue = [...args.haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop()!;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      heldQueue.push(commit.tree);
      if (!shallowSet.has(oid)) for (const parent of commit.parents) heldQueue.push(parent);
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') heldQueue.push(entry.oid);
    }
  }

  // What the fetch covers: commits within `depth` generations of the wants, plus their trees.
  const wanted = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = args.wants.filter(isOid).map((oid) => ({ oid, depth: 0 }));
  const newShallow: string[] = [];
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (wanted.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    wanted.add(oid);
    commitDepth.set(oid, depth);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      wanted.add(commit.tree);
      // Walk the tree's entries.
      const treeQueue = [commit.tree];
      while (treeQueue.length) {
        const treeOid = treeQueue.pop()!;
        const treeObject = lookup(treeOid);
        if (!treeObject || treeObject.type !== 'tree') continue;
        for (const entry of parseTree(treeObject.data)) {
          if (entry.mode === '160000') continue;
          if (!wanted.has(entry.oid)) {
            wanted.add(entry.oid);
            if (lookup(entry.oid)?.type === 'tree') treeQueue.push(entry.oid);
          }
        }
      }
      if (args.depth === null || depth + 1 < args.depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push({ oid: entry.oid, depth });
    }
  }
  // New shallow boundary: an included commit whose parent was cut off by depth.
  if (args.depth !== null) {
    for (const [oid, depth] of commitDepth) {
      if (depth + 1 !== args.depth) continue;
      const object = lookup(oid);
      if (object?.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) newShallow.push(oid);
    }
  }
  // Unshallow: an old boundary now fully included (all of its parents are in the wanted set).
  const unshallow: string[] = [];
  for (const boundary of args.shallow) {
    if (!wanted.has(boundary)) continue;
    const object = lookup(boundary);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => wanted.has(parent))) unshallow.push(boundary);
  }

  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: newShallow, unshallow };
}

/** Split a pack into sideband pkt-lines (band 1), each at most 65516 payload bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = fetchPlan(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktDelim());
  if (args.depth !== null || plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = fetchPlan(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseV2Args(packets: GitPacket[]): { command: string; args: FetchArgs; prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean } {
  let command = '';
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
  }
  return { command, args, prefixes, peel, symrefs, unborn };
}

function v2LsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const refs = refLines(repo);
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (refs.length === 0) {
    if (keep('HEAD') && (unborn || prefixes.length === 0)) {
      const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
      lines.push(`unborn HEAD${attrs}\n`);
    }
  } else {
    const headOid = headTip ?? refs.find((r) => r.name.startsWith('refs/heads/'))?.oid ?? ZERO_OID;
    if (keep('HEAD')) {
      const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
      lines.push(`${headOid} HEAD${attrs}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      const attrs = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
      lines.push(`${ref.oid} ${ref.name}${attrs}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, req: GitRequest): GitResponse {
  const match = /^\/([^/]+)\/([^/]+)\.git\/git-upload-pack$/.exec(req.path);
  if (!match) return err(404, 'Not Found');
  const [, owner, repoName] = match;
  const repo = store.getRepo(owner!, repoName!);
  if (!repo) return err(404, 'Not Found');
  let packets: GitPacket[];
  try {
    packets = decodePktLines(req.body);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'malformed pkt-line stream');
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    const { command, args, prefixes, peel, symrefs, unborn } = parseV2Args(packets);
    if (command === 'ls-refs') {
      return ok('application/x-git-upload-pack-result', v2LsRefsResponse(repo, prefixes, peel, symrefs, unborn));
    }
    if (command === 'fetch') {
      return ok('application/x-git-upload-pack-result', v2FetchResponse(repo, args));
    }
    return err(400, `unknown v2 command ${command}`);
  }
  // Protocol v0: want/have/done/deepen/shallow lines in two sections.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (verb === 'want') args.wants.push(rest.split(' ')[0]!);
    else if (verb === 'have') args.haves.push(rest.trim());
    else if (verb === 'shallow') args.shallow.push(rest.trim());
    else if (verb === 'deepen') args.depth = Number.parseInt(rest.trim(), 10);
    else if (verb === 'done') args.done = true;
  }
  if (args.wants.length === 0) return err(400, 'no want lines in upload-pack request');
  return ok('application/x-git-upload-pack-result', v0FetchResponse(repo, args));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, req: GitRequest): GitResponse {
  const match = /^\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/.exec(req.path);
  if (!match) return err(404, 'Not Found');
  const [, owner, repoName] = match;
  const repo = store.getRepo(owner!, repoName!);
  if (!repo) return err(404, 'Not Found');
  // The request is a pkt-line command list terminated by a flush packet,
  // followed directly by the raw pack bytes. Only the command section is
  // pkt-framed: the pack starts with "PACK" and must never be parsed as
  // pkt-lines, so walk the frame by hand and stop at the flush.
  const commands: PushCommand[] = [];
  let offset = 0;
  let malformed = false;
  while (offset + 4 <= req.body.length) {
    const header = req.body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      malformed = true;
      break;
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > req.body.length) {
      malformed = true;
      break;
    }
    const payload = req.body.subarray(offset + 4, offset + length);
    const line = payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    offset += length;
  }
  if (malformed) return err(400, 'malformed pkt-line stream');
  const packBytes = req.body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      if (!verifyPackChecksum(packBytes)) throw new Error('pack trailer checksum mismatch');
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  if (unpackOk) {
    for (const command of commands) {
      const result = applyPushCommand(repo, command);
      reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }
  const report = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let at = 0; at < report.length; at += CHUNK) {
    const slice = report.subarray(at, Math.min(report.length, at + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush());
  return ok('application/x-git-receive-pack-result', Buffer.concat(parts));
}

function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  const isDelete = command.newOid === ZERO_OID;
  const isCreate = command.oldOid === ZERO_OID;
  if (isDelete) {
    if (current === undefined) return { ok: false, reason: 'failed to update ref' };
    if (current !== command.oldOid) return { ok: false, reason: 'failed to update ref' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  // The new object must exist (a tag, a commit, or anything the pack carried).
  if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'failed to update ref' };
  if (isCreate) {
    if (current !== undefined) return { ok: false, reason: 'failed to update ref' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update: the old value must match, and the new tip must descend from it.
  if (current === undefined) return { ok: false, reason: 'failed to update ref' };
  if (current !== command.oldOid) return { ok: false, reason: 'failed to update ref' };
  if (command.ref.startsWith('refs/tags/')) return { ok: false, reason: 'cannot update tag' };
  const lookup = (oid: string) => repo.objects.get(oid);
  // Fast-forward: old must be an ancestor of new (walk parents of the new tip).
  if (!isAncestorFast(repo, command.oldOid, command.newOid, lookup)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

/** Ancestor walk that also accepts a tag object pointing at the ancestor commit. */
function isAncestorFast(repo: Repo, ancestor: string, descendant: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}
