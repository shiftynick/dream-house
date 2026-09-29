import { useState } from 'react';
import { Check, Eye, LoaderCircle, X } from 'lucide-react';
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
    <section className="visual-alternatives" aria-label="Generate alternatives">
      <div className="visual-alternatives-heading">
        <div>
          <h3>Generate alternatives</h3>
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
          placeholder="Describe what to vary, such as courtyard layout or exterior materials."
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
            <option value={2}>2 alternatives</option>
            <option value={3}>3 alternatives</option>
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
              Generate {count} alternatives
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
            ? 'Generating and rendering alternatives…'
            : 'Applying selected design…'}
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
                    <Eye size={13} /> Preview in 3D
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
                    <Check size={14} /> Use this design
                  </button>
                </div>
              </article>
            ))}
          </div>
          <label className="field-label alternative-preference">
            Why do you prefer this design? <span>Optional</span>
            <input
              aria-label="Why you prefer this design"
              maxLength={1000}
              placeholder="Describe the features you prefer."
              value={model.preference}
              disabled={!!model.busy}
              onChange={(event) => model.setPreference(event.target.value)}
            />
          </label>
          <p className="visual-review-note">
            Applying a design saves every option as an alternative and records your preference in
            the design brief.
          </p>
        </>
      )}
    </section>
  );
}
