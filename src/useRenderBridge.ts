import { useCallback, useEffect, useRef, useState } from 'react';
import type { RenderCaptureResult, RenderJob } from '../shared/render';
import { api, ApiError } from './api';

/** Transport adapter between the local render broker and the browser renderer. */
export function useRenderBridge() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [state, setState] = useState<'connecting' | 'ready' | 'rendering' | 'unavailable'>(
    'connecting',
  );
  const clientRef = useRef<string | null>(null);
  const jobRef = useRef<RenderJob | null>(null);
  const submitting = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    let polling = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const release = (id: string) => {
      void fetch(`/api/render/clients/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => {});
    };
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      let retry = false;
      try {
        if (!clientRef.current) {
          const registered = await api<{ clientId: string }>('render/clients', {
            method: 'POST',
            signal: controller.signal,
          });
          if (!active) {
            release(registered.clientId);
            return;
          }
          clientRef.current = registered.clientId;
          setClientId(registered.clientId);
        }
        const result = await api<{ job: RenderJob | null }>(
          `render/jobs?clientId=${encodeURIComponent(clientRef.current!)}&wait=1${jobRef.current ? `&afterId=${encodeURIComponent(jobRef.current.id)}` : ''}`,
          { signal: controller.signal },
        );
        if (!active) return;
        if (result.job && result.job.id !== jobRef.current?.id) {
          jobRef.current = result.job;
          setJob(result.job);
        }
        if (!result.job && jobRef.current) {
          jobRef.current = null;
          setJob(null);
        }
        setState(jobRef.current ? 'rendering' : 'ready');
      } catch (error) {
        if (!active) return;
        retry = true;
        setState('unavailable');
        if (error instanceof ApiError && [404, 409, 410].includes(error.status)) {
          if (clientRef.current) release(clientRef.current);
          clientRef.current = null;
          setClientId(null);
          jobRef.current = null;
          setJob(null);
        }
      } finally {
        polling = false;
        if (active) {
          if (retry) retryTimer = setTimeout(() => void poll(), 1500);
          else void poll();
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(retryTimer);
      if (clientRef.current) release(clientRef.current);
      clientRef.current = null;
      jobRef.current = null;
    };
  }, []);

  const submit = useCallback(
    async (jobId: string | undefined, result?: RenderCaptureResult, error?: string) => {
      const currentJob = jobRef.current,
        currentClient = clientRef.current;
      if (
        !currentJob ||
        !currentClient ||
        currentJob.id !== jobId ||
        submitting.current === currentJob.id
      )
        return;
      submitting.current = currentJob.id;
      try {
        await api(`render/jobs/${encodeURIComponent(currentJob.id)}/result`, {
          method: 'POST',
          body: JSON.stringify({
            clientId: currentClient,
            ...(result
              ? { result }
              : { error: error || 'The local renderer could not capture this view.' }),
          }),
        });
      } catch (failure) {
        // Expired jobs are expected after cancellation. A malformed capture should fail
        // promptly rather than being picked up and rendered repeatedly until timeout.
        if (result && failure instanceof ApiError && [400, 409].includes(failure.status)) {
          await api(`render/jobs/${encodeURIComponent(currentJob.id)}/result`, {
            method: 'POST',
            body: JSON.stringify({
              clientId: currentClient,
              error: 'The local capture did not match the requested image, draft, or camera.',
            }),
          }).catch(() => {});
        }
      } finally {
        if (jobRef.current?.id === currentJob.id) {
          jobRef.current = null;
          setJob(null);
          setState(clientRef.current ? 'ready' : 'unavailable');
        }
        if (submitting.current === currentJob.id) submitting.current = null;
      }
    },
    [],
  );
  const complete = useCallback(
    (result: RenderCaptureResult) => {
      void submit(job?.id, result);
    },
    [submit, job?.id],
  );
  const fail = useCallback(
    (error: string) => {
      void submit(job?.id, undefined, error);
    },
    [submit, job?.id],
  );
  return { clientId, job, state, complete, fail };
}
