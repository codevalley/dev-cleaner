/**
 * The one fixture helper.
 *
 * Filesystem behaviour is what most of dev-cleaner is *for*, so it is tested against a
 * real filesystem rather than a mock. `fixture()` builds a temporary tree from a
 * declarative spec and hands back its root plus a `cleanup()`.
 *
 * ```ts
 * const f = await fixture({
 *   'proj/package.json': '{}',                       // bare string -> file with content
 *   'proj/node_modules': dir(),                      // empty directory
 *   'proj/target/big.bin': file('x', { size: 1e6 }), // exact byte size
 *   'proj/link': symlink(os.homedir()),              // real symlink, never followed
 *   'proj/build': worktree('/repo/.git/worktrees/build'), // .git FILE, i.e. a worktree
 * });
 * ```
 *
 * `f.root` is its own realpath: on macOS `os.tmpdir()` is `/var/folders/...`, and `/var`
 * is a symlink to `/private/var`. Code under test resolves realpaths when guarding roots,
 * so an unresolved fixture root produces spurious mismatches that look like bugs in the
 * code rather than in the fixture.
 */

import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, symlink as fsSymlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface FileOptions {
  /** Pad or repeat `content` to exactly this many bytes. */
  size?: number;
  /** Modification time, as epoch milliseconds or a Date. */
  mtime?: number | Date;
}

export interface DirOptions {
  /** Modification time, as epoch milliseconds or a Date. Applied after children exist. */
  mtime?: number | Date;
}

export type FixtureEntry =
  | { kind: 'file'; content: string; size?: number; mtime?: number | Date }
  | { kind: 'dir'; mtime?: number | Date }
  | { kind: 'symlink'; target: string }
  | { kind: 'worktree'; gitdir: string };

/**
 * Keys are paths relative to the fixture root, using `/` separators. Missing parent
 * directories are created automatically. A bare string value is shorthand for
 * `file(value)`.
 */
export type FixtureSpec = Record<string, string | FixtureEntry>;

export interface Fixture {
  /** Absolute, and equal to its own realpath. */
  root: string;
  path(...segments: string[]): string;
  cleanup(): Promise<void>;
}

/** An empty directory. */
export function dir(options: DirOptions = {}): FixtureEntry {
  const entry: FixtureEntry = { kind: 'dir' };
  if (options.mtime !== undefined) entry.mtime = options.mtime;
  return entry;
}

/**
 * A regular file. With `size`, the content is repeated/truncated to exactly that many
 * bytes (an empty `content` is padded with `\0`), which is how sizing tests get a tree of
 * a known total.
 */
export function file(content = '', options: FileOptions = {}): FixtureEntry {
  const entry: FixtureEntry = { kind: 'file', content };
  if (options.size !== undefined) entry.size = options.size;
  if (options.mtime !== undefined) entry.mtime = options.mtime;
  return entry;
}

/**
 * A symbolic link. `target` is passed to `fs.symlink` verbatim, so an absolute target
 * points where it says and a relative one resolves against the link's own directory.
 * The target is never created — pointing at something outside the fixture (`$HOME`, `/`)
 * is the whole point of the safety tests.
 */
export function symlink(target: string): FixtureEntry {
  return { kind: 'symlink', target };
}

/**
 * A linked git worktree: a directory whose `.git` is a **file** containing
 * `gitdir: <gitdir>`. That file-vs-directory distinction is the entire detection
 * mechanism (spec: "Detection costs one `lstat`"), so fixtures must reproduce it exactly.
 *
 * The key may name either the worktree directory (`'repo/build'`, the usual form) or the
 * `.git` file itself (`'repo/build/.git'`); both produce the same tree.
 */
export function worktree(gitdir: string): FixtureEntry {
  return { kind: 'worktree', gitdir };
}

function toEntry(value: string | FixtureEntry, key: string): FixtureEntry {
  if (typeof value === 'string') return { kind: 'file', content: value };
  if (value === null || typeof value !== 'object') {
    throw new TypeError(
      `fixture: entry "${key}" must be a string or a fixture entry, got ${typeof value}`,
    );
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'file' && kind !== 'dir' && kind !== 'symlink' && kind !== 'worktree') {
    throw new TypeError(
      `fixture: entry "${key}" has unrecognised kind ${JSON.stringify(kind)}. ` +
        'Use a bare string, dir(), file(), symlink() or worktree().',
    );
  }
  return value as FixtureEntry;
}

function contentBuffer(content: string, size: number | undefined): Buffer {
  if (size === undefined) return Buffer.from(content, 'utf8');
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(`fixture: size must be a non-negative integer, got ${size}`);
  }
  // Buffer.alloc repeats the fill value to reach `size`, giving an exact byte count.
  return content.length > 0 ? Buffer.alloc(size, content, 'utf8') : Buffer.alloc(size);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fixture(spec: FixtureSpec): Promise<Fixture> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'dev-cleaner-'));
  // Resolve /var -> /private/var so the root equals its own realpath.
  const root = await realpath(created);

  const resolve = (...segments: string[]): string => path.join(root, ...segments);
  const self: Fixture = {
    root,
    path: resolve,
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };

  // Deferred so a directory's mtime is not clobbered by children written into it.
  const pendingTimes: Array<{ target: string; mtime: number | Date }> = [];

  try {
    for (const [key, value] of Object.entries(spec)) {
      const entry = toEntry(value, key);
      const target = resolve(key);

      switch (entry.kind) {
        case 'dir': {
          await mkdir(target, { recursive: true });
          if (entry.mtime !== undefined) pendingTimes.push({ target, mtime: entry.mtime });
          break;
        }
        case 'file': {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, contentBuffer(entry.content, entry.size));
          if (entry.mtime !== undefined) pendingTimes.push({ target, mtime: entry.mtime });
          break;
        }
        case 'symlink': {
          await mkdir(path.dirname(target), { recursive: true });
          await fsSymlink(entry.target, target);
          break;
        }
        case 'worktree': {
          const gitFile = path.basename(target) === '.git' ? target : path.join(target, '.git');
          await mkdir(path.dirname(gitFile), { recursive: true });
          await writeFile(gitFile, `gitdir: ${entry.gitdir}\n`, 'utf8');
          break;
        }
      }
    }

    // Deepest first, so setting a parent's time is not undone by a later child write.
    pendingTimes.sort((a, b) => b.target.length - a.target.length);
    for (const { target, mtime } of pendingTimes) {
      const when = mtime instanceof Date ? mtime : new Date(mtime);
      if (await pathExists(target)) await utimes(target, when, when);
    }
  } catch (error) {
    await self.cleanup();
    throw error;
  }

  return self;
}
