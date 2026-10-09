import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { VoiceSession, type VoiceState } from './voiceSession';

export function useVoice({
  onText,
  onError,
  enabled,
  busy,
  scopeKey,
}: {
  onText: (text: string) => void;
  onError: (text: string) => void;
  enabled: boolean;
  busy: boolean;
  scopeKey?: string;
}) {
  const [state, setState] = useState<VoiceState>('idle');
  const callbacks = useRef({ onText, onError, enabled, busy, scopeKey });
  callbacks.current = { onText, onError, enabled, busy, scopeKey };
  const session = useRef<VoiceSession | null>(null);
  if (!session.current)
    session.current = new VoiceSession({
      context: () => callbacks.current,
      supported: () => !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder,
      microphone: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        }),
      recorder: (stream) => {
        const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
          MediaRecorder.isTypeSupported(type),
        );
        return new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      },
      transcribe: (blob, signal) =>
        api<{ text: string }>('transcribe', {
          method: 'POST',
          body: blob,
          headers: { 'Content-Type': blob.type },
          signal,
        }),
      onState: setState,
      onText: (text) => callbacks.current.onText(text),
      onError: (message) => callbacks.current.onError(message),
    });
  const start = useCallback(() => session.current!.start(), []);
  const stop = useCallback(() => session.current!.stop(), []);
  const cancel = useCallback(() => session.current!.cancel(), []);
  useEffect(() => {
    session.current!.synchronize();
  }, [enabled, busy, scopeKey]);
  useEffect(() => {
    if (!enabled) return;
    const down = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.code !== 'Space' ||
        event.repeat ||
        (target instanceof Element &&
          target.closest('input,textarea,select,button,[contenteditable="true"]'))
      )
        return;
      event.preventDefault();
      void start();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
    };
  }, [enabled, start, stop]);
  useEffect(() => () => session.current!.cancel(false), []);
  return { state, start, stop, cancel };
}
