import { useState } from 'react';
import { ArrowRight, Check, Eye, LoaderCircle, Sparkles, X } from 'lucide-react';
import type { useVisualAlternatives } from './useVisualAlternatives';

export default function VisualAlternatives({
  model,
  disabled,
  renderReady,
  onPreview,
}: {
  model: ReturnType<typeof useVisualAlternatives>;
  disabled: boolean;
  renderReady: boolean;
  onPreview: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState<2 | 3>(2);
  return (
    <section className="visual-alternatives" aria-label="Explore visual alternatives">
      <div className="visual-alternatives-heading">
        <Sparkles size={18} />
        <div>
          <h3>Discover what feels like home.</h3>
          <p>See a few directions, then tell us which one speaks to you.</p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !model.busy) void model.generate(prompt, count);
        }}
      >
        <textarea
          aria-label="Describe visual alternatives"
          placeholder="Try two ways to make the courtyard feel more private…"
          rows={3}
          maxLength={2000}
          value={prompt}
          disabled={disabled || !!model.busy}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="alternative-form-actions">
          <select
            aria-label="Number of visual alternatives"
            value={count}
            disabled={disabled || !!model.busy}
            onChange={(event) => setCount(Number(event.target.value) as 2 | 3)}
          >
            <option value={2}>Two directions</option>
            <option value={3}>Three directions</option>
          </select>
          {model.busy === 'generating' ? (
            <button type="button" className="text-button" onClick={model.cancel}>
              <X size={13} /> Cancel generation
            </button>
          ) : (
            <button
              className="primary small"
              disabled={disabled || !renderReady || !prompt.trim() || !!model.busy}
            >
              <Sparkles size={14} /> Generate {count} choices
            </button>
          )}
        </div>
      </form>
      {!renderReady && (
        <p className="visual-review-note">
          Connecting the local renderer before generating previews…
        </p>
      )}
      {model.busy && (
        <p className="alternative-progress" role="status">
          <LoaderCircle className="spin" size={15} />
          {model.busy === 'generating'
            ? 'Designing and rendering your alternatives…'
            : 'Keeping your chosen direction…'}
        </p>
      )}
      {model.error && (
        <p className="inline-error" role="alert">
          {model.error}
        </p>
      )}
      {model.choices && (
        <>
          <div className="alternative-choice-grid">
            {model.choices.options.map((option) => (
              <article className="alternative-choice" key={option.id}>
                <button
                  className="alternative-image"
                  disabled={!!model.busy}
                  aria-label={`Preview ${option.name}`}
                  onClick={() => {
                    model.setPreview(option);
                    onPreview();
                  }}
                >
                  <img src={option.thumbnail} alt={option.name} />
                  <span>
                    <Eye size={13} /> Explore in 3D
                  </span>
                </button>
                <div className="alternative-choice-body">
                  <h4>{option.name}</h4>
                  <p>{option.description}</p>
                  {option.issues.length > 0 && (
                    <details>
                      <summary>{option.issues.length} design notes</summary>
                      {option.issues.map((issue, index) => (
                        <p key={index}>{issue.message}</p>
                      ))}
                    </details>
                  )}
                  <button
                    className="text-button"
                    disabled={disabled || !!model.busy}
                    onClick={() => void model.choose(option.id, model.preference)}
                  >
                    <Check size={14} /> Choose this direction
                    <ArrowRight size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          <label className="field-label alternative-preference">
            What do you like about your choice? <span>Optional</span>
            <input
              aria-label="Why you prefer this design"
              maxLength={1000}
              placeholder="The warmer materials and sheltered outdoor space…"
              value={model.preference}
              disabled={!!model.busy}
              onChange={(event) => model.setPreference(event.target.value)}
            />
          </label>
          <p className="visual-review-note">
            Choosing applies one design, saves every option as an alternative, and remembers your
            preference in the brief.
          </p>
        </>
      )}
    </section>
  );
}
