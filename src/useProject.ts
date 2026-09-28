import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../shared/model';
import { api } from './api';
import { ProjectPersistence, type ProjectAction, type SaveState } from './projectPersistence';

export function useProject(onError: (message: string) => void) {
  const [project, updateView] = useState<Project | null>(null);
  const [saved, setSaved] = useState<SaveState>('saved');
  const [loadError, setLoadError] = useState('');
  const [generation, setGeneration] = useState(0);
  const projectRef = useRef<Project | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const persistenceRef = useRef<ProjectPersistence | null>(null);
  if (!persistenceRef.current) {
    persistenceRef.current = new ProjectPersistence(
      async (next) =>
        (await api<{ project: Project }>('project', { method: 'PUT', body: JSON.stringify(next) }))
          .project,
      (next, state) => {
        projectRef.current = next;
        updateView(next);
        setSaved(state);
      },
      (message) => onErrorRef.current(message),
    );
  }
  const persistence = persistenceRef.current;

  const acceptPersisted = useCallback(
    (incoming: Project) => {
      persistence.acceptPersisted(incoming);
      setLoadError('');
    },
    [persistence],
  );
  const setProject = useCallback(
    (action: ProjectAction) => {
      if (persistence.edit(action)) setGeneration((value) => value + 1);
    },
    [persistence],
  );
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    return persistence.flush();
  }, [persistence]);
  const markConflict = useCallback(() => persistence.markConflict(), [persistence]);

  useEffect(() => {
    let active = true;
    api<Project>('project')
      .then((value) => {
        if (active) acceptPersisted(value);
      })
      .catch((error: Error) => {
        if (active) setLoadError(error.message);
      });
    return () => {
      active = false;
    };
  }, [acceptPersisted]);

  useEffect(() => {
    if (!generation || persistence.state === 'conflict') return;
    timer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 350);
    return () => clearTimeout(timer.current);
  }, [generation, flush, persistence]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (persistence.unsaved) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [persistence]);

  return {
    project,
    projectRef,
    setProject,
    saved,
    loadError,
    flush,
    acceptPersisted,
    markConflict,
  };
}
