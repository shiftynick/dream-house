import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export function useVoice({
  onText,
  onError,
  enabled,
  busy,
}: {
  onText: (text: string) => void;
  onError: (text: string) => void;
  enabled: boolean;
  busy: boolean;
}) {
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
  const recorder = useRef<MediaRecorder | null>(null);
  const held = useRef(false);
  const active = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };
  const stop = useCallback(() => {
    held.current = false;
    if (timeout.current) clearTimeout(timeout.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);
  const start = useCallback(async () => {
    if (busy || active.current) return;
    if (!enabled) {
      callbacks.current.onError(
        'Add a Vercel AI Gateway key in Connections to enable the microphone. You can type in the meantime.',
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      callbacks.current.onError(
        'Audio recording is unavailable. Open the app at localhost in a browser with microphone support.',
      );
      return;
    }
    active.current = true;
    held.current = true;
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!held.current) {
        stream.getTracks().forEach((t) => t.stop());
        active.current = false;
        setState('idle');
        return;
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const capture = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      const chunks: Blob[] = [];
      capture.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      capture.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        setState('transcribing');
        try {
          const blob = new Blob(chunks, { type: capture.mimeType });
          if (blob.size < 500)
            throw new Error('That was a little short. Hold the key while you speak.');
          const result = await api<{ text: string }>('transcribe', {
            method: 'POST',
            body: blob,
            headers: { 'Content-Type': capture.mimeType },
          });
          if (result.text?.trim()) callbacks.current.onText(result.text.trim());
          else callbacks.current.onError('I didn’t catch any speech. Try again or type your idea.');
        } catch (error) {
          callbacks.current.onError(
            error instanceof Error ? error.message : 'Could not transcribe audio.',
          );
        } finally {
          active.current = false;
          setState('idle');
        }
      };
      capture.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        active.current = false;
        held.current = false;
        setState('idle');
        callbacks.current.onError('The microphone stopped unexpectedly. Please try again.');
      };
      capture.start();
      setState('recording');
      timeout.current = setTimeout(stop, 60000);
    } catch (error) {
      active.current = false;
      held.current = false;
      setState('idle');
      callbacks.current.onError(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow it in your browser, or type your description.'
          : 'Could not start your microphone. Check that it is connected and available.',
      );
    }
  }, [enabled, busy, stop]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.code !== 'Space' ||
        e.repeat ||
        target.closest('input,textarea,select,button,[contenteditable="true"]')
      )
        return;
      e.preventDefault();
      void start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
    };
  }, [start, stop]);
  useEffect(
    () => () => {
      held.current = false;
      if (timeout.current) clearTimeout(timeout.current);
      if (recorder.current) {
        recorder.current.onstop = null;
        recorder.current.stream.getTracks().forEach((t) => t.stop());
        if (recorder.current.state === 'recording') recorder.current.stop();
      }
    },
    [],
  );
  return { state, start, stop };
}
