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
  Leaf,
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
import { api, type Status } from './api';
import { useVoice } from './useVoice';
import SceneView, { type Light, type Quality, type View } from './SceneView';
import { DEFAULT_MODELS, DEFAULT_SPEECH_VOICE } from '../shared/connections';
import {
  area,
  documentSchema,
  editProject,
  emptyScene,
  makeRoom,
  palettes,
  redo,
  sampleScene,
  undo,
  validateScene,
  type AgentResponse,
  type Project,
  type Room,
  type Scene,
} from '../shared/model';

const uid = () => crypto.randomUUID();
const qualityNames: Record<Quality, string> = {
  live: 'Live',
  refined: 'Light study',
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
function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const els = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select,textarea,[tabindex="0"]',
          ) || [],
        );
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">TERRAIN STUDIO</span>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
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
    <Modal
      title="A little intelligence, connected."
      subtitle="Your house lives here. Your chosen AI helps shape it."
      onClose={onClose}
    >
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
              One connection{' '}
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
            <h3>A voice for your ideas</h3>
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
  const [project, setProject] = useState<Project | null>(null),
    [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<Status | null>(null),
    [saved, setSaved] = useState<'saving' | 'saved' | 'error'>('saved');
  const [selected, setSelected] = useState<string | null>(null),
    [quality, setQuality] = useState<Quality>('live'),
    [view, setView] = useState<View>('orbit'),
    [light, setLight] = useState<Light>('golden'),
    [cutaway, setCutaway] = useState(false),
    [resetKey, setResetKey] = useState(0);
  const [modal, setModal] = useState<'connections' | 'versions' | 'help' | null>(null),
    [panel, setPanel] = useState<'spaces' | 'materials'>('spaces'),
    [partner, setPartner] = useState(true);
  const [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [renderStatus, setRenderStatus] = useState('Live rendering');
  const [pending, setPending] = useState<Scene | null>(null),
    [versionName, setVersionName] = useState(''),
    [compareId, setCompareId] = useState<string | null>(null),
    [compareSide, setCompareSide] = useState<'current' | 'saved'>('current');
  const [speech, setSpeech] = useState<'browser' | 'cloud' | 'off'>('cloud');
  const inputRef = useRef<HTMLTextAreaElement>(null),
    chatEnd = useRef<HTMLDivElement>(null),
    audio = useRef<HTMLAudioElement | null>(null),
    audioUrl = useRef<string | null>(null),
    speechRun = useRef(0),
    busyRef = useRef(false),
    projectRef = useRef(project),
    saveQueue = useRef(Promise.resolve()),
    saveRevision = useRef(0);
  projectRef.current = project;
  const notify = useCallback((text: string) => setError(text), []);
  const refreshStatus = useCallback(() => {
    api<Status>('status')
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    api<Project>('project')
      .then((data) => setProject(documentSchema.parse(data)))
      .catch((e) => setLoadError(e.message));
    refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    if (!project) return;
    const revision = ++saveRevision.current;
    setSaved('saving');
    const timer = setTimeout(() => {
      saveQueue.current = saveQueue.current
        .catch(() => {})
        .then(async () => {
          try {
            await api('project', { method: 'PUT', body: JSON.stringify(project) });
            if (revision === saveRevision.current) setSaved('saved');
          } catch (e) {
            if (revision === saveRevision.current) setSaved('error');
            notify(`Could not save: ${(e as Error).message}`);
          }
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [project, notify]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saved !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saved]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [project?.messages.length, busy]);
  const stopSpeech = useCallback(() => {
    speechRun.current++;
    window.speechSynthesis?.cancel();
    audio.current?.pause();
    if (audioUrl.current) {
      URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = null;
    }
  }, []);
  useEffect(() => () => stopSpeech(), [stopSpeech]);
  const speak = useCallback(
    async (text: string) => {
      stopSpeech();
      const run = speechRun.current;
      if (speech === 'off') return;
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
        const response = await fetch('/api/speak', {
          method: 'POST',
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
        notify((e as Error).message);
      }
    },
    [speech, notify, refreshStatus, stopSpeech],
  );
  const commit = useCallback(
    (scene: Scene) => {
      try {
        validateScene(scene);
        setProject((p) => (p ? editProject(p, scene) : p));
        setCompareId(null);
        setPending(null);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [notify],
  );
  const mutateRoom = (patch: Partial<Room>) => {
    if (!project || !selected) return;
    commit({
      ...project.scene,
      rooms: project.scene.rooms.map((r) => (r.id === selected ? { ...r, ...patch } : r)),
    });
  };
  const send = useCallback(
    async (text: string) => {
      text = text.trim();
      const current = projectRef.current;
      if (!text || !current || busyRef.current) return;
      if (pending) {
        notify('Keep or discard the proposed change before making another request.');
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
      const messages = [...current.messages, { id: uid(), role: 'user' as const, text }].slice(
        -100,
      );
      setProject((p) => (p ? { ...p, messages } : p));
      busyRef.current = true;
      setBusy(true);
      try {
        const result = await api<AgentResponse>('agent', {
          method: 'POST',
          body: JSON.stringify({ scene: current.scene, messages }),
        });
        setProject((p) => {
          if (!p) return p;
          const next = result.scene && !result.needsConfirmation ? editProject(p, result.scene) : p;
          return {
            ...next,
            messages: [
              ...next.messages,
              { id: uid(), role: 'assistant' as const, text: result.reply },
            ].slice(-100),
          };
        });
        if (result.scene && result.needsConfirmation) setPending(result.scene);
        if (result.scene) {
          setCompareId(null);
          setSelected(null);
          if (!current.scene.rooms.length) setResetKey((k) => k + 1);
        }
        void speak(result.reply);
      } catch (e) {
        notify((e as Error).message);
      } finally {
        busyRef.current = false;
        setBusy(false);
        refreshStatus();
      }
    },
    [status, pending, notify, refreshStatus, speak, stopSpeech],
  );
  const voice = useVoice({
    onText: send,
    onError: notify,
    enabled: !!status?.voiceConnected,
    busy: busy || !!modal || !!pending,
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'z' &&
        !busyRef.current &&
        !(e.target as HTMLElement).closest('input,textarea')
      ) {
        e.preventDefault();
        setPending(null);
        setProject((p) => (p ? (e.shiftKey ? redo(p) : undo(p)) : p));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const closeModal = useCallback(() => setModal(null), []);
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
    if (!project || !versionName.trim()) return;
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
        <h1>Your project needs attention.</h1>
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
  const selectedRoom = house.rooms.find((r) => r.id === selected);
  const comparison = project.variants.find((v) => v.id === compareId);
  const displayed = pending || (comparison && compareSide === 'saved' ? comparison.scene : house);
  const locked = busy || !!pending || !!comparison;
  return (
    <div className="app-shell">
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
          <span>{house.name}</span>
          <span className={`save-state ${saved === 'error' ? 'failed' : ''}`}>
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
                : 'Save failed'}
          </span>
        </div>
        <nav className="header-actions">
          <button className="text-button" onClick={() => setModal('versions')}>
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
          <div className="sidebar-top">
            <span className="eyebrow">YOUR PLACE IN THE WORLD</span>
            <h1>A home, imagined.</h1>
            <p>Make room for the way you live.</p>
          </div>
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
                  <span>THE HOUSE</span>
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
                    <div className="empty-room-icon">
                      <Square size={29} strokeWidth={1} />
                      <Plus size={12} />
                    </div>
                    <h3>Room for possibility.</h3>
                    <p>Your spaces will appear here as we bring your home to life.</p>
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
                            disabled={locked}
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
                    <button
                      className="text-button danger"
                      disabled={locked}
                      onClick={() => {
                        commit({ ...house, rooms: house.rooms.filter((r) => r.id !== selected) });
                        setSelected(null);
                      }}
                    >
                      <Trash2 size={13} /> Remove space
                    </button>
                  </div>
                )}
                <div className="site-card">
                  <div className="site-icon">
                    <Leaf size={19} />
                  </div>
                  <div>
                    <h3>Your hillside site</h3>
                    <p>
                      {house.slope === 0
                        ? 'Flat terrain'
                        : `${Math.round(house.slope * 100)}% gentle slope`}{' '}
                      · open surroundings
                    </p>
                  </div>
                </div>
                <label className="slope-control">
                  <span>
                    Land slope <b>{Math.round(house.slope * 100)}%</b>
                  </span>
                  <input
                    aria-label="Land slope"
                    type="range"
                    min="0"
                    max=".35"
                    step=".01"
                    disabled={locked}
                    value={house.slope}
                    onChange={(e) => commit({ ...house, slope: Number(e.target.value) })}
                  />
                </label>
              </>
            ) : (
              <>
                <div className="section-title">
                  <span>EXPLORE A FEELING</span>
                </div>
                <p className="panel-note">
                  Same house. A different character. Choose what feels like you.
                </p>
                <div className="material-options">
                  {Object.entries(palettes).map(([key, p]) => (
                    <button
                      className={`material-card ${house.palette === key ? 'selected' : ''}`}
                      key={key}
                      disabled={locked}
                      onClick={() => commit({ ...house, palette: key as Scene['palette'] })}
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
                <div className="section-title">
                  <span>ROOF PROFILE</span>
                </div>
                <div className="segmented">
                  <button
                    disabled={locked}
                    className={house.roof === 'flat' ? 'active' : ''}
                    onClick={() => commit({ ...house, roof: 'flat' })}
                  >
                    Flat
                  </button>
                  <button
                    disabled={locked}
                    className={house.roof === 'pitched' ? 'active' : ''}
                    onClick={() => commit({ ...house, roof: 'pitched' })}
                  >
                    Pitched
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="sidebar-bottom">
            <span className="local-dot" />
            <span>Made here. Saved here.</span>
            <span className="local-tag">LOCAL</span>
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
                label="Toggle design partner"
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
              onSelect={setSelected}
              onRenderStatus={setRenderStatus}
              resetKey={resetKey}
            />
            {!house.rooms.length && !pending && view !== 'plan' && (
              <div className="welcome-overlay">
                <span className="eyebrow">
                  <span /> A BLANK CANVAS, A BEAUTIFUL POSSIBILITY
                </span>
                <h2>
                  It starts with
                  <br />a place to <em>call home.</em>
                </h2>
                <p>
                  Describe the home in your head.
                  <br />
                  We’ll find its shape, together.
                </p>
                <button
                  className="welcome-button"
                  onClick={() => {
                    setPartner(true);
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                >
                  Tell me about your home <ArrowRight size={15} />
                </button>
                <button
                  className="sample-button"
                  disabled={busy}
                  onClick={() => {
                    commit(sampleScene());
                    setResetKey((k) => k + 1);
                  }}
                >
                  Or explore a sample house <ChevronRight size={12} />
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
                <span>Finding the shape of your idea…</span>
              </div>
            )}
            {pending && (
              <div className="proposal-bar">
                <Sparkles size={17} />
                <span>Previewing a proposed change</span>
                <button className="text-button" onClick={() => setPending(null)}>
                  Discard
                </button>
                <button className="primary small" onClick={() => commit(pending)}>
                  <Check size={14} /> Keep this
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
                    ? 'Drag to orbit · Scroll to explore · Right-drag to pan'
                    : 'Select a space for dimensions'}
              </span>
            </div>
          </div>
          <footer className="workspace-footer">
            <span>
              <span className="tiny-dot" />{' '}
              {house.rooms.length
                ? `${house.rooms.length} spaces · ${area(house).toFixed(0)} m² interior`
                : 'Your story starts here'}
            </span>
            <span>
              CONCEPT DESIGN <span className="footer-cross">✳</span> ENDLESS POSSIBILITY
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
                <h2>Your design partner</h2>
                <p>
                  <span className={status?.modelConnected ? 'online-dot' : 'offline-dot'} />
                  {status?.modelConnected ? 'Gateway key configured' : 'Let’s get connected'}
                </p>
              </div>
              <IconButton label="Hide design partner" onClick={() => setPartner(false)}>
                <X size={15} />
              </IconButton>
            </div>
            <div className="conversation">
              <div className="partner-intro">
                <span className="eyebrow">A CONVERSATION, NOT A FLOOR PLAN</span>
                <h3>
                  You bring the dream.
                  <br />
                  We’ll find the details.
                </h3>
                <p>
                  Start anywhere. A feeling, a room, a view you’d love to wake up to. You don’t need
                  the right words.
                </p>
              </div>
              {!project.messages.length && (
                <>
                  <div className="assistant-message">
                    <span className="mini-spark">
                      <Sparkles size={13} />
                    </span>
                    <div>What do you picture when you think of home?</div>
                  </div>
                  <div className="prompt-chips">
                    {[
                      'A hillside home with an open kitchen overlooking a two-story living room',
                      'Something quiet, warm, and full of natural light',
                      'A home wrapped around a garden courtyard',
                    ].map((prompt, i) => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setInput(prompt);
                          inputRef.current?.focus();
                        }}
                      >
                        {
                          [
                            'Start with the layout',
                            'Start with a feeling',
                            'Start with the outdoors',
                          ][i]
                        }
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
                  <div>{m.text}</div>
                </div>
              ))}
              {busy && (
                <div className="assistant-message">
                  <span className="mini-spark">
                    <Sparkles size={13} />
                  </span>
                  <div className="thinking-dots">
                    <i />
                    <i />
                    <i />
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
                  placeholder="Tell me what you’re imagining…"
                  value={input}
                  disabled={busy || !!pending}
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
                    disabled={busy || !!pending || voice.state === 'transcribing'}
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
                    disabled={!input.trim() || busy || !!pending}
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
            </div>
          </aside>
        )}
      </div>
      {error && (
        <div className="toast" role="alert">
          <CircleHelp size={18} />
          <span>{error}</span>
          {saved === 'error' && (
            <button className="text-button" onClick={() => setProject((p) => (p ? { ...p } : p))}>
              Retry save
            </button>
          )}
          <button aria-label="Dismiss message" className="tiny-button" onClick={() => setError('')}>
            <X size={16} />
          </button>
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
      {modal === 'versions' && (
        <Modal
          title="Room for another possibility."
          subtitle="Keep the ideas you love. Try a different direction."
          onClose={closeModal}
          wide
        >
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
              placeholder="Name this moment. ‘Courtyard idea’, perhaps…"
              value={versionName}
              onChange={(e) => setVersionName(e.target.value)}
            />
            <button className="primary" disabled={!versionName.trim() || busy}>
              <Plus size={15} /> Save alternative
            </button>
          </form>
          <div className="version-list">
            {!project.variants.length ? (
              <div className="empty-versions">
                <GitBranch size={29} strokeWidth={1} />
                <h3>Every good idea deserves a place.</h3>
                <p>Save your current design above, then explore something new.</p>
              </div>
            ) : (
              project.variants.map((v) => (
                <div className="version-card" key={v.id}>
                  <div
                    className="version-thumbnail"
                    style={{ background: palettes[v.scene.palette].wall }}
                  >
                    <House size={28} strokeWidth={1} />
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
                    disabled={busy}
                    onClick={() => {
                      commit(structuredClone(v.scene));
                      closeModal();
                    }}
                  >
                    Restore
                  </button>
                  <IconButton
                    label={`Delete alternative ${v.name}`}
                    disabled={busy}
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
              disabled={busy}
              onClick={() => {
                commit(structuredClone(emptyScene));
                setSelected(null);
                closeModal();
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
                  if (!file || busy) return;
                  try {
                    const incoming = documentSchema.parse(JSON.parse(await file.text()));
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
        <Modal
          title="Make yourself at home."
          subtitle="A few small gestures. A world of possibilities."
          onClose={closeModal}
        >
          <div className="help-list">
            <p>
              <kbd>Space</kbd>
              <span>Hold to speak when you’re not typing. Release to send.</span>
            </p>
            <p>
              <kbd>↵</kbd>
              <span>Send a typed idea. Shift + Enter adds a new line.</span>
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
            <h3>Try saying it simply.</h3>
            <p>
              “Make the living room wider.” “Give the bedrooms more privacy.” “Use darker wood
              outside.”
            </p>
            <p>
              Local commands: “undo”, “redo”, “show wireframe”, “show floor plan”, “show exterior”,
              “walk inside”, “hide roof”, “show roof”.
            </p>
            <h3>A study, not a building plan.</h3>
            <p>
              Terrain explores rectangular spaces and architectural character. Layouts need review
              for access, structure, and construction. Light study progressively traces the same 3D
              scene; it can take a moment to settle.
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
