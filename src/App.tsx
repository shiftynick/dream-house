import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Columns2,
  Compass,
  Cuboid,
  Eye,
  Footprints,
  GitBranch,
  House,
  Layers3,
  LoaderCircle,
  Maximize2,
  Mic,
  Moon,
  Plus,
  Redo2,
  ScanLine,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Sunset,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { api, ApiError, type Status } from './api';
import { useProject } from './useProject';
import Modal from './Modal';
import { OpeningControls, RoofControls } from './ArchitectureControls';
import ProjectChooser from './ProjectChooser';
import { useRenderBridge } from './useRenderBridge';
import RenderCapture from './RenderCapture';
import VisualAlternatives from './VisualAlternatives';
import { useVisualAlternatives } from './useVisualAlternatives';
import {
  selectionLabel,
  surfacePalette,
  validSelection,
  type DesignSelection,
} from '../shared/selection';
import { useVoice } from './useVoice';
import SceneView, { type CameraContext, type Light, type Quality, type View } from './SceneView';
import { DEFAULT_MODELS, DEFAULT_SPEECH_VOICE } from '../shared/connections';
import { hillsideHouse } from '../shared/examples';
import type { DraftCommitResult, HarnessResult, RunStatus } from '../shared/harness';
import {
  executeCommands,
  roomOpenings,
  validateDesign,
  type DesignCommand,
} from '../shared/design';
import {
  area,
  documentSchema,
  editProject,
  makeRoom,
  palettes,
  redo,
  undo,
  validateScene,
  type DesignRequirement,
  type Project,
  type Room,
  type Scene,
  type Side,
} from '../shared/model';

const uid = () => crypto.randomUUID();
type DesignResult = HarnessResult;
type RunProgress = Pick<RunStatus, 'message' | 'status'> & {
  stage: RunStatus['stage'] | 'saving' | 'committing';
  preview?: Scene | null;
};

const qualityNames: Record<Quality, string> = {
  live: 'Live',
  refined: 'Path traced',
  clay: 'Clay',
  wireframe: 'Wireframe',
};
function IconButton({
  children,
  label,
  onClick,
  disabled,
  active = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Connections({
  status,
  onSaved,
  onClose,
  onError,
}: {
  status: Status | null;
  onSaved: () => void;
  onClose: () => void;
  onError: (text: string) => void;
}) {
  const [gatewayKey, setGatewayKey] = useState(''),
    [model, setModel] = useState(status?.model || DEFAULT_MODELS.design),
    [speechModel, setSpeechModel] = useState(status?.speechModel || DEFAULT_MODELS.speech),
    [transcriptionModel, setTranscriptionModel] = useState(
      status?.transcriptionModel || DEFAULT_MODELS.transcription,
    ),
    [speechVoice, setSpeechVoice] = useState(status?.speechVoice || DEFAULT_SPEECH_VOICE),
    [limit, setLimit] = useState(status?.dailyLimit || 60),
    [saving, setSaving] = useState(false);
  const keyLabel =
    status?.keySource === 'saved'
      ? 'Saved key configured'
      : status?.keySource === 'environment'
        ? 'Environment key configured'
        : 'Key needed';
  return (
    <Modal title="Connections" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            await api('connections', {
              method: 'PUT',
              body: JSON.stringify({
                model,
                speechModel,
                transcriptionModel,
                speechVoice,
                dailyLimit: limit,
                ...(gatewayKey.trim() ? { gatewayKey: gatewayKey.trim() } : {}),
              }),
            });
            onSaved();
            onClose();
          } catch (error) {
            onError((error as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="connection-section">
          <span className="section-icon">
            <Sparkles size={19} />
          </span>
          <div>
            <h3>
              AI Gateway{' '}
              <span className={`pill ${status?.gatewayConnected ? 'green' : ''}`}>{keyLabel}</span>
            </h3>
            <p>Vercel AI Gateway · design, transcription, and speech</p>
          </div>
        </div>
        <label className="field-label">
          Vercel AI Gateway key
          <input
            type="password"
            autoComplete="off"
            placeholder={
              status?.gatewayConnected
                ? 'Key configured · leave blank to keep'
                : 'Paste your Gateway key'
            }
            value={gatewayKey}
            onChange={(e) => setGatewayKey(e.target.value)}
          />
          <small>Leave blank to keep your current key. Saving does not test the connection.</small>
        </label>
        <label className="field-label">
          Design model
          <input value={model} onChange={(e) => setModel(e.target.value)} required />
          <small>
            Use a Gateway model ID that supports structured outputs. You can change it any time.
          </small>
        </label>
        <div className="connection-section">
          <span className="section-icon">
            <AudioLines size={19} />
          </span>
          <div>
            <h3>Voice</h3>
            <p>Push-to-talk transcription and optional AI speech, using the same key</p>
          </div>
        </div>
        <label className="field-label">
          Speech model
          <input value={speechModel} onChange={(e) => setSpeechModel(e.target.value)} required />
        </label>
        <label className="field-label">
          Voice name
          <input value={speechVoice} onChange={(e) => setSpeechVoice(e.target.value)} required />
          <small>Choose a voice supported by your speech model. Gemini voices include Kore.</small>
        </label>
        <label className="field-label">
          Transcription model
          <input
            value={transcriptionModel}
            onChange={(e) => setTranscriptionModel(e.target.value)}
            required
          />
        </label>
        <label className="field-label">
          Daily cloud request limit
          <input
            type="number"
            min="1"
            max="1000"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            required
          />
          <small>
            Counts model, transcription, and cloud speech calls. This is a request cap, not a dollar
            cap. Set a spending limit with your provider too.
          </small>
        </label>
        <div className="local-note">
          <House size={17} />
          <span>
            Your key is saved on this computer, outside the browser. Design requests, recorded
            speech, and AI spoken replies use Vercel AI Gateway and your selected providers.
          </span>
        </div>
        <button className="primary full" disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save
          connections
        </button>
      </form>
    </Modal>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [selection, setSelection] = useState<DesignSelection | null>(null);
  const selected = selection?.roomId ?? null;
  const setSelected = useCallback(
    (roomId: string | null) => setSelection(roomId ? { roomId, surface: 'room' } : null),
    [],
  );
  const [quality, setQuality] = useState<Quality>('live'),
    [view, setView] = useState<View>('orbit'),
    [light, setLight] = useState<Light>('day'),
    [cutaway, setCutaway] = useState(false),
    [resetKey, setResetKey] = useState(0);
  const [modal, setModal] = useState<'connections' | 'versions' | 'projects' | 'help' | null>(null),
    [panel, setPanel] = useState<'spaces' | 'materials'>('spaces'),
    [partner, setPartner] = useState(true);
  const [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [renderStatus, setRenderStatus] = useState('Live rendering');
  const [pending, setPending] = useState<DesignResult | null>(null),
    [versionName, setVersionName] = useState(''),
    [compareId, setCompareId] = useState<string | null>(null),
    [compareSide, setCompareSide] = useState<'current' | 'saved'>('current');
  const [speech, setSpeech] = useState<'browser' | 'cloud' | 'off'>('cloud');
  const inputRef = useRef<HTMLTextAreaElement>(null),
    chatEnd = useRef<HTMLDivElement>(null),
    audio = useRef<HTMLAudioElement | null>(null),
    audioUrl = useRef<string | null>(null),
    speechRun = useRef(0),
    speechRequest = useRef<AbortController | null>(null),
    busyRef = useRef(false),
    lockedRef = useRef(true),
    runIdRef = useRef<string | null>(null),
    cancelledRef = useRef(false);
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);
  const [lastResult, setLastResult] = useState<DesignResult | null>(null);
  const previousAlternativeError = useRef('');
  const [allowVisualReview, setAllowVisualReview] = useState(() => {
    try {
      return localStorage.getItem('terrain.visualReview') !== 'off';
    } catch {
      return true;
    }
  });
  const renderBridge = useRenderBridge();
  useEffect(() => {
    try {
      localStorage.setItem('terrain.visualReview', allowVisualReview ? 'on' : 'off');
    } catch {
      /* Preference still applies for this session. */
    }
  }, [allowVisualReview]);
  const cameraRef = useRef<CameraContext | undefined>(undefined);
  const onCameraChange = useCallback((camera: CameraContext) => {
    cameraRef.current = camera;
  }, []);
  const [requirementText, setRequirementText] = useState('');
  const [requirementSource, setRequirementSource] =
    useState<DesignRequirement['source']>('confirmed');
  const notify = useCallback((text: string) => setError(text), []);
  const refreshStatus = useCallback(() => {
    api<Status>('status')
      .then(setStatus)
      .catch(() => {});
  }, []);
  const {
    project,
    projectRef,
    setProject,
    saved,
    loadError,
    flush,
    acceptPersisted,
    markConflict,
  } = useProject(notify);
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [project?.messages.length, busy]);
  useEffect(() => {
    if (project && selection && !validSelection(project.scene, selection)) setSelection(null);
  }, [project, selection]);
  const stopSpeech = useCallback(() => {
    speechRun.current++;
    speechRequest.current?.abort();
    speechRequest.current = null;
    window.speechSynthesis?.cancel();
    audio.current?.pause();
    if (audioUrl.current) {
      URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = null;
    }
  }, []);
  useEffect(() => () => stopSpeech(), [stopSpeech]);
  const speak = useCallback(
    async (text: string, designApplied = false) => {
      stopSpeech();
      const run = speechRun.current;
      if (speech === 'off') return;
      // Detailed geometry disclosures stay visible in chat; keep speech within
      // the provider route's limit without another model call to summarize it.
      if (text.length > 1500) {
        const excerpt = text.slice(0, 1380);
        const sentence = Math.max(excerpt.lastIndexOf('. '), excerpt.lastIndexOf('\n'));
        text = `${excerpt.slice(0, sentence > 800 ? sentence + 1 : excerpt.lastIndexOf(' '))} Read the full design check in chat for the remaining details.`;
      }
      if (speech === 'browser') {
        if (!window.speechSynthesis || !window.speechSynthesis.getVoices().length) {
          notify(
            'No system voice is available in this browser. Choose AI voice or read the reply on screen.',
          );
          return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.02;
        window.speechSynthesis.speak(utterance);
        return;
      }
      try {
        const controller = new AbortController();
        speechRequest.current = controller;
        const response = await fetch('/api/speak', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error((await response.json()).error);
        const blob = await response.blob();
        if (run !== speechRun.current) return;
        audioUrl.current = URL.createObjectURL(blob);
        audio.current = new Audio(audioUrl.current);
        await audio.current.play();
        refreshStatus();
      } catch (e) {
        if (run !== speechRun.current) return;
        notify(
          `${designApplied ? 'Design applied' : 'Your design response is ready'}, but the spoken reply failed: ${(e as Error).message}`,
        );
      }
    },
    [speech, notify, refreshStatus, stopSpeech],
  );
  const alternativeModel = useVisualAlternatives({
    flush,
    acceptPersisted,
    renderClientId: renderBridge.clientId,
    context: {
      selectedRoomId: selected,
      selection: selection ?? undefined,
      view,
      allowVisualReview,
      renderClientId: renderBridge.clientId ?? undefined,
      ...(view !== 'plan' && cameraRef.current ? { camera: cameraRef.current } : {}),
    },
    onBusy: (value) => {
      busyRef.current = value;
      setBusy(value);
      if (value) stopSpeech();
    },
    onConflict: markConflict,
    onCommitted: () => {
      setSelection(null);
      setCompareId(null);
      setPending(null);
      setLastResult(null);
      setRunProgress(null);
      setResetKey((key) => key + 1);
      setModal(null);
    },
  });
  useEffect(() => {
    const previous = previousAlternativeError.current;
    previousAlternativeError.current = alternativeModel.error;
    if (!alternativeModel.error) {
      if (previous) setError((current) => (current === previous ? '' : current));
      return;
    }
    if (modal !== 'versions') notify(alternativeModel.error);
    else setError((current) => (current === alternativeModel.error ? '' : current));
  }, [alternativeModel.error, modal, notify]);
  const commit = useCallback(
    (scene: Scene) => {
      try {
        validateScene(scene);
        const problem = validateDesign(scene).find((issue) => issue.severity === 'error');
        if (problem) throw new Error(problem.message);
        setProject((p) => (p ? editProject(p, scene) : p));
        setCompareId(null);
        setPending(null);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [notify, setProject],
  );
  const mutateRoom = (patch: Partial<Room>) => {
    if (!project || !selected) return;
    const room = project.scene.rooms.find((item) => item.id === selected);
    if (!room) return;
    const position =
      patch.x !== undefined || patch.z !== undefined || patch.elevation !== undefined;
    const dimensions =
      patch.width !== undefined || patch.depth !== undefined || patch.height !== undefined;
    const command = patch.palette
      ? { type: 'set_material', palette: patch.palette, roomIds: [selected] }
      : position
        ? {
            type: 'move_group',
            roomIds: [selected],
            dx: (patch.x ?? room.x) - room.x,
            dz: (patch.z ?? room.z) - room.z,
            elevationDelta: (patch.elevation ?? room.elevation) - room.elevation,
          }
        : dimensions
          ? {
              type: 'resize_room',
              roomId: selected,
              ...patch,
              anchor: 'center',
              moveConnected: true,
            }
          : { type: 'update_room', roomId: selected, patch };
    const result = executeCommands(project.scene, [command]);
    if (!result.applied) {
      notify(result.issues.map((issue) => issue.message).join(' '));
      return;
    }
    commit(result.scene);
  };
  const applyDraft = useCallback(
    async (result: DesignResult, confirm: boolean) => {
      if (!result.draftId)
        throw new Error('The agent did not return a committable draft. Please retry.');
      const latest = await flush();
      if (!latest) throw new Error('Your project is not loaded yet.');
      setRunProgress({
        stage: 'committing',
        status: 'running',
        message: 'Saving the validated design…',
      });
      const committed = await api<DraftCommitResult>(`design/drafts/${result.draftId}/commit`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: latest.revision, confirm }),
      });
      const wasEmpty = !latest.scene.rooms.length;
      acceptPersisted(committed.project);
      setPending(null);
      setCompareId(null);
      if (!committed.project.scene.rooms.some((room) => room.id === selected)) setSelected(null);
      if (wasEmpty && committed.project.scene.rooms.length) setResetKey((key) => key + 1);
      void speak(committed.reply, true);
    },
    [flush, acceptPersisted, selected, speak],
  );
  const discardDraft = useCallback(async () => {
    if (!pending?.draftId) return;
    try {
      await api(`design/drafts/${pending.draftId}`, { method: 'DELETE' });
      setPending(null);
      setLastResult(null);
      setRunProgress(null);
    } catch (error) {
      notify((error as Error).message);
    }
  }, [pending, notify]);
  const keepDraft = useCallback(async () => {
    if (!pending || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await applyDraft(pending, true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'revision_conflict') markConflict();
      notify((error as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [pending, applyDraft, notify, markConflict]);
  const cancelRun = useCallback(async () => {
    cancelledRef.current = true;
    setRunProgress(
      (progress) => progress && { ...progress, message: 'Cancelling this design request…' },
    );
    const runId = runIdRef.current;
    if (runId) {
      try {
        await api(`agent/runs/${runId}/cancel`, { method: 'POST' });
      } catch {
        /* A request still flushing local saves has not registered its run yet. */
      }
    }
  }, []);
  useEffect(() => {
    if (!busy) return;
    let active = true;
    let fetching = false;
    const poll = async () => {
      if (!runIdRef.current || fetching) return;
      fetching = true;
      try {
        const runId = runIdRef.current;
        const result = await api<RunProgress>(`agent/runs/${runId}`);
        if (active && cancelledRef.current && result.status === 'running') {
          await api(`agent/runs/${runId}/cancel`, { method: 'POST' });
        }
        if (active && !cancelledRef.current) setRunProgress(result);
      } catch {
        /* The run becomes visible after the request is accepted. */
      } finally {
        fetching = false;
      }
    };
    const interval = setInterval(() => {
      void poll();
    }, 500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [busy]);
  const send = useCallback(
    async (text: string) => {
      text = text.trim();
      const current = projectRef.current;
      if (!text || !current || busyRef.current) return;
      if (pending) {
        notify('Keep or discard the proposed change before making another request.');
        return;
      }
      if (compareId) {
        notify('Exit comparison before asking for a change to your current house.');
        return;
      }
      if (alternativeModel.preview) {
        notify(
          'Choose a direction or return to your current house before asking for another change.',
        );
        return;
      }
      if (saved === 'conflict') {
        notify('Reload the saved project before asking for another design change.');
        return;
      }
      stopSpeech();
      setError('');
      setInput('');
      const local = text.toLowerCase().replace(/[.!?]+$/, '');
      const command =
        local === 'undo'
          ? () => setProject((p) => (p ? undo(p) : p))
          : local === 'redo'
            ? () => setProject((p) => (p ? redo(p) : p))
            : local === 'show wireframe'
              ? () => setQuality('wireframe')
              : local === 'show floor plan'
                ? () => setView('plan')
                : local === 'show exterior'
                  ? () => setView('orbit')
                  : local === 'walk inside'
                    ? () => setView('walk')
                    : local === 'hide roof'
                      ? () => setCutaway(true)
                      : local === 'show roof'
                        ? () => setCutaway(false)
                        : null;
      if (command) {
        command();
        return;
      }
      if (!status?.modelConnected) {
        setInput(text);
        setModal('connections');
        return;
      }
      setProject((p) =>
        p
          ? {
              ...p,
              messages: [...p.messages, { id: uid(), role: 'user' as const, text }].slice(-100),
            }
          : p,
      );
      busyRef.current = true;
      cancelledRef.current = false;
      runIdRef.current = uid();
      setBusy(true);
      setRunProgress({
        stage: 'saving',
        status: 'running',
        message: 'Saving your latest changes…',
      });
      try {
        const latest = await flush();
        if (!latest) throw new Error('Your project is not loaded yet.');
        if (cancelledRef.current) throw new Error('Design request cancelled.');
        const result = await api<DesignResult>('agent', {
          method: 'POST',
          body: JSON.stringify({
            runId: runIdRef.current,
            projectId: latest.projectId,
            scene: latest.scene,
            messages: latest.messages,
            baseRevision: latest.revision,
            context: {
              selectedRoomId: selected,
              selection: selection ?? undefined,
              allowVisualReview,
              renderClientId: renderBridge.clientId ?? undefined,
              view,
              ...(view !== 'plan' && cameraRef.current ? { camera: cameraRef.current } : {}),
            },
          }),
        });
        runIdRef.current = null;
        if (cancelledRef.current) {
          if (result.draftId) await api(`design/drafts/${result.draftId}`, { method: 'DELETE' });
          throw new Error('Design request cancelled.');
        }
        if (result.scene) {
          if (result.needsConfirmation) {
            setPending(result);
            setCompareId(null);
          } else await applyDraft(result, false);
        } else {
          setProject((p) =>
            p
              ? {
                  ...p,
                  messages: [
                    ...p.messages,
                    { id: uid(), role: 'assistant' as const, text: result.reply },
                  ].slice(-100),
                }
              : p,
          );
          await flush();
          void speak(result.reply);
        }
        setLastResult(result);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'revision_conflict') markConflict();
        const message = cancelledRef.current
          ? 'Design request cancelled. Your house is unchanged.'
          : (error as Error).message;
        setProject((p) =>
          p
            ? {
                ...p,
                messages: [
                  ...p.messages,
                  {
                    id: uid(),
                    role: 'assistant' as const,
                    text: message,
                    kind: cancelledRef.current ? ('status' as const) : ('error' as const),
                    retryText: text,
                  },
                ].slice(-100),
              }
            : p,
        );
        if (!cancelledRef.current) notify(message);
      } finally {
        runIdRef.current = null;
        busyRef.current = false;
        setBusy(false);
        refreshStatus();
      }
    },
    [
      status,
      pending,
      compareId,
      alternativeModel.preview,
      saved,
      notify,
      refreshStatus,
      speak,
      stopSpeech,
      setProject,
      projectRef,
      flush,
      selected,
      view,
      selection,
      allowVisualReview,
      renderBridge.clientId,
      applyDraft,
      markConflict,
    ],
  );
  const voice = useVoice({
    scopeKey: project?.projectId,
    onText: send,
    onError: notify,
    enabled: !!status?.voiceConnected,
    busy:
      busy ||
      !!modal ||
      !!pending ||
      !!alternativeModel.preview ||
      !!compareId ||
      saved === 'conflict',
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'z' &&
        !busyRef.current &&
        !pending &&
        !modal &&
        !compareId &&
        !alternativeModel.preview &&
        saved !== 'conflict' &&
        !(e.target as HTMLElement).closest('input,textarea')
      ) {
        e.preventDefault();
        setPending(null);
        setProject((p) => (p ? (e.shiftKey ? redo(p) : undo(p)) : p));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [pending, modal, compareId, alternativeModel.preview, saved, setProject]);
  const closeModal = useCallback(() => {
    if (!alternativeModel.busy) setModal(null);
  }, [alternativeModel.busy]);
  const changeHouse = useCallback(
    async (action: { name: string } | { id: string }) => {
      if (busyRef.current || pending)
        throw new Error('Finish or discard the current proposal before switching houses.');
      busyRef.current = true;
      setBusy(true);
      stopSpeech();
      try {
        const current = await flush();
        if (!current?.projectId)
          throw new Error('Reload this project before opening another house.');
        const result = await api<{ project: Project }>(
          'id' in action ? `projects/${encodeURIComponent(action.id)}/open` : 'projects',
          {
            method: 'POST',
            body: JSON.stringify({
              expectedProjectId: current.projectId,
              expectedRevision: current.revision,
              ...('name' in action ? { name: action.name } : {}),
            }),
          },
        );
        acceptPersisted(result.project);
        setSelection(null);
        setPending(null);
        setCompareId(null);
        setCompareSide('current');
        setLastResult(null);
        setRunProgress(null);
        setInput('');
        setError('');
        setVersionName('');
        setRequirementText('');
        alternativeModel.clear();
        setPanel('spaces');
        cameraRef.current = undefined;
        setView('orbit');
        setResetKey((key) => key + 1);
        setModal(null);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'revision_conflict') markConflict();
        throw error;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [pending, stopSpeech, flush, acceptPersisted, markConflict, alternativeModel.clear],
  );
  const download = () => {
    if (!project) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.scene.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.terrain.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const screenshot = () => {
    const canvas = document.querySelector<HTMLCanvasElement>('.viewport canvas');
    if (!canvas) {
      notify('Switch to a 3D view to save an image.');
      return;
    }
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'terrain-view.png';
    a.click();
  };
  const saveVersion = () => {
    if (!project || !versionName.trim() || busyRef.current || pending || saved === 'conflict')
      return;
    if (project.variants.length >= 30) {
      notify('You have 30 saved alternatives. Remove one before saving another.');
      return;
    }
    setProject((p) =>
      p
        ? {
            ...p,
            variants: [
              ...p.variants,
              {
                id: uid(),
                name: versionName.trim(),
                createdAt: new Date().toISOString(),
                scene: structuredClone(p.scene),
              },
            ],
          }
        : p,
    );
    setVersionName('');
  };
  if (loadError)
    return (
      <div className="boot-screen">
        <House size={36} />
        <h1>Could not load project</h1>
        <p>{loadError}</p>
        <p>The existing file has not been overwritten.</p>
        <button className="primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!project)
    return (
      <div className="boot-screen">
        <span className="brand-mark">
          <House size={28} />
        </span>
        <h1>Terrain</h1>
        <LoaderCircle className="spin" size={20} />
      </div>
    );
  const house = project.scene;
  const applyArchitecture = (commands: DesignCommand[]) => {
    if (lockedRef.current) return false;
    const result = executeCommands(house, commands);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    if (!result.applied || errors.length) {
      notify((errors.length ? errors : result.issues).map((issue) => issue.message).join(' '));
      return false;
    }
    commit(result.scene);
    return true;
  };
  const requirements = house.design?.requirements || [];
  const updateRequirements = (next: DesignRequirement[]) => {
    commit({
      ...house,
      design: {
        groups: house.design?.groups || [],
        connections: house.design?.connections || [],
        stairLinks: house.design?.stairLinks || [],
        requirements: next,
      },
    });
  };
  const selectedRoom = house.rooms.find((r) => r.id === selected);
  const comparison = project.variants.find((v) => v.id === compareId);
  const displayed =
    alternativeModel.preview?.scene ||
    pending?.scene ||
    (busy ? runProgress?.preview : null) ||
    (comparison && compareSide === 'saved' ? comparison.scene : house);
  const locked =
    busy || !!pending || !!comparison || !!alternativeModel.preview || saved === 'conflict';
  lockedRef.current = locked;
  return (
    <div className="app-shell">
      {renderBridge.job && (
        <RenderCapture
          job={renderBridge.job}
          onComplete={renderBridge.complete}
          onError={renderBridge.fail}
        />
      )}
      <header className="topbar">
        <a className="brand" href="/" aria-label="Terrain home">
          <span className="brand-mark">
            <House size={23} strokeWidth={1.4} />
          </span>
          <span>
            terrain<span className="brand-dot">.</span>
          </span>
        </a>
        <span className="header-divider" />
        <div className="project-title">
          <span>{project.projectName || house.name}</span>
          <span
            className={`save-state ${saved === 'error' || saved === 'conflict' ? 'failed' : ''}`}
          >
            {saved === 'saved' ? (
              <CheckCheck size={12} />
            ) : saved === 'saving' ? (
              <LoaderCircle className="spin" size={12} />
            ) : (
              <CircleHelp size={12} />
            )}{' '}
            {saved === 'saved'
              ? 'Saved on this device'
              : saved === 'saving'
                ? 'Saving locally…'
                : saved === 'conflict'
                  ? 'Save conflict · reload needed'
                  : 'Save failed'}
          </span>
        </div>
        <nav className="header-actions">
          <button className="text-button" disabled={locked} onClick={() => setModal('projects')}>
            <House size={15} /> My houses
          </button>
          <button
            className="text-button"
            onClick={() => {
              alternativeModel.setPreview(null);
              setModal('versions');
            }}
          >
            <GitBranch size={15} /> Alternatives{' '}
            <span className="count">{project.variants.length}</span>
          </button>
          <span className="header-divider" />
          <IconButton label="Help and shortcuts" onClick={() => setModal('help')}>
            <CircleHelp size={17} />
          </IconButton>
          <IconButton label="Connections and settings" onClick={() => setModal('connections')}>
            <Settings2 size={17} />
          </IconButton>
          <button className="export-button" onClick={download}>
            <ArrowDownToLine size={15} /> Export project
          </button>
        </nav>
      </header>
      <div className={`studio ${partner ? '' : 'partner-hidden'}`}>
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={panel === 'spaces' ? 'active' : ''}
              onClick={() => setPanel('spaces')}
            >
              <Layers3 size={15} /> Spaces
            </button>
            <button
              className={panel === 'materials' ? 'active' : ''}
              onClick={() => setPanel('materials')}
            >
              <SlidersHorizontal size={15} /> Materials
            </button>
          </div>
          <div className="sidebar-scroll">
            {panel === 'spaces' ? (
              <>
                <div className="section-title">
                  <span>ROOMS</span>
                  <button
                    className="tiny-button"
                    aria-label="Add a room"
                    title="Add a room"
                    disabled={locked || house.rooms.length >= 32}
                    onClick={() => {
                      const x = house.rooms.length
                        ? Math.max(...house.rooms.map((r) => r.x + r.width / 2)) + 3.5
                        : 0;
                      const room = makeRoom({
                        x: Math.min(x, 60),
                        name: house.rooms.length ? 'New room' : 'First room',
                      });
                      commit({ ...house, rooms: [...house.rooms, room] });
                      setSelected(room.id);
                    }}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                {!house.rooms.length ? (
                  <div className="empty-spaces">
                    <h3>No rooms yet</h3>
                    <p>Add a room or describe a layout.</p>
                  </div>
                ) : (
                  <div className="room-list">
                    {house.rooms.map((r) => (
                      <button
                        key={r.id}
                        className={`room-item ${selected === r.id ? 'selected' : ''}`}
                        onClick={() => setSelected(selected === r.id ? null : r.id)}
                      >
                        <span className={`room-kind ${r.kind}`}>
                          <Square size={13} />
                        </span>
                        <span>
                          {r.name}
                          <small>
                            {r.elevation === 0 ? 'Ground level' : `${r.elevation} m level`} ·{' '}
                            {(r.width * r.depth).toFixed(0)} m²
                          </small>
                        </span>
                        <ChevronRight size={12} />
                      </button>
                    ))}
                  </div>
                )}
                {selectedRoom && (
                  <div className="room-inspector" key={selectedRoom.id}>
                    <div className="section-title">
                      <span>SPACE DETAILS</span>
                      <button
                        className="tiny-button"
                        onClick={() => setSelected(null)}
                        aria-label="Close space details"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <label className="field-label">
                      Selected part
                      <select
                        aria-label="Selected house part"
                        disabled={busy}
                        value={selection?.surface || 'room'}
                        onChange={(event) =>
                          setSelection({
                            roomId: selectedRoom.id,
                            surface: event.target.value as DesignSelection['surface'],
                          })
                        }
                      >
                        <option value="room">Whole room</option>
                        {(['north', 'south', 'east', 'west', 'floor', 'roof'] as const).map(
                          (surface) => (
                            <option
                              key={surface}
                              value={surface}
                              disabled={
                                surface !== 'floor' &&
                                ['courtyard', 'terrace'].includes(selectedRoom.kind)
                              }
                            >
                              {['north', 'south', 'east', 'west'].includes(surface)
                                ? `${surface} wall`
                                : surface}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="field-label">
                      Name
                      <input
                        disabled={locked}
                        defaultValue={selectedRoom.name}
                        onBlur={(e) => {
                          if (e.target.value.trim() && e.target.value !== selectedRoom.name)
                            mutateRoom({ name: e.target.value.trim() });
                        }}
                      />
                    </label>
                    <label className="field-label">
                      Use
                      <select
                        disabled={locked}
                        value={selectedRoom.kind}
                        onChange={(e) => mutateRoom({ kind: e.target.value as Room['kind'] })}
                      >
                        {[
                          'living',
                          'kitchen',
                          'bedroom',
                          'bathroom',
                          'hall',
                          'courtyard',
                          'terrace',
                          'other',
                        ].map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                    </label>
                    <div className="dimensions">
                      {(['width', 'depth', 'height', 'elevation', 'x', 'z'] as const).map((key) => (
                        <label className="field-label" key={`${key}-${selectedRoom[key]}`}>
                          {key}
                          <div className="unit-input">
                            <input
                              disabled={locked}
                              type="number"
                              step=".1"
                              defaultValue={selectedRoom[key]}
                              onBlur={(e) => {
                                const value = Number(e.target.value);
                                if (value !== selectedRoom[key] && e.target.value !== '')
                                  mutateRoom({ [key]: value });
                              }}
                            />
                            <span>m</span>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="dimensions">
                      {(['north', 'south', 'east', 'west'] as const).map((key) => (
                        <label className="field-label" key={key}>
                          {key}
                          <select
                            disabled={
                              locked ||
                              roomOpenings(house, selectedRoom.id, key).some(
                                (opening) => opening.source === 'explicit',
                              )
                            }
                            title={
                              roomOpenings(house, selectedRoom.id, key).some(
                                (opening) => opening.source === 'explicit',
                              )
                                ? 'Edit individual windows and doors below. Remove them before replacing the whole wall.'
                                : undefined
                            }
                            value={selectedRoom[key]}
                            onChange={(e) => mutateRoom({ [key]: e.target.value })}
                          >
                            {['solid', 'glass', 'door', 'open'].map((w) => (
                              <option key={w}>{w}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                    <label className="field-label">
                      {selection?.surface === 'room'
                        ? 'Room material'
                        : 'Selected surface material'}
                      <select
                        disabled={locked}
                        value={surfacePalette(house, selectedRoom, selection?.surface || 'room')}
                        onChange={(event) => {
                          if (!selection || selection.surface === 'room')
                            mutateRoom({ palette: event.target.value as Room['palette'] });
                          else {
                            const result = executeCommands(house, [
                              {
                                type: 'set_surface_material',
                                roomId: selectedRoom.id,
                                surface: selection.surface,
                                palette: event.target.value,
                              },
                            ]);
                            if (!result.applied) {
                              notify(result.issues.map((issue) => issue.message).join(' '));
                              return;
                            }
                            commit(result.scene);
                          }
                        }}
                      >
                        {Object.entries(palettes).map(([id, palette]) => (
                          <option key={id} value={id}>
                            {palette.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!['courtyard', 'terrace'].includes(selectedRoom.kind) && (
                      <>
                        <RoofControls
                          key={`${project.projectId}-${selectedRoom.id}-roof`}
                          scene={house}
                          room={selectedRoom}
                          disabled={locked}
                          onApply={applyArchitecture}
                        />
                        <OpeningControls
                          key={`${project.projectId}-${selectedRoom.id}-openings`}
                          scene={house}
                          room={selectedRoom}
                          selectedSide={
                            selection &&
                            ['north', 'south', 'east', 'west'].includes(selection.surface)
                              ? (selection.surface as Side)
                              : undefined
                          }
                          disabled={locked}
                          onApply={applyArchitecture}
                        />
                      </>
                    )}
                    <button
                      className="text-button danger"
                      disabled={locked}
                      onClick={() => {
                        const result = executeCommands(house, [
                          { type: 'remove_objects', ids: [selected] },
                        ]);
                        if (!result.applied) {
                          notify(result.issues.map((issue) => issue.message).join(' '));
                          return;
                        }
                        commit(result.scene);
                        setSelected(null);
                      }}
                    >
                      <Trash2 size={13} /> Remove space
                    </button>
                  </div>
                )}
                <label className="slope-control">
                  <span>
                    Site slope <b>{Math.round(house.slope * 100)}%</b>
                  </span>
                  <input
                    aria-label="Site slope"
                    type="range"
                    min="0"
                    max=".35"
                    step=".01"
                    disabled={locked}
                    value={house.slope}
                    onChange={(e) => commit({ ...house, slope: Number(e.target.value) })}
                  />
                </label>
                <section className="design-brief" aria-label="Design brief">
                  <div className="section-title">
                    <span>DESIGN BRIEF</span>
                  </div>
                  <p className="panel-note">
                    Confirmed requirements take priority over assumptions and preferences.
                  </p>
                  {requirements.map((requirement) => (
                    <div className="requirement-card" key={requirement.id}>
                      <div className="requirement-heading">
                        <select
                          aria-label={`Source for ${requirement.description}`}
                          disabled={locked}
                          value={requirement.source}
                          onChange={(event) =>
                            updateRequirements(
                              requirements.map((item) =>
                                item.id === requirement.id
                                  ? {
                                      ...item,
                                      source: event.target.value as DesignRequirement['source'],
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <option value="confirmed">Confirmed</option>
                          <option value="assumption">Assumption</option>
                          <option value="preference">Preference</option>
                        </select>
                        <button
                          className="tiny-button"
                          aria-label={`Remove requirement ${requirement.description}`}
                          disabled={locked}
                          onClick={() =>
                            updateRequirements(
                              requirements.filter((item) => item.id !== requirement.id),
                            )
                          }
                        >
                          <X size={13} />
                        </button>
                      </div>
                      <textarea
                        key={`${requirement.id}-${requirement.description}`}
                        aria-label={`Requirement ${requirement.id}`}
                        disabled={locked}
                        maxLength={500}
                        rows={3}
                        defaultValue={requirement.description}
                        onBlur={(event) => {
                          const description = event.target.value.trim();
                          if (description && description !== requirement.description)
                            updateRequirements(
                              requirements.map((item) =>
                                item.id === requirement.id ? { ...item, description } : item,
                              ),
                            );
                        }}
                      />
                      <small>
                        {requirement.kind === 'intent'
                          ? 'Design note'
                          : `${requirement.kind} · geometry checked`}
                      </small>
                    </div>
                  ))}
                  <form
                    className="requirement-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!requirementText.trim() || locked) return;
                      updateRequirements([
                        ...requirements,
                        {
                          id: uid(),
                          kind: 'intent',
                          source: requirementSource,
                          description: requirementText.trim(),
                        },
                      ]);
                      setRequirementText('');
                    }}
                  >
                    <textarea
                      aria-label="New design requirement"
                      placeholder="Keep the fireplace centered…"
                      rows={3}
                      maxLength={500}
                      disabled={locked || requirements.length >= 60}
                      value={requirementText}
                      onChange={(event) => setRequirementText(event.target.value)}
                    />
                    <div>
                      <select
                        aria-label="New requirement source"
                        disabled={locked}
                        value={requirementSource}
                        onChange={(event) =>
                          setRequirementSource(event.target.value as DesignRequirement['source'])
                        }
                      >
                        <option value="confirmed">Confirmed</option>
                        <option value="assumption">Assumption</option>
                        <option value="preference">Preference</option>
                      </select>
                      <button
                        className="text-button"
                        disabled={locked || !requirementText.trim() || requirements.length >= 60}
                      >
                        <Plus size={13} /> Add note
                      </button>
                    </div>
                  </form>
                </section>
              </>
            ) : (
              <>
                <div className="section-title">
                  <span>HOUSE MATERIALS</span>
                </div>
                <p className="panel-note">
                  Applies to the whole house, replacing room and surface overrides.
                </p>
                <div className="material-options">
                  {Object.entries(palettes).map(([key, p]) => (
                    <button
                      className={`material-card ${house.palette === key ? 'selected' : ''}`}
                      key={key}
                      disabled={locked}
                      onClick={() => {
                        const result = executeCommands(house, [
                          { type: 'set_material', palette: key },
                        ]);
                        if (!result.applied) {
                          notify(result.issues.map((issue) => issue.message).join(' '));
                          return;
                        }
                        commit(result.scene);
                      }}
                    >
                      <div
                        className={`material-preview ${key}`}
                        style={
                          {
                            '--wall': p.wall,
                            '--wood': p.wood,
                            '--roof': p.roof,
                          } as React.CSSProperties
                        }
                      >
                        <span className="material-slab a" />
                        <span className="material-slab b" />
                        <span className="material-slab c" />
                        {house.palette === key && (
                          <span className="material-check">
                            <Check size={13} />
                          </span>
                        )}
                      </div>
                      <strong>{p.name}</strong>
                      <small>{p.description}</small>
                    </button>
                  ))}
                </div>
                <RoofControls
                  key={project.projectId}
                  scene={house}
                  disabled={locked}
                  onApply={applyArchitecture}
                />
              </>
            )}
          </div>
        </aside>
        <main className="workspace">
          <div className="viewport-header">
            <div className="view-tabs">
              {(
                [
                  { id: 'orbit', icon: Compass, label: 'Explore' },
                  { id: 'walk', icon: Footprints, label: 'Walk through' },
                  { id: 'plan', icon: ScanLine, label: 'Floor plan' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  className={view === tab.id ? 'active' : ''}
                  onClick={() => setView(tab.id)}
                >
                  <tab.icon size={14} />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
            <div className="viewport-tools">
              <IconButton
                label="Undo"
                disabled={!project.past.length || locked}
                onClick={() => {
                  setProject(undo(project));
                  setSelected(null);
                }}
              >
                <Undo2 size={16} />
              </IconButton>
              <IconButton
                label="Redo"
                disabled={!project.future.length || locked}
                onClick={() => {
                  setProject(redo(project));
                  setSelected(null);
                }}
              >
                <Redo2 size={16} />
              </IconButton>
              <span className="small-divider" />
              <IconButton
                label="Toggle design chat"
                active={partner}
                onClick={() => setPartner(!partner)}
              >
                <Columns2 size={16} />
              </IconButton>
            </div>
          </div>
          <div className="viewport">
            <SceneView
              house={displayed}
              quality={quality}
              view={view}
              light={light}
              cutaway={cutaway}
              selected={selected}
              selection={selection}
              onSelectSurface={setSelection}
              onSelect={setSelected}
              onRenderStatus={setRenderStatus}
              onCameraChange={onCameraChange}
              resetKey={resetKey}
            />
            {!house.rooms.length && !pending && view !== 'plan' && (
              <div className="welcome-overlay">
                <h2>No house yet</h2>
                <button
                  className="welcome-button"
                  onClick={() => {
                    setPartner(true);
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                >
                  Describe a house <ArrowRight size={15} />
                </button>
                <button
                  className="sample-button"
                  disabled={locked}
                  onClick={() => {
                    commit(hillsideHouse());
                    setResetKey((k) => k + 1);
                  }}
                >
                  Load sample house <ChevronRight size={12} />
                </button>
              </div>
            )}
            {view !== 'plan' && (
              <>
                <div className="render-toolbar">
                  <div className="render-select">
                    <Cuboid size={14} />
                    <select
                      aria-label="Render quality"
                      value={quality}
                      onChange={(e) => setQuality(e.target.value as Quality)}
                    >
                      {Object.entries(qualityNames).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} />
                  </div>
                  <span className="small-divider" />
                  <IconButton
                    label="Cutaway view"
                    active={cutaway}
                    onClick={() => setCutaway(!cutaway)}
                  >
                    <Layers3 size={15} />
                  </IconButton>
                  <IconButton label="Reset camera" onClick={() => setResetKey((k) => k + 1)}>
                    <Maximize2 size={15} />
                  </IconButton>
                  <IconButton label="Save view as image" onClick={screenshot}>
                    <ArrowDownToLine size={15} />
                  </IconButton>
                </div>
                <div className="lighting-toolbar">
                  {(
                    [
                      { id: 'day', icon: Sun, label: 'Daylight' },
                      { id: 'golden', icon: Sunset, label: 'Golden hour' },
                      { id: 'evening', icon: Moon, label: 'Evening' },
                    ] as const
                  ).map((item) => (
                    <IconButton
                      key={item.id}
                      label={item.label}
                      active={light === item.id}
                      onClick={() => setLight(item.id)}
                    >
                      <item.icon size={16} />
                    </IconButton>
                  ))}
                </div>
                <div className="compass">
                  <span>N</span>
                  <div>
                    <Compass size={32} strokeWidth={1} />
                  </div>
                </div>
              </>
            )}
            {busy && (
              <div className="thinking-overlay">
                <span className="thinking-orb" />
                <span>
                  {alternativeModel.busy === 'generating'
                    ? 'Exploring and rendering your alternatives…'
                    : alternativeModel.busy === 'choosing'
                      ? 'Keeping your chosen direction…'
                      : runProgress?.message || 'Finding the shape of your idea…'}
                </span>
                {runIdRef.current && (
                  <button
                    className="text-button"
                    onClick={() => void cancelRun()}
                    disabled={cancelledRef.current}
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
            {pending && (
              <div className="proposal-bar">
                <Sparkles size={17} />
                <span>Validated proposal · review before keeping</span>
                <button className="text-button" disabled={busy} onClick={() => void discardDraft()}>
                  Discard
                </button>
                <button
                  className="primary small"
                  disabled={busy || saved === 'conflict'}
                  onClick={() => void keepDraft()}
                >
                  <Check size={14} /> Keep this
                </button>
              </div>
            )}
            {alternativeModel.preview && (
              <div className="proposal-bar alternative-preview-bar">
                <Eye size={16} />
                <span>Preview: {alternativeModel.preview.name}</span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    alternativeModel.setPreview(null);
                    setModal('versions');
                  }}
                >
                  All choices
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => alternativeModel.setPreview(null)}
                >
                  Current house
                </button>
                <button
                  className="primary small"
                  disabled={busy || saved === 'conflict'}
                  onClick={() =>
                    void alternativeModel.choose(
                      alternativeModel.preview!.id,
                      alternativeModel.preference,
                    )
                  }
                >
                  <Check size={13} /> Use this design
                </button>
              </div>
            )}
            {comparison && !pending && (
              <div className="compare-bar">
                <span>
                  Compare with <strong>{comparison.name}</strong>
                </span>
                <div className="segmented">
                  <button
                    className={compareSide === 'current' ? 'active' : ''}
                    onClick={() => setCompareSide('current')}
                  >
                    Current
                  </button>
                  <button
                    className={compareSide === 'saved' ? 'active' : ''}
                    onClick={() => setCompareSide('saved')}
                  >
                    Saved alternative
                  </button>
                </div>
                <IconButton label="Exit comparison" onClick={() => setCompareId(null)}>
                  <X size={15} />
                </IconButton>
              </div>
            )}
            <div className="viewport-bottom">
              <span className="render-badge">
                <i />
                {view === 'plan' ? 'Measured layout' : renderStatus}
              </span>
              <span className="navigation-hint">
                {view === 'walk'
                  ? 'Click to look around · WASD move · Q/E down/up · Esc release'
                  : view === 'orbit'
                    ? 'Drag to orbit · Scroll to zoom · Right-drag to pan'
                    : 'Select a space for dimensions'}
              </span>
            </div>
          </div>
          <footer className="workspace-footer">
            <span>
              <span className="tiny-dot" />{' '}
              {house.rooms.length
                ? `${house.rooms.length} spaces · ${area(house).toFixed(0)} m² interior`
                : '0 spaces'}
            </span>
          </footer>
        </main>
        {partner && (
          <aside className="partner-panel">
            <div className="partner-header">
              <span className="partner-avatar">
                <Sparkles size={18} />
              </span>
              <div>
                <h2>Design chat</h2>
                <p>
                  <span className={status?.modelConnected ? 'online-dot' : 'offline-dot'} />
                  {status?.modelConnected ? 'Gateway key configured' : 'API key required'}
                </p>
              </div>
              <IconButton label="Hide design chat" onClick={() => setPartner(false)}>
                <X size={15} />
              </IconButton>
            </div>
            <div className="conversation">
              {!project.messages.length && (
                <>
                  <div className="prompt-chips">
                    {[
                      'A hillside home with an open kitchen overlooking a two-story living room',
                      'A single-story house with large windows and an open kitchen',
                      'A home wrapped around a garden courtyard',
                    ].map((prompt, i) => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setInput(prompt);
                          inputRef.current?.focus();
                        }}
                      >
                        {['Open-plan layout', 'Large windows', 'Courtyard layout'][i]}
                        <ArrowRight size={12} />
                      </button>
                    ))}
                  </div>
                </>
              )}
              {project.messages.map((m) => (
                <div
                  className={m.role === 'user' ? 'user-message' : 'assistant-message'}
                  key={m.id}
                >
                  {m.role === 'assistant' && (
                    <span className="mini-spark">
                      <Sparkles size={13} />
                    </span>
                  )}
                  <div className={m.kind === 'error' ? 'message-error' : undefined}>
                    {m.kind === 'error' && <strong>Design change failed</strong>}
                    <span>{m.text}</span>
                    {m.retryText && (
                      <button
                        className="text-button retry-request"
                        disabled={locked}
                        onClick={() => void send(m.retryText!)}
                      >
                        <Redo2 size={12} /> Try this request again
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {pending && (
                <div className="assistant-message proposal-message">
                  <span className="mini-spark">
                    <Sparkles size={13} />
                  </span>
                  <div>
                    <strong>Proposed change</strong>
                    <p>{pending.reply}</p>
                  </div>
                </div>
              )}
              {!busy &&
                lastResult &&
                (lastResult.changes.length > 0 || lastResult.issues.length > 0) && (
                  <details className="design-summary">
                    <summary>{pending ? 'Proposal details' : 'Latest design check'}</summary>
                    {lastResult.metrics && (
                      <p className="run-metrics">
                        {(lastResult.metrics.elapsedMs / 1000).toFixed(1)} s ·{' '}
                        {lastResult.usage.calls} model calls ·{' '}
                        {lastResult.usage.cost === null
                          ? 'Cost unavailable'
                          : `$${lastResult.usage.cost.toFixed(3)}`}
                      </p>
                    )}
                    {lastResult.assessment?.requirements.map((requirement) => (
                      <div className="request-assessment" key={requirement.id}>
                        <strong>{requirement.request}</strong>
                        <span
                          className={
                            requirement.status === 'fulfilled'
                              ? 'assessment-met'
                              : 'assessment-unmet'
                          }
                        >
                          {requirement.status} ·{' '}
                          {requirement.verification === 'geometry'
                            ? 'geometry checked'
                            : 'agent assessed'}
                        </span>
                        <p>{requirement.evidence}</p>
                        {requirement.limitation && (
                          <p className="design-warning">{requirement.limitation}</p>
                        )}
                      </div>
                    ))}
                    {lastResult.assessment?.assumptions.map((assumption, index) => (
                      <p key={`assumption-${index}`}>Assumption: {assumption.description}</p>
                    ))}
                    {lastResult.changes.map((change, i) => (
                      <p key={`change-${i}`}>{change}</p>
                    ))}
                    {lastResult.issues.map((issue, i) => (
                      <p className="design-warning" key={`issue-${i}`}>
                        {issue.message}
                      </p>
                    ))}
                  </details>
                )}
              {busy && (
                <div className="assistant-message">
                  <span className="mini-spark">
                    <Sparkles size={13} />
                  </span>
                  <div className="run-progress" aria-live="polite">
                    <span>
                      {alternativeModel.busy
                        ? 'Working on your visual alternatives…'
                        : runProgress?.message || 'Working on your design…'}
                    </span>
                    <div className="thinking-dots">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <div className="composer-area">
              {!status?.modelConnected && (
                <button className="connect-nudge" onClick={() => setModal('connections')}>
                  <span>
                    <Sparkles size={13} /> Connect your AI to begin
                  </span>
                  <ArrowRight size={13} />
                </button>
              )}
              <form
                className={`composer ${voice.state === 'recording' ? 'recording' : ''}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
              >
                <textarea
                  aria-label="Describe your home"
                  ref={inputRef}
                  placeholder="Describe a house or request a change…"
                  value={input}
                  disabled={locked}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send(input);
                    }
                  }}
                  rows={3}
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    aria-label="Hold to talk"
                    className={`mic-button ${voice.state === 'recording' ? 'recording' : ''}`}
                    disabled={locked || voice.state === 'transcribing'}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      stopSpeech();
                      void voice.start();
                    }}
                    onPointerUp={voice.stop}
                    onPointerCancel={voice.stop}
                    onKeyDown={(e) => {
                      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                        e.preventDefault();
                        stopSpeech();
                        void voice.start();
                      }
                    }}
                    onKeyUp={voice.stop}
                  >
                    {voice.state === 'transcribing' ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Mic size={16} />
                    )}
                    <span>
                      {voice.state === 'recording'
                        ? 'Listening…'
                        : voice.state === 'transcribing'
                          ? 'Transcribing…'
                          : voice.state === 'requesting'
                            ? 'Opening mic…'
                            : 'Hold to talk'}
                    </span>
                  </button>
                  <button
                    className="send-button"
                    aria-label="Send description"
                    disabled={!input.trim() || locked}
                  >
                    {busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={17} />}
                  </button>
                </div>
              </form>
              <div className="composer-caption">
                <span>
                  Or hold <kbd>space</kbd> to speak
                </span>
                <button
                  className="tiny-button"
                  title="Stop spoken reply"
                  aria-label="Stop spoken reply"
                  onClick={stopSpeech}
                >
                  <VolumeX size={12} />
                </button>
              </div>
              <label className="voice-select">
                <Volume2 size={12} />
                <select
                  aria-label="Spoken replies"
                  value={speech}
                  onChange={(e) => {
                    stopSpeech();
                    setSpeech(e.target.value as typeof speech);
                  }}
                >
                  <option value="browser">System voice · no API cost</option>
                  <option value="cloud">AI voice · Vercel Gateway</option>
                  <option value="off">Spoken replies off</option>
                </select>
              </label>
              <label className="view-context-control">
                <input
                  type="checkbox"
                  checked={allowVisualReview}
                  disabled={locked}
                  onChange={(event) => setAllowVisualReview(event.target.checked)}
                />
                Let AI inspect rendered views
              </label>
              <p className="visual-review-note">
                {allowVisualReview
                  ? 'Sends locally rendered images to the model when needed.'
                  : 'The agent uses geometry without sending rendered images.'}
              </p>
              {allowVisualReview && renderBridge.state === 'unavailable' && (
                <p className="visual-review-note warning">Local visual review is reconnecting…</p>
              )}
              {selectedRoom && (
                <p className="selected-context">
                  <Square size={11} /> Referring to {selectionLabel(house, selection)}
                </p>
              )}
              {!selectedRoom && house.rooms.length > 0 && (
                <p className="selected-context">
                  Point to a room, wall, floor, or roof, then hold Space to speak.
                </p>
              )}
            </div>
          </aside>
        )}
      </div>
      {(error || saved === 'conflict') && (
        <div className="toast" role="alert">
          <CircleHelp size={18} />
          <span>
            {error ||
              'This project changed elsewhere. Export your local work, then reload the saved project.'}
          </span>
          {saved === 'error' && (
            <button className="text-button" onClick={() => void flush().catch(() => {})}>
              Retry save
            </button>
          )}
          {saved === 'conflict' && (
            <>
              <button className="text-button" onClick={download}>
                Export local work
              </button>
              <button className="text-button" onClick={() => location.reload()}>
                Reload saved project
              </button>
            </>
          )}
          {saved !== 'conflict' && (
            <button
              aria-label="Dismiss message"
              className="tiny-button"
              onClick={() => setError('')}
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}
      {modal === 'connections' && (
        <Connections
          status={status}
          onSaved={refreshStatus}
          onClose={closeModal}
          onError={notify}
        />
      )}
      {modal === 'projects' && (
        <ProjectChooser
          busy={busy}
          onClose={closeModal}
          onCreate={(name) => changeHouse({ name })}
          onOpen={(id) => changeHouse({ id })}
        />
      )}
      {modal === 'versions' && (
        <Modal title="Alternatives" onClose={closeModal} wide>
          <VisualAlternatives
            model={alternativeModel}
            disabled={
              busy || !!pending || !!comparison || saved === 'conflict' || !status?.modelConnected
            }
            renderReady={!!renderBridge.clientId && renderBridge.state !== 'unavailable'}
            onPreview={() => {
              setCompareId(null);
              setView('orbit');
              setModal(null);
            }}
          />
          <div className="section-title saved-alternatives-heading">
            <span>SAVED ALTERNATIVES</span>
          </div>
          <form
            className="version-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveVersion();
            }}
          >
            <input
              aria-label="Alternative name"
              maxLength={80}
              placeholder="Alternative name"
              value={versionName}
              onChange={(e) => setVersionName(e.target.value)}
            />
            <button className="primary" disabled={!versionName.trim() || locked}>
              <Plus size={15} /> Save alternative
            </button>
          </form>
          <div className="version-list">
            {!project.variants.length ? (
              <div className="empty-versions">
                <GitBranch size={29} strokeWidth={1} />
                <h3>No saved alternatives</h3>
                <p>Enter a name to save the current design.</p>
              </div>
            ) : (
              project.variants.map((v) => (
                <div className="version-card" key={v.id}>
                  <div
                    className="version-thumbnail"
                    style={{ background: palettes[v.scene.palette].wall }}
                  >
                    {v.thumbnail ? (
                      <img src={v.thumbnail} alt={v.name} />
                    ) : (
                      <House size={28} strokeWidth={1} />
                    )}
                  </div>
                  <div className="version-info">
                    <h3>{v.name}</h3>
                    <p>
                      {v.scene.rooms.length} spaces · {area(v.scene).toFixed(0)} m² ·{' '}
                      {palettes[v.scene.palette].name}
                    </p>
                    <small>{new Date(v.createdAt).toLocaleString()}</small>
                  </div>
                  <button
                    className="text-button"
                    disabled={busy || !!pending}
                    onClick={() => {
                      setCompareId(v.id);
                      setCompareSide('saved');
                      closeModal();
                    }}
                  >
                    Compare
                  </button>
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => {
                      commit(structuredClone(v.scene));
                      closeModal();
                    }}
                  >
                    Restore
                  </button>
                  <IconButton
                    label={`Delete alternative ${v.name}`}
                    disabled={locked}
                    onClick={() =>
                      setProject((p) =>
                        p ? { ...p, variants: p.variants.filter((a) => a.id !== v.id) } : p,
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              ))
            )}
          </div>
          <div className="modal-footer">
            <button
              className="text-button"
              disabled={locked}
              onClick={() => {
                setModal('projects');
              }}
            >
              <Plus size={15} /> Start a new house
            </button>
            <button className="text-button" onClick={download}>
              <ArrowDownToLine size={15} /> Export all project data
            </button>
            <label className="text-button import-label">
              Import project
              <input
                type="file"
                accept=".json"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = '';
                  const startingProject = projectRef.current;
                  if (!file || locked || busyRef.current || !startingProject) return;
                  try {
                    const contents = await file.text();
                    const current = projectRef.current;
                    if (
                      !current ||
                      current.projectId !== startingProject.projectId ||
                      current.revision !== startingProject.revision ||
                      current.scene !== startingProject.scene ||
                      busyRef.current ||
                      lockedRef.current
                    ) {
                      notify(
                        'Import cancelled because the house or editing state changed while the file was loading. Choose the file again to import it into the current house.',
                      );
                      return;
                    }
                    const incoming = documentSchema.parse(JSON.parse(contents));
                    validateScene(incoming.scene);
                    setProject((p) =>
                      p
                        ? { ...incoming, past: [...p.past, p.scene].slice(-60), future: [] }
                        : incoming,
                    );
                    setSelected(null);
                    setPending(null);
                    setCompareId(null);
                    closeModal();
                  } catch {
                    notify(
                      'That file is not a valid Terrain project. Your current house is unchanged.',
                    );
                  }
                }}
              />
            </label>
          </div>
        </Modal>
      )}
      {modal === 'help' && (
        <Modal title="Help and shortcuts" onClose={closeModal}>
          <div className="help-list">
            <p>
              <kbd>Space</kbd>
              <span>Hold to speak when you’re not typing. Release to send.</span>
            </p>
            <p>
              <kbd>↵</kbd>
              <span>Send a message. Shift + Enter adds a new line.</span>
            </p>
            <p>
              <kbd>Ctrl Z</kbd>
              <span>Undo a design change. Ctrl + Shift + Z to redo.</span>
            </p>
            <p>
              <kbd>W A S D</kbd>
              <span>
                Move in walkthrough. Q/E move down/up; Esc releases the mouse. This first version
                uses free movement, without wall collision.
              </span>
            </p>
          </div>
          <div className="help-note">
            <h3>Example requests</h3>
            <p>
              “Make the living room wider.” “Give the bedrooms more privacy.” “Use darker wood
              outside.”
            </p>
            <p>
              Local commands: “undo”, “redo”, “show wireframe”, “show floor plan”, “show exterior”,
              “walk inside”, “hide roof”, “show roof”.
            </p>
            <h3>Limitations</h3>
            <p>
              Rooms use rectangular geometry. Layouts need review for access, structure, and
              construction. Path tracing refines lighting over time.
            </p>
            <p>
              {status?.usage.requests || 0} / {status?.dailyLimit || 60} cloud requests today.
              Reported design cost: ${(status?.usage.modelCost || 0).toFixed(4)}. This may omit
              unreported charges and voice usage. Check Vercel AI Gateway for total spending.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
