// Top-level App composition. Reads tweaks, owns selection + expansion state.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#4ade80",
  "density": "regular",
  "drawer": true,
  "showLog": "all"
}/*EDITMODE-END*/;

// Drag-to-resize column separator. Parent owns the width state.
function ResizeHandle({ value, onChange, min = 280, max = 720, edge = 'left' }) {
  const [dragging, setDragging] = React.useState(false);
  const startRef = React.useRef({ x: 0, w: 0 });
  const onDown = (e) => {
    e.preventDefault();
    setDragging(true);
    document.body.classList.add('resizing');
    startRef.current = { x: e.clientX, w: value };
    const move = (ev) => {
      const dx = ev.clientX - startRef.current.x;
      const next = edge === 'left' ? startRef.current.w + dx : startRef.current.w - dx;
      onChange(Math.max(min, Math.min(max, next)));
    };
    const up = () => {
      setDragging(false);
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={'resize-handle' + (dragging ? ' dragging' : '')}
         onPointerDown={onDown}
         role="separator" aria-orientation="vertical" />
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [dirW, setDirW] = React.useState(400);
  const [drawerW, setDrawerW] = React.useState(460);

  // No selection by default. In a real app, persist last-selected per session.
  const [selectedId, setSelectedId] = React.useState(null);
  const [expanded, setExpanded] = React.useState({});
  const toggle = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const agent = window.AGENTS.find(a => a.id === selectedId) ?? null;

  // Live accent override via tweaks.
  const accentStyles = React.useMemo(() => ({
    '--accent': t.accent,
    '--accent-dim': hexA(t.accent, 0.18),
    '--accent-line': hexA(t.accent, 0.42),
    '--running': t.accent,
    '--approved': t.accent,
  }), [t.accent]);

  return (
    <div className="app" style={accentStyles}>
      <TopBar />
      <div className="body">
        <LeftRail active="agents" />

        <DirectorPane width={dirW} />
        <ResizeHandle value={dirW} onChange={setDirW} min={300} max={640} edge="left" />

        <AgentsPane
          selectedId={selectedId}
          onSelect={setSelectedId}
          expanded={expanded}
          onToggle={toggle}
        />

        {t.drawer && (
          <>
            <ResizeHandle value={drawerW} onChange={setDrawerW} min={340} max={680} edge="right" />
            <Drawer agent={agent} width={drawerW} />
          </>
        )}
      </div>
      <StatusBar />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme">
          <TweakColor
            label="Accent"
            value={t.accent}
            options={['#4ade80', '#60a5fa', '#f5b544', '#c084fc', '#f97316', '#e6e6ea']}
            onChange={(v) => setTweak('accent', v)}
          />
        </TweakSection>
        <TweakSection label="Layout">
          <TweakToggle
            label="Detail drawer"
            value={t.drawer}
            onChange={(v) => setTweak('drawer', v)}
          />
          <TweakRadio
            label="Density"
            value={t.density}
            options={['compact', 'regular', 'comfy']}
            onChange={(v) => setTweak('density', v)}
          />
          <TweakButton
            label="Reset layout"
            secondary
            onClick={() => { setDirW(400); setDrawerW(460); }}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

// Hex → rgba (3 or 6 digit).
function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h;
  const n = parseInt(x, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
