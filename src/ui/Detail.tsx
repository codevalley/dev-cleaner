/**
 * The right pane: everything known about the highlighted row.
 *
 * This is where worktree status lives. The spec is precise about its role — "Worktree
 * status (registered, clean, merged) is still computed and shown in the detail pane as
 * context for the user's decision. It informs; it never gates deletion" — so it appears
 * here, next to the branch and the last commit, and nowhere near a selection default.
 *
 * The pane never renders a selection glyph. Both panes share the physical lines of the
 * frame, and a marker on the right would be indistinguishable from one on the left.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { BYTES_WIDTH, formatBytes, formatBytesPadded, formatDate, formatIdle, padLabel } from './format.js';
import { enabledArtifacts, type Row } from './model.js';
import type { Category, Project } from '../types.js';

export interface DetailProps {
  row: Row | undefined;
  categories: ReadonlySet<Category>;
  width: number;
}

function ProjectDetail({
  project,
  categories,
  width,
}: {
  project: Project;
  categories: ReadonlySet<Category>;
  width: number;
}): React.ReactElement {
  const artifacts = enabledArtifacts(project, categories);
  const total = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  const labelWidth = Math.max(10, width - BYTES_WIDTH - 3);
  const { git, activity } = project;

  return (
    <Box flexDirection="column">
      <Text bold>{padLabel(project.name, width)}</Text>
      <Text dimColor>
        {padLabel(
          `${[...project.types].join(' · ')} · ${activity.status} ${formatIdle(activity.idleMs)}`,
          width,
        )}
      </Text>
      <Text> </Text>

      {artifacts.map((artifact) => (
        <Text key={artifact.path}>
          {`  ${padLabel(artifact.relPath, labelWidth)} ${formatBytesPadded(artifact.bytes)}`}
        </Text>
      ))}
      <Text>{`  ${padLabel('total', labelWidth)} ${formatBytesPadded(total)}`}</Text>
      <Text> </Text>

      {git === undefined ? (
        <Text dimColor>{padLabel('  not a git repository', width)}</Text>
      ) : (
        <>
          <Text>{padLabel(`  branch: ${git.branch}`, width)}</Text>
          <Text>{padLabel(`  last commit: ${formatDate(git.lastCommitMs)}`, width)}</Text>
          <Text>{padLabel(`  uncommitted: ${git.hasUncommittedChanges ? 'yes' : 'no'}`, width)}</Text>
          {git.worktree === undefined ? null : (
            <>
              <Text>{padLabel(`  worktree of: ${git.worktree.mainRepo}`, width)}</Text>
              <Text>
                {padLabel(
                  `  ${git.worktree.isMerged ? 'merged' : 'unmerged'}, ${
                    git.worktree.isClean ? 'clean' : 'dirty'
                  }`,
                  width,
                )}
              </Text>
            </>
          )}
        </>
      )}
      <Text> </Text>
      <Text dimColor>{padLabel(`  ${activity.reason}`, width)}</Text>
    </Box>
  );
}

export function Detail({ row, categories, width }: DetailProps): React.ReactElement {
  if (row === undefined || row.kind === 'header') {
    return (
      <Box flexDirection="column">
        <Text dimColor>{padLabel('nothing highlighted', width)}</Text>
      </Box>
    );
  }

  if (row.kind === 'project') {
    return <ProjectDetail project={row.project} categories={categories} width={width} />;
  }

  const { cache } = row;
  return (
    <Box flexDirection="column">
      <Text bold>{padLabel(cache.label, width)}</Text>
      <Text dimColor>{padLabel(`global cache · ${formatBytes(cache.bytes)}`, width)}</Text>
      <Text> </Text>
      <Text>{padLabel(`  ${cache.path}`, width)}</Text>
      <Text> </Text>
      <Text dimColor>{padLabel(`  ${cache.note}`, width)}</Text>
    </Box>
  );
}
