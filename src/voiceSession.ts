export type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing';
export type VoiceContext = { enabled: boolean; busy: boolean; scopeKey?: string };
type Session = {
  scopeKey?: string;
  phase: Exclude<VoiceState, 'idle'>;
  held: boolean;
  controller: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
  chunks: Blob[];
};
export type VoiceDependencies = {
  context: () => VoiceContext;
  supported: () => boolean;
  microphone: () => Promise<MediaStream>;
  recorder: (stream: MediaStream) => MediaRecorder;
  transcribe: (blob: Blob, signal: AbortSignal) => Promise<{ text: string }>;
  onState: (state: VoiceState) => void;
  onText: (text: string) => void;
  onError: (message: string) => void;
};

/** A recording and its transcript belong to the project that started it.
 * All late browser/provider callbacks must still own the active session.
 */
export class VoiceSession {
  private current: Session | null = null;
  constructor(private dependencies: VoiceDependencies) {}

  private allowed(session: Session) {
    const context = this.dependencies.context();
    return (
      this.current === session &&
      context.scopeKey === session.scopeKey &&
      context.enabled &&
      !context.busy &&
      !session.controller.signal.aborted
    );
  }

  private releaseCapture(session: Session) {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
    if (session.recorder) {
      session.recorder.ondataavailable = null;
      session.recorder.onstop = null;
      session.recorder.onerror = null;
      try {
        if (session.recorder.state !== 'inactive') session.recorder.stop();
      } catch {
        /* A device may already have ended the capture. */
      }
      session.recorder = undefined;
    }
    session.stream?.getTracks().forEach((track) => track.stop());
    session.stream = undefined;
  }

  cancel(notify = true) {
    const session = this.current;
    if (!session) return;
    this.current = null;
    session.held = false;
    session.controller.abort();
    this.releaseCapture(session);
    if (notify) this.dependencies.onState('idle');
  }

  synchronize() {
    if (this.current && !this.allowed(this.current)) this.cancel();
  }

  private fail(session: Session, message: string) {
    if (this.current !== session) return;
    const report = this.allowed(session);
    this.cancel();
    if (report) this.dependencies.onError(message);
  }

  /** Normal push-to-talk release: finish the recording and transcribe it. */
  stop() {
    const session = this.current;
    if (!session) return;
    session.held = false;
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
    if (!this.allowed(session) || session.phase === 'requesting') {
      this.cancel();
      return;
    }
    try {
      if (session.recorder?.state === 'recording') session.recorder.stop();
    } catch {
      this.fail(session, 'The microphone stopped unexpectedly. Please try again.');
    }
  }

  async start() {
    const context = this.dependencies.context();
    if (context.busy || this.current) return;
    if (!context.enabled) {
      this.dependencies.onError(
        'Add a Vercel AI Gateway key in Connections to enable the microphone. You can type in the meantime.',
      );
      return;
    }
    if (!this.dependencies.supported()) {
      this.dependencies.onError(
        'Audio recording is unavailable. Open the app at localhost in a browser with microphone support.',
      );
      return;
    }
    const session: Session = {
      scopeKey: context.scopeKey,
      phase: 'requesting',
      held: true,
      controller: new AbortController(),
      chunks: [],
    };
    this.current = session;
    this.dependencies.onState('requesting');
    try {
      const stream = await this.dependencies.microphone();
      if (!this.allowed(session) || !session.held) {
        stream.getTracks().forEach((track) => track.stop());
        if (this.current === session) this.cancel();
        return;
      }
      session.stream = stream;
      const recorder = this.dependencies.recorder(stream);
      session.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (this.allowed(session) && event.data.size) session.chunks.push(event.data);
      };
      recorder.onstop = () => {
        void this.finish(session, recorder.mimeType);
      };
      recorder.onerror = () =>
        this.fail(session, 'The microphone stopped unexpectedly. Please try again.');
      recorder.start();
      if (!this.allowed(session)) return;
      session.phase = 'recording';
      this.dependencies.onState('recording');
      session.timer = setTimeout(() => {
        if (this.current === session) this.stop();
      }, 60_000);
    } catch (error) {
      this.fail(
        session,
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow it in your browser, or type your description.'
          : 'Could not start your microphone. Check that it is connected and available.',
      );
    }
  }

  private async finish(session: Session, mimeType: string) {
    if (!this.allowed(session)) {
      if (this.current === session) this.cancel();
      return;
    }
    this.releaseCapture(session);
    session.phase = 'transcribing';
    this.dependencies.onState('transcribing');
    try {
      const blob = new Blob(session.chunks, { type: mimeType });
      if (blob.size < 500)
        throw new Error('That was a little short. Hold the key while you speak.');
      const result = await this.dependencies.transcribe(blob, session.controller.signal);
      if (!this.allowed(session)) {
        if (this.current === session) this.cancel();
        return;
      }
      const text = result.text?.trim();
      this.cancel();
      if (text) this.dependencies.onText(text);
      else this.dependencies.onError('I didn’t catch any speech. Try again or type your idea.');
    } catch (error) {
      this.fail(session, error instanceof Error ? error.message : 'Could not transcribe audio.');
    }
  }
}
