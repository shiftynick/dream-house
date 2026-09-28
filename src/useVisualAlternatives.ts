import { useCallback, useRef, useState } from 'react';
import type { AlternativeResult, VisualAlternative } from '../shared/alternatives';
import type { AgentContext } from '../shared/harness';
import type { Project } from '../shared/model';
import { api, ApiError } from './api';

export function useVisualAlternatives(options: {
  flush: () => Promise<Project | null>;
  acceptPersisted: (project: Project) => void;
  context: AgentContext;
  renderClientId: string | null;
  onBusy: (value: boolean) => void;
  onCommitted: () => void;
  onConflict: () => void;
}) {
  const [choices, setChoices] = useState<AlternativeResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'generating' | 'choosing' | null>(null);
  const [preview, setPreview] = useState<VisualAlternative | null>(null);
  const [preference, setPreference] = useState('');
  const controller = useRef<AbortController | null>(null);
  const acting = useRef(false);
  const clear = useCallback(() => {
    setChoices(null);
    setError('');
    setPreview(null);
    setPreference('');
  }, []);
  const generate = async (prompt: string, count: 2 | 3) => {
    if (acting.current || !prompt.trim() || !options.renderClientId) return;
    acting.current = true;
    controller.current = new AbortController();
    setBusy('generating');
    options.onBusy(true);
    setError('');
    setPreview(null);
    try {
      const project = await options.flush();
      if (!project?.projectId) throw new Error('Reload this house before generating alternatives.');
      const result = await api<AlternativeResult>('alternatives/generate', {
        method: 'POST',
        signal: controller.current.signal,
        body: JSON.stringify({
          projectId: project.projectId,
          baseRevision: project.revision,
          prompt: prompt.trim(),
          count,
          renderClientId: options.renderClientId,
          context: options.context,
        }),
      });
      setChoices(result);
      setPreference('');
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'revision_conflict') options.onConflict();
      setError(
        controller.current?.signal.aborted
          ? 'Generation cancelled. Your saved house is unchanged.'
          : (failure as Error).message,
      );
    } finally {
      controller.current = null;
      acting.current = false;
      setBusy(null);
      options.onBusy(false);
    }
  };
  const choose = async (optionId: string, preferenceText: string) => {
    if (acting.current || !choices) return;
    acting.current = true;
    setBusy('choosing');
    options.onBusy(true);
    setError('');
    try {
      const project = await options.flush();
      if (!project || project.projectId !== choices.projectId)
        throw new Error(
          'These alternatives belong to a different house. Generate new choices for this house.',
        );
      const result = await api<{ project: Project }>('alternatives/choose', {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.projectId,
          expectedRevision: project.revision,
          choiceSetId: choices.choiceSetId,
          optionId,
          ...(preferenceText.trim() ? { preferenceText: preferenceText.trim() } : {}),
        }),
      });
      options.acceptPersisted(result.project);
      clear();
      options.onCommitted();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'stale_alternatives') {
        // The current project is safely saved; only these old proposals expired.
        // Do not put a healthy project into the cross-tab save-conflict state.
        setChoices(null);
        setPreview(null);
        setPreference('');
      }
      if (failure instanceof ApiError && failure.code === 'revision_conflict') options.onConflict();
      setError((failure as Error).message);
    } finally {
      acting.current = false;
      setBusy(null);
      options.onBusy(false);
    }
  };
  return {
    choices,
    error,
    busy,
    preview,
    setPreview,
    preference,
    setPreference,
    clear,
    generate,
    choose,
    cancel: () => controller.current?.abort(),
  };
}
