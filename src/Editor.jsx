import { useEffect, useRef, useState } from 'react';
import { CLASSES, polygonArea } from '../shared/annotations.js';

export default function Editor({ record, tool, activeClass, selected, onSelect, onChange, draft, setDraft, finishRef, zoomRef, error }) {
  const frame = useRef(null);
  const svg = useRef(null);
  const drag = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [cursor, setCursor] = useState(null);
  const [editing, setEditing] = useState(null);
  const [space, setSpace] = useState(false);
  const fit = record ? Math.min((size.width - 64) / record.width, (size.height - 64) / record.height) : 1;
  const scale = Math.max(0.001, fit) * view.zoom;
  const offset = record ? { x: (size.width - record.width * scale) / 2 + view.x, y: (size.height - record.height * scale) / 2 + view.y } : { x: 0, y: 0 };

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setView({ zoom: 1, x: 0, y: 0 }); setEditing(null); setCursor(null); drag.current = null; }, [record?.id]);
  useEffect(() => {
    const down = (e) => { if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { e.preventDefault(); setSpace(true); } };
    const up = () => setSpace(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up); };
  }, []);

  const local = (event) => {
    const rect = svg.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const normalized = (event, clamp = false) => {
    const { x, y } = local(event);
    const px = (x - offset.x) / scale / record.width;
    const py = (y - offset.y) / scale / record.height;
    if (!clamp && (px < 0 || py < 0 || px > 1 || py > 1)) return null;
    return [Math.max(0, Math.min(1, px)), Math.max(0, Math.min(1, py))];
  };
  const zoom = (factor, anchor = { x: size.width / 2, y: size.height / 2 }) => {
    if (!record) return;
    setView((previous) => {
      const next = Math.min(20, Math.max(0.4, previous.zoom * factor));
      const previousScale = Math.max(0.001, fit) * previous.zoom;
      const nextScale = Math.max(0.001, fit) * next;
      const ox = (size.width - record.width * previousScale) / 2 + previous.x;
      const oy = (size.height - record.height * previousScale) / 2 + previous.y;
      return { zoom: next,
        x: anchor.x - (size.width - record.width * nextScale) / 2 - (anchor.x - ox) * nextScale / previousScale,
        y: anchor.y - (size.height - record.height * nextScale) / 2 - (anchor.y - oy) * nextScale / previousScale };
    });
  };
  useEffect(() => {
    const element = frame.current;
    const wheel = (event) => { event.preventDefault(); zoom(Math.exp(-event.deltaY * 0.002), local(event)); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });
  zoomRef.current = { in: () => zoom(1.3), out: () => zoom(1 / 1.3), fit: () => setView({ zoom: 1, x: 0, y: 0 }) };

  const finish = () => {
    if (draft.length < 3) { error('Add at least three points to finish a polygon.'); return; }
    if (polygonArea(draft) <= 1e-12) { error('Outline both edges so this polygon has a visible width.'); return; }
    const id = crypto.randomUUID();
    onChange([...record.annotations, { id, classId: activeClass, points: draft }]);
    setDraft([]); onSelect(id);
  };
  finishRef.current = finish;

  const pointerDown = (event) => {
    if (!record || (event.button !== 0 && event.button !== 1)) return;
    if (tool === 'pan' || space || event.button === 1) {
      event.preventDefault(); drag.current = { kind: 'pan', start: local(event), view };
      svg.current.setPointerCapture(event.pointerId); return;
    }
    if (tool === 'select') { onSelect(null); return; }
    if (event.detail > 1) return;
    const point = normalized(event);
    if (!point) return;
    // Thin strings put adjacent vertices very close together. Finish explicitly
    // with Enter/the button instead of snapping a nearby last vertex to the first.
    if (draft.length >= 500) { error('Maximum 500 points per polygon.'); return; }
    setDraft([...draft, point]);
  };
  const pointerMove = (event) => {
    if (!record) return;
    const action = drag.current;
    if (action?.kind === 'pan') {
      const now = local(event);
      setView({ ...action.view, x: action.view.x + now.x - action.start.x, y: action.view.y + now.y - action.start.y });
    } else if (action?.kind === 'vertex') {
      const point = normalized(event, true);
      setEditing({ ...action.shape, points: action.shape.points.map((p, i) => i === action.vertex ? point : p) });
    } else setCursor(normalized(event));
  };
  const pointerUp = () => {
    if (drag.current?.kind === 'vertex' && editing) {
      if (polygonArea(editing.points) <= 1e-12) error('That move would collapse the polygon.');
      else onChange(record.annotations.map((shape) => shape.id === editing.id ? editing : shape));
    }
    drag.current = null; setEditing(null);
  };
  const pointsText = (points) => points.map(([x, y]) => `${x * record.width},${y * record.height}`).join(' ');
  const visibleShapes = record?.annotations.map((shape) => editing?.id === shape.id ? editing : shape) || [];

  return <div ref={frame} className={`canvas-frame ${tool === 'draw' && !space ? 'drawing' : tool === 'pan' || space ? 'panning' : ''}`}>
    <svg ref={svg} className="annotation-canvas" role="application" aria-label="Image annotation canvas"
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setEditing(null); }}
      onPointerLeave={() => setCursor(null)} onDoubleClick={(e) => { if (tool === 'draw' && draft.length >= 3) { e.preventDefault(); finish(); } }}>
      {record && <g transform={`translate(${offset.x} ${offset.y}) scale(${scale})`}>
        <image href={`/api/images/${record.id}/file`} width={record.width} height={record.height} />
        {visibleShapes.map((shape) => <g key={shape.id}>
          <polygon data-shape-id={shape.id} points={pointsText(shape.points)} fill={CLASSES[shape.classId].color}
            fillOpacity={selected === shape.id ? 0.25 : 0.11} stroke={CLASSES[shape.classId].color} strokeWidth={selected === shape.id ? 2 : 1.3} vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: tool === 'select' && !space ? 'all' : 'none', cursor: 'pointer' }}
            onPointerDown={(e) => { e.stopPropagation(); onSelect(shape.id); }} />
          {selected === shape.id && tool === 'select' && shape.points.map(([x, y], index) =>
            <circle key={index} data-vertex={index} cx={x * record.width} cy={y * record.height} r={4.5 / scale}
              fill="#f1f6f1" stroke={CLASSES[shape.classId].color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: 'move' }}
              onPointerDown={(e) => { if (space || e.button !== 0) return; e.stopPropagation(); drag.current = { kind: 'vertex', shape, vertex: index }; setEditing(shape); svg.current.setPointerCapture(e.pointerId); }} />)}
        </g>)}
        {draft.length > 0 && <>
          <polyline points={pointsText(cursor ? [...draft, cursor] : draft)} fill={draft.length >= 3 ? CLASSES[activeClass].color : 'none'} fillOpacity={0.12}
            stroke={CLASSES[activeClass].color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />
          {draft.map(([x, y], i) => <circle key={i} cx={x * record.width} cy={y * record.height} r={(i === 0 ? 5.5 : 3.5) / scale}
            fill={i === 0 ? CLASSES[activeClass].color : '#eef3f1'} stroke="#18201e" strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />)}
        </>}
      </g>}
    </svg>
    {record && <>
      <div className="canvas-corner"><span className="live-dot" /> {tool === 'draw' ? `DRAWING ${CLASSES[activeClass].name.toUpperCase()}` : tool === 'select' ? 'EDIT POINTS' : 'PAN IMAGE'}</div>
      <div className="zoom-indicator">{Math.round(view.zoom * 100)}% <span>OF FIT</span></div>
      {draft.length > 0 && <div className="drawing-prompt"><span>{draft.length} points</span><button onClick={finish}>Finish polygon <kbd>↵</kbd></button><button onClick={() => setDraft([])}>Cancel <kbd>Esc</kbd></button></div>}
    </>}
  </div>;
}
