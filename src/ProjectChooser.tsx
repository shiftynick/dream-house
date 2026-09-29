import { useEffect, useState } from 'react';
import { ArrowRight, Check, House, LoaderCircle, Plus } from 'lucide-react';
import { api, type ProjectDirectory } from './api';
import Modal from './Modal';

export default function ProjectChooser({
  onClose,
  onCreate,
  onOpen,
  busy,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  busy: boolean;
}) {
  const [directory, setDirectory] = useState<ProjectDirectory | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<ProjectDirectory>('projects')
      .then((value) => {
        if (active) setDirectory(value);
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (operation: () => Promise<void>) => {
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <Modal
      title="Projects"
      subtitle="Each house has its own conversation, design brief, alternatives, and history."
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form
        className="project-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && name.trim()) void run(() => onCreate(name.trim()));
        }}
      >
        <label className="field-label">
          Project name
          <input
            aria-label="New house name"
            maxLength={100}
            placeholder="New house name"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} New house
        </button>
      </form>
      <p className="project-preservation-note">
        Your current house is saved before switching. You can return to it here.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="project-library">
        {!directory && !error && (
          <span className="project-loading">
            <LoaderCircle size={16} className="spin" /> Loading projects…
          </span>
        )}
        {directory?.projects.map((project) => (
          <button
            className={`project-library-card ${directory.activeProjectId === project.id ? 'current' : ''}`}
            key={project.id}
            disabled={busy || directory.activeProjectId === project.id}
            onClick={() => void run(() => onOpen(project.id))}
          >
            <span className="project-library-icon">
              <House size={23} strokeWidth={1.3} />
            </span>
            <span>
              <strong>{project.name}</strong>
              <small>{project.rooms} spaces</small>
            </span>
            {directory.activeProjectId === project.id ? (
              <span className="project-current">
                <Check size={13} /> Open
              </span>
            ) : (
              <ArrowRight size={16} />
            )}
          </button>
        ))}
      </div>
    </Modal>
  );
}
