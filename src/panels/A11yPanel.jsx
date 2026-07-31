import React from 'react';

const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];
const scoreTone = (score) => (score >= 90 ? 'good' : score >= 60 ? 'warn' : 'bad');

export default function A11yPanel({ results, open, onClose, onFix }) {
  if (!open) return null;
  const violations = results?.violations || [];
  return (
    <aside className="a11y-panel" aria-label="Accessibility audit">
      <header className="a11y-header">
        <div><strong>Accessibility</strong><span>{violations.length ? `${violations.length} issues` : 'All clear'}</span></div>
        <button className="ghost" onClick={onClose} aria-label="Close accessibility audit">Close</button>
      </header>
      <div className={`a11y-score ${scoreTone(results?.score ?? 0)}`}><b>{results?.score ?? 0}</b><span>accessibility score</span></div>
      <div className="a11y-list">
        {violations.length === 0 && <p className="a11y-empty">No accessibility violations found in this preview.</p>}
        {SEVERITIES.map((severity) => {
          const items = violations.filter((v) => v.severity === severity);
          if (!items.length) return null;
          return <section className="a11y-group" key={severity}><h3>{severity}<span>{items.length}</span></h3>{items.map((violation, index) => <article className="a11y-violation" key={`${violation.id}-${index}`}><div className="a11y-violation-title"><strong>{violation.description}</strong><code>{violation.selector}</code></div><button className="a11y-fix" onClick={() => onFix?.(violation)}>Fix in canvas</button></article>)}</section>;
        })}
      </div>
    </aside>
  );
}
