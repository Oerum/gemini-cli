/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo, useCallback, useEffect } from 'react';
import { Box, Text, useStdin } from 'ink';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  type Config,
  type EditorType,
  getEditorCommand,
  isGuiEditor,
  coreEvents,
  CoreEvent,
  DriveManager,
} from '@google/gemini-cli-core';

export interface MdsBrowserProps {
  config: Config;
  onClose: () => void;
}

interface FileEntry {
  path: string;
  type: string;
  id?: string; // used for drive files
}

export const MdsBrowser: React.FC<MdsBrowserProps> = ({ config, onClose }) => {
  const { merged: settings } = useSettings();
  const { rows: terminalHeight } = useTerminalSize();
  const { setRawMode } = useStdin();

  const [activeIndex, setActiveIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'local' | 'drive'>('local');
  const [driveFiles, setDriveFiles] = useState<FileEntry[]>([]);
  const [isDriveLoading, setIsDriveLoading] = useState(false);

  const localFiles = useMemo<FileEntry[]>(() => {
    const memoryFiles = config.getGeminiMdFilePaths() || [];
    const agentPaths = new Set<string>();

    const definitions = config.getAgentRegistry()?.getAllDefinitions() || [];
    for (const definition of definitions) {
      if (definition.metadata?.filePath) {
        agentPaths.add(definition.metadata.filePath);
      }
    }

    const allPaths = new Set([...memoryFiles, ...agentPaths]);

    return Array.from(allPaths)
      .map((p) => {
        const lower = p.toLowerCase();
        let type = 'Unknown';

        if (
          agentPaths.has(p) ||
          lower.endsWith('agents.md') ||
          lower.endsWith('.agents')
        ) {
          type = 'Agent';
        } else {
          type = 'Memory';
        }
        return { path: p, type };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        return a.path.localeCompare(b.path);
      });
  }, [config]);

  useEffect(() => {
    if (viewMode === 'drive' && driveFiles.length === 0 && !isDriveLoading) {
      setIsDriveLoading(true);
      const manager = new DriveManager(config);
      manager
        .listFiles()
        .then((f: Array<{ id: string; name: string }>) => {
          setDriveFiles(
            f.map((item) => ({ path: item.name, type: 'Drive', id: item.id })),
          );
        })
        .catch((e: Error) =>
          coreEvents.emitFeedback(
            'error',
            `[MdsBrowser] Failed to list Drive files: ${e.message}`,
          ),
        )
        .finally(() => setIsDriveLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, config]);

  const files = viewMode === 'local' ? localFiles : driveFiles;

  const openFileInEditor = useCallback(
    async (filePath: string) => {
      let command: string | undefined = undefined;
      const args = [filePath];

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const preferredEditorType = settings.general.preferredEditor as
        | EditorType
        | undefined;
      if (!command && preferredEditorType) {
        command = getEditorCommand(preferredEditorType);
        if (isGuiEditor(preferredEditorType)) {
          args.unshift('--wait');
        }
      }

      if (!command) {
        command =
          process.env['VISUAL'] ??
          process.env['EDITOR'] ??
          (process.platform === 'win32' ? 'notepad' : 'vi');
      }

      try {
        setRawMode?.(false);
        const { status, error } = spawnSync(command, args, {
          stdio: 'inherit',
        });
        if (error) throw error;
        if (typeof status === 'number' && status !== 0 && status !== null) {
          throw new Error(`External editor exited with status ${status}`);
        }
      } catch (err) {
        coreEvents.emitFeedback(
          'error',
          '[MdsBrowser] external editor error',
          err,
        );
      } finally {
        setRawMode?.(true);
        coreEvents.emit(CoreEvent.ExternalEditorClosed);
      }
    },
    [settings.general.preferredEditor, setRawMode],
  );

  const openFolder = useCallback((filePath: string) => {
    const folderPath = dirname(filePath);
    let command = '';
    const args = [folderPath];

    if (process.platform === 'win32') {
      command = 'explorer';
    } else if (process.platform === 'darwin') {
      command = 'open';
    } else {
      command = 'xdg-open';
    }

    try {
      spawnSync(command, args, { stdio: 'ignore' });
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        '[MdsBrowser] error opening folder',
        error,
      );
    }
  }, []);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return true;
      }

      if (key.name === 'return' || key.name === 'enter') {
        const activeFile = files[activeIndex];
        if (viewMode === 'drive' && activeFile?.id) {
          // Download and close
          coreEvents.emitFeedback('info', `Downloading ${activeFile.path}...`);
          const manager = new DriveManager(config);
          manager
            .downloadFile(activeFile.id, activeFile.path)
            .then((p: string) =>
              coreEvents.emitFeedback('info', `File downloaded to: ${p}`),
            )
            .catch((e: Error) =>
              coreEvents.emitFeedback('error', `Download failed: ${e.message}`),
            )
            .finally(() => onClose());
          return true;
        }
        onClose();
        return true;
      }

      if (keyMatchers[Command.SAVE_TO_DRIVE](key)) {
        if (viewMode === 'local') {
          const activeFile = files[activeIndex];
          if (activeFile) {
            const manager = new DriveManager(config);
            coreEvents.emitFeedback(
              'info',
              `Saving ${activeFile.path} to Drive...`,
            );
            manager
              .uploadFile(activeFile.path)
              .then(() =>
                coreEvents.emitFeedback(
                  'info',
                  `Successfully uploaded ${activeFile.path} to Drive.`,
                ),
              )
              .catch((e) =>
                coreEvents.emitFeedback(
                  'error',
                  `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
                ),
              );
          }
        }
        return true;
      }

      if (keyMatchers[Command.IMPORT_FROM_DRIVE](key)) {
        setViewMode((prev) => (prev === 'local' ? 'drive' : 'local'));
        setActiveIndex(0);
        return true;
      }

      if (
        keyMatchers[Command.MOVE_DOWN](key) ||
        keyMatchers[Command.HISTORY_DOWN](key)
      ) {
        setActiveIndex((prev) =>
          Math.min(prev + 1, Math.max(0, files.length - 1)),
        );
        return true;
      }
      if (
        keyMatchers[Command.MOVE_UP](key) ||
        keyMatchers[Command.HISTORY_UP](key)
      ) {
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return true;
      }
      if (keyMatchers[Command.OPEN_EXTERNAL_EDITOR](key)) {
        if (viewMode === 'local') {
          const activeFile = files[activeIndex];
          if (activeFile) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            openFileInEditor(activeFile.path);
          }
        }
        return true;
      }
      if (keyMatchers[Command.OPEN_FILE_LOCATION](key)) {
        if (viewMode === 'local') {
          const activeFile = files[activeIndex];
          if (activeFile) {
            openFolder(activeFile.path);
          }
        }
        return true;
      }
      return true;
    },
    { isActive: true, priority: true },
  );

  const availableHeight = Math.max(5, terminalHeight - 10);
  const startIdx = Math.max(
    0,
    Math.min(
      activeIndex - Math.floor(availableHeight / 2),
      files.length - availableHeight,
    ),
  );
  const endIdx = startIdx + availableHeight;
  const visibleFiles = files.slice(startIdx, endIdx);

  if (viewMode === 'drive' && isDriveLoading) {
    return (
      <Box flexDirection="column" paddingX={1} marginY={1}>
        <Text color={Colors.AccentPurple}>Drive Files</Text>
        <Text color={Colors.Gray}>Loading files from Google Drive...</Text>
      </Box>
    );
  }

  if (files.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} marginY={1}>
        <Text color={Colors.AccentPurple}>
          {viewMode === 'local'
            ? 'Local Markdown Files'
            : 'Drive Markdown Files'}
        </Text>
        <Text color={Colors.Gray}>No files found.</Text>
        <Text color={Colors.Gray}>
          Press Esc to close{' '}
          {viewMode === 'local' ? '│ Alt+i: List Drive' : '│ Alt+i: List Local'}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={Colors.AccentPurple}>
          {viewMode === 'local' ? 'Local' : 'Drive'} Markdown Files (
          {files.length} total)
        </Text>
      </Box>
      <Box flexDirection="column" marginY={1}>
        {visibleFiles.map((file, idx) => {
          const absoluteIndex = startIdx + idx;
          const isActive = absoluteIndex === activeIndex;
          const prefix = isActive ? '❯ ' : '  ';
          const color = isActive ? Colors.AccentPurple : Colors.Foreground;

          return (
            <Box key={`${file.path}-${idx}`} flexDirection="row">
              <Box width={10} flexShrink={0} alignItems="flex-end">
                <Text color={color}>
                  {prefix}
                  {file.type}
                </Text>
              </Box>
              <Box marginX={1}>
                <Text color={Colors.Gray}>│</Text>
              </Box>
              <Box flexGrow={1} overflow="hidden">
                <Text
                  color={isActive ? color : Colors.Comment}
                  dimColor={!isActive}
                  wrap="truncate-middle"
                >
                  {file.path}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column">
        {viewMode === 'local' ? (
          <Text color={Colors.Gray}>
            ↑/↓: Navigate │ Enter/Esc: Close │ Ctrl+x: Open File │ Alt+o: Open
            Folder
          </Text>
        ) : (
          <Text color={Colors.Gray}>
            ↑/↓: Navigate │ Enter/Esc: Close │ Enter: Download File
          </Text>
        )}
        <Text color={Colors.Gray}>
          {viewMode === 'local'
            ? 'Alt+u: Upload to Drive │ Alt+i: List Drive'
            : 'Alt+i: List Local'}
        </Text>
      </Box>
    </Box>
  );
};
