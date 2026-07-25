import { afterEach, describe, expect, it } from 'vitest';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { dir, file, fixture, symlink, worktree, type Fixture } from './fixture.js';

const created: Fixture[] = [];

/** Build a fixture and guarantee it is torn down even when an assertion fails. */
async function make(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  created.push(f);
  return f;
}

afterEach(async () => {
  while (created.length > 0) {
    const f = created.pop();
    if (f) await f.cleanup();
  }
});

describe('fixture()', () => {
  it('creates a file with exact content from a bare string value', async () => {
    const f = await make({ 'README.md': 'hello world' });

    const content = await readFile(f.path('README.md'), 'utf8');
    expect(content).toBe('hello world');

    const st = await lstat(f.path('README.md'));
    expect(st.isFile()).toBe(true);
  });

  it('creates parent directories for nested keys', async () => {
    const f = await make({ 'a/b/c/deep.txt': 'x' });

    expect(await readFile(f.path('a/b/c/deep.txt'), 'utf8')).toBe('x');
    expect((await lstat(f.path('a/b'))).isDirectory()).toBe(true);
  });

  it('creates a file of an exact byte size via file(content, { size })', async () => {
    const f = await make({
      'big.bin': file('x', { size: 4096 }),
      'empty.txt': file(),
    });

    expect((await stat(f.path('big.bin'))).size).toBe(4096);
    expect((await stat(f.path('empty.txt'))).size).toBe(0);
  });

  it('applies an explicit mtime to a file', async () => {
    const when = Date.UTC(2020, 0, 2, 3, 4, 5);
    const f = await make({ 'old.txt': file('stale', { mtime: when }) });

    const st = await stat(f.path('old.txt'));
    expect(Math.round(st.mtimeMs)).toBe(when);
  });

  it('creates an empty directory via dir()', async () => {
    const f = await make({ 'target': dir() });

    const st = await lstat(f.path('target'));
    expect(st.isDirectory()).toBe(true);
    expect(await readdir(f.path('target'))).toEqual([]);
  });

  it('creates a real symlink that lstat reports as a symlink', async () => {
    const home = os.homedir();
    const f = await make({ 'link-to-home': symlink(home) });

    const st = await lstat(f.path('link-to-home'));
    expect(st.isSymbolicLink()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(await readlink(f.path('link-to-home'))).toBe(home);
  });

  it('creates a worktree whose .git is a FILE containing "gitdir: ..."', async () => {
    const gitdir = '/somewhere/main-repo/.git/worktrees/build';
    const f = await make({ 'repo/build': worktree(gitdir) });

    const dotGit = f.path('repo/build/.git');
    const st = await lstat(dotGit);
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);

    const content = await readFile(dotGit, 'utf8');
    expect(content).toBe(`gitdir: ${gitdir}\n`);
  });

  it('accepts a key that already names the .git file itself', async () => {
    const gitdir = '/main/.git/worktrees/target';
    const f = await make({ 'repo/target/.git': worktree(gitdir) });

    const st = await lstat(f.path('repo/target/.git'));
    expect(st.isFile()).toBe(true);
    expect(await readFile(f.path('repo/target/.git'), 'utf8')).toBe(`gitdir: ${gitdir}\n`);
  });

  it('throws on an unrecognised entry kind rather than silently creating nothing', async () => {
    await expect(
      fixture({ 'weird': { kind: 'wormhole' } as unknown as ReturnType<typeof dir> }),
    ).rejects.toThrow(/wormhole/);

    await expect(
      fixture({ 'weird': { nope: true } as unknown as ReturnType<typeof dir> }),
    ).rejects.toThrow();

    await expect(
      fixture({ 'weird': 42 as unknown as ReturnType<typeof dir> }),
    ).rejects.toThrow();
  });

  it('exposes a root that is its own realpath', async () => {
    const f = await make({ 'a.txt': 'a' });

    expect(f.root).toBe(await realpath(f.root));
    expect(path.isAbsolute(f.root)).toBe(true);
    // On macOS os.tmpdir() is /var/... which is itself a symlink to /private/var.
    expect(f.root.startsWith('/var/')).toBe(false);
  });

  it('resolves path(...segments) against the root', async () => {
    const f = await make({ 'a/b.txt': 'b' });

    expect(f.path('a', 'b.txt')).toBe(path.join(f.root, 'a', 'b.txt'));
    expect(f.path()).toBe(f.root);
  });

  it('cleanup() removes the whole tree, including symlinks, and is idempotent', async () => {
    const f = await fixture({
      'proj/node_modules/pkg/index.js': 'module.exports = 1;',
      'proj/link': symlink(os.homedir()),
    });
    const root = f.root;

    await f.cleanup();
    await expect(stat(root)).rejects.toThrow();
    // Second cleanup must not throw.
    await f.cleanup();
    // The symlink target must survive.
    expect((await stat(os.homedir())).isDirectory()).toBe(true);
  });
});
