import { useCallback, useEffect, useState } from 'react';
import {
  isOpenDesignHostAvailable,
  pickAndImportHostProject,
  type OpenDesignHostProjectImportSuccess,
} from '@open-design/host';
import { pickLocalFolderPath } from '../state/projects';
import { resolvedWorkspaceContextForWrite } from '../state/projects';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import { fetchHostCapabilities, type HostCapabilities } from '../runtime/host-capabilities';
import { formatPickAndImportFailure } from '../utils/pickAndImportError';

interface UseOpenFolderImportArgs {
  skillId?: string | null;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
}

export function useOpenFolderImport({
  skillId,
  onImportFolder,
  onImportFolderResponse,
}: UseOpenFolderImportArgs) {
  const workspaceContextState = useWorkspaceContext();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchHostCapabilities().then((caps) => {
      if (!cancelled) setCapabilities(caps);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const hasHostPickAndImport = isOpenDesignHostAvailable();
  const available = hasHostPickAndImport ? Boolean(onImportFolderResponse) : Boolean(onImportFolder);
  // A daemon on another machine cannot open a dialog on the user's desktop, so
  // the caller renders a path field instead of a picker button.
  const manualEntry = !hasHostPickAndImport
    && Boolean(onImportFolder)
    && capabilities?.folderPicker === false;

  const importFolderPath = useCallback(async (rawPath: string) => {
    const path = rawPath.trim();
    if (!onImportFolder || !path) return;
    setError(null);
    setImporting(true);
    try {
      await onImportFolder(path);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to import folder',
      });
    } finally {
      setImporting(false);
    }
  }, [onImportFolder]);

  const openFolder = useCallback(async () => {
    if (hasHostPickAndImport) {
      if (!onImportFolderResponse) return;
      setError(null);
      setImporting(true);
      try {
        const result = await pickAndImportHostProject({
          skillId: skillId ?? null,
          workspaceContext: resolvedWorkspaceContextForWrite(workspaceContextState),
        });
        if (!result) return;
        if (result.ok === true) {
          await onImportFolderResponse(result);
          return;
        }
        if ('canceled' in result && result.canceled === true) return;
        setError(formatPickAndImportFailure(result));
      } catch (err) {
        setError({
          message: err instanceof Error ? err.message : 'Failed to import folder',
        });
      } finally {
        setImporting(false);
      }
      return;
    }

    if (!onImportFolder) return;
    setError(null);
    setImporting(true);
    try {
      const selectedPath = await pickLocalFolderPath();
      if (!selectedPath) return;
      await onImportFolder(selectedPath);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to import folder',
      });
    } finally {
      setImporting(false);
    }
  }, [
    hasHostPickAndImport,
    onImportFolder,
    onImportFolderResponse,
    skillId,
    workspaceContextState,
  ]);

  return {
    available,
    manualEntry,
    importFolderPath,
    clearError: () => setError(null),
    error,
    importing,
    openFolder,
  };
}
