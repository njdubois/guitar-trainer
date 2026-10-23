import { useEffect, useRef, useState } from 'react';
import { Upload, Download, Plus, PenTool, MousePointer2, Hand, Undo2, Redo2, ZoomIn, ZoomOut, Scan, Check, CheckCheck, ChevronLeft, ChevronRight, Trash2, X, Info, Folder, Image as ImageIcon, Layers, ShieldCheck, LoaderCircle, Search, Save, ArrowUpRight, Guitar } from 'lucide-react';
import { CLASSES } from '../shared/annotations.js';
import Editor from './Editor.jsx';

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    if (response.status === 401) throw new Error('Sign-in expired. Refresh this page to sign in again.');
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

function EmptyIllustration() {
  return <svg viewBox="0 0 330 190" className="empty-illustration" aria-hidden="true">
    <defs><linearGradient id="neck" x2="1" y2="1"><stop stopColor="#3c4741" /><stop offset="1" stopColor="#29322e" /></linearGradient></defs>
    <g transform="translate(25 57) rotate(11 140 35)">
      <path d="M3 8 L278 0 L285 78 L0 68 Z" fill="url(#neck)" stroke="#667b6b" />
      {[48, 92, 130, 165, 197, 225, 250].map((x) => <path key={x} d={`M${x} 8 L${x + 3} 69`} stroke="#a98e65" strokeWidth="2" />)}
      {[17, 26, 35, 44, 53, 62].map((y) => <path key={y} d={`M0 ${y} L280 ${y - 5}`} stroke="#b6c4b7" strokeWidth="0.8" />)}
      <circle cx="112" cy="35" r="4" fill="#9aa99a" /><circle cx="182" cy="35" r="4" fill="#9aa99a" />
      <path d="M48 7 L93 6 L96 69 L51 69 Z" fill="#83b9ef" fillOpacity=".13" stroke="#83b9ef" strokeDasharray="4 3" />
      {[[48, 7], [93, 6], [96, 69], [51, 69]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" fill="#a6d2ff" />)}
    </g>
    <path d="M241 114 L241 137 L248 132 L254 144 L260 141 L253 129 L262 128 Z" fill="#d4e7cd" stroke="#171e1b" strokeWidth="2" />
  </svg>;
}

export default function App() {
  const [images, setImages] = useState([]);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState('draw');
  const [activeClass, setActiveClass] = useState(0);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState([]);
  const [undo, setUndo] = useState([]);
  const [redo, setRedo] = useState([]);
  const [session, setSession] = useState('session-01');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [toast, setToast] = useState(null);
  const [guide, setGuide] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileInput = useRef(null);
  const finish = useRef(null);
  const zoom = useRef(null);
  const selectionRequest = useRef(0);
  const toastTimer = useRef(null);
  const notify = (message, type = 'error') => { setToast({ message, type }); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 6500); };
  const updateList = (image) => setImages((old) => old.map((item) => item.id === image.id ? { ...image, annotationCount: image.annotations.length } : item));

  const selectImage = async (id, skipConfirm = false) => {
    if (!skipConfirm && (dirty || draft.length) && !window.confirm('Discard unsaved changes and open another image?')) return;
    const token = ++selectionRequest.current;
    setLoading(true);
    try {
      const next = await request(`/api/images/${id}`);
      if (token !== selectionRequest.current) return;
      setRecord(next); setDirty(false); setDraft([]); setSelected(null); setUndo([]); setRedo([]);
    } catch (e) { notify(e.message); }
    finally { if (token === selectionRequest.current) setLoading(false); }
  };
  useEffect(() => {
    request('/api/images').then(async (items) => {
      setImages(items);
      if (items.length) await selectImage(items[0].id, true);
    }).catch((e) => notify(e.message)).finally(() => setLoading(false));
    return () => clearTimeout(toastTimer.current);
  }, []);
  useEffect(() => {
    const unload = (event) => { if (dirty || draft.length) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty, draft.length]);
  useEffect(() => {
    if (!guide) return;
    const previous = document.activeElement;
    const modal = document.querySelector('.guide-modal');
    const focusable = [...modal.querySelectorAll('button, [href], input, select, [tabindex="0"]')];
    focusable[0]?.focus();
    const key = (e) => {
      if (e.key === 'Escape') setGuide(false);
      if (e.key === 'Tab') {
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); previous?.focus(); };
  }, [guide]);

  const changeAnnotations = (annotations) => {
    setUndo((old) => [...old.slice(-49), record.annotations]); setRedo([]);
    setRecord({ ...record, annotations, reviewed: false, negative: annotations.length ? false : record.negative }); setDirty(true);
  };
  const history = (direction) => {
    const source = direction === 'undo' ? undo : redo;
    if (!source.length || !record) return;
    const next = source[source.length - 1];
    if (direction === 'undo') { setUndo(source.slice(0, -1)); setRedo([...redo, record.annotations]); }
    else { setRedo(source.slice(0, -1)); setUndo([...undo, record.annotations]); }
    setRecord({ ...record, annotations: next, reviewed: false, negative: false }); setDirty(true); setSelected(null);
  };
  const removeShape = () => {
    if (selected && record) { changeAnnotations(record.annotations.filter((shape) => shape.id !== selected)); setSelected(null); }
  };
  const save = async (reviewed = record?.reviewed) => {
    if (!record || saving) return;
    if (draft.length) { notify('Finish or cancel the current polygon before saving.'); return; }
    setSaving(true);
    try {
      const saved = await request(`/api/images/${record.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...record, reviewed }) });
      setRecord(saved); updateList(saved); setDirty(false);
      notify(reviewed ? 'Reviewed and saved. This image is ready to export.' : 'Draft saved.', 'success');
    } catch (e) { notify(e.message); }
    finally { setSaving(false); }
  };
  const chooseClass = (id) => {
    if (draft.length && activeClass !== id) { notify('Finish or cancel the polygon before changing labels.'); return; }
    setActiveClass(id); setTool('draw');
  };
  const currentIndex = images.findIndex((image) => image.id === record?.id);
  const navigate = (offset) => { const next = images[currentIndex + offset]; if (next) selectImage(next.id); };

  useEffect(() => {
    const key = (event) => {
      if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || guide || saving || busy || loading) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      else if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey ? 'redo' : 'undo'); }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); history('redo'); }
      else if (!modifier && /^[1-4]$/.test(event.key)) chooseClass(Number(event.key) - 1);
      else if (event.key === 'Enter' && draft.length) { event.preventDefault(); finish.current?.(); }
      else if (event.key === 'Escape') { setDraft([]); setSelected(null); }
      else if ((event.key === 'Delete' || event.key === 'Backspace') && !draft.length && selected) { event.preventDefault(); removeShape(); }
      else if (event.key === 'Backspace' && draft.length) { event.preventDefault(); setDraft(draft.slice(0, -1)); }
      else if (!modifier && event.key.toLowerCase() === 'v') setTool('select');
      else if (!modifier && event.key.toLowerCase() === 'p') setTool('draw');
      else if (!modifier && event.key.toLowerCase() === 'h') setTool('pan');
      else if (!modifier && event.key.toLowerCase() === 'f') zoom.current?.fit();
      else if (event.key === 'ArrowRight' && !draft.length) navigate(1);
      else if (event.key === 'ArrowLeft' && !draft.length) navigate(-1);
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const uploadImages = async (files) => {
    if (!files.length || busy) return;
    if ((dirty || draft.length) && !window.confirm('Discard unsaved changes before uploading?')) return;
    setBusy(true); let first = null; let added = 0; const failures = [];
    for (let i = 0; i < files.length; i++) {
      setProgress({ current: i + 1, total: files.length });
      const form = new FormData(); form.append('session', session); form.append('image', files[i]);
      try {
        const image = await request('/api/images', { method: 'POST', body: form });
        setImages((old) => [...old, { ...image, annotationCount: 0 }]); first ||= image; added++;
      } catch (e) { failures.push(`${files[i].name}: ${e.message}`); }
    }
    if (first) await selectImage(first.id, true);
    if (failures.length) notify(`${added} uploaded. ${failures[0]}${failures.length > 1 ? ` (${failures.length} failed)` : ''}`);
    else notify(`${added} image${added === 1 ? '' : 's'} uploaded. Start with the guitar outline.`, 'success');
    setProgress(null); setBusy(false);
  };
  const deleteImage = async () => {
    if (!record || !window.confirm(`Permanently delete ${record.originalName} and its annotations?`)) return;
    setBusy(true);
    try {
      await request(`/api/images/${record.id}`, { method: 'DELETE' });
      const remaining = images.filter((image) => image.id !== record.id);
      setImages(remaining); setRecord(null); setDirty(false); setDraft([]);
      if (remaining.length) await selectImage(remaining[Math.min(currentIndex, remaining.length - 1)].id, true);
      notify('Image deleted.', 'success');
    } catch (e) { notify(e.message); }
    finally { setBusy(false); }
  };
  const exportDataset = async () => {
    if (dirty || draft.length) { notify('Save or discard your current changes before exporting.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/export');
      if (!response.ok) throw new Error((await response.json()).error || 'Export failed.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'guitar-ar-annotations.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('Export downloaded. Images and YOLO labels are ready for training.', 'success');
    } catch (e) { notify(e.message); }
    finally { setBusy(false); }
  };
  const reviewedCount = images.filter((image) => image.reviewed).length;
  const filtered = images.filter((image) => (filter === 'all' || (filter === 'reviewed' ? image.reviewed : !image.reviewed)) && `${image.originalName} ${image.session}`.toLowerCase().includes(query.toLowerCase()));
  const selectedShape = record?.annotations.find((shape) => shape.id === selected);
  const disabled = busy || saving || loading;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><div className="brand-icon"><Guitar size={21} /></div><div><strong>Fretboard<span> Studio</span></strong><small>GUITAR AR · DATASET WORKSPACE</small></div></div>
      <div className="header-right"><span className="private-badge"><ShieldCheck size={13} /> Private workspace</span><button className="button subtle guide-button" onClick={() => setGuide(true)}><Info size={15} /> Quick guide</button><button className="button export-button" disabled={!reviewedCount || disabled} onClick={exportDataset}><Download size={15} /> Export dataset <span>{reviewedCount}</span></button></div>
    </header>
    <div className={`workspace ${disabled ? 'busy' : ''}`}>
      <aside className="library">
        <div className="library-heading"><div><span className="eyebrow">YOUR DATASET</span><h2>Image library <span>{images.length.toString().padStart(2, '0')}</span></h2></div></div>
        <div className="upload-section"><label htmlFor="upload-session">Recording session <Info size={12} /></label><div className="session-input"><Folder size={14} /><input id="upload-session" value={session} onChange={(e) => setSession(e.target.value)} placeholder="session-01" maxLength={64} disabled={disabled} /></div>
          <button className="button upload-button" onClick={() => fileInput.current.click()} disabled={disabled}>{busy && progress ? <LoaderCircle size={16} className="spin" /> : <Plus size={17} />}{progress ? `Uploading ${progress.current} / ${progress.total}` : 'Upload images'}</button>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple className="visually-hidden" onChange={(e) => { uploadImages([...e.target.files]); e.target.value = ''; }} />
          <p>JPG, PNG, WebP · up to 20 MB each</p></div>
        <div className="library-filters"><div className="search-input"><Search size={13} /><input aria-label="Search images" placeholder="Find an image…" value={query} onChange={(e) => setQuery(e.target.value)} /></div><div className="filter-tabs">{[['all', 'All'], ['pending', 'To review'], ['reviewed', 'Reviewed']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
        <div className="image-list">{filtered.length ? filtered.map((image, i) => <button key={image.id} className={`image-card ${record?.id === image.id ? 'active' : ''}`} disabled={disabled} onClick={() => { if (record?.id !== image.id) selectImage(image.id); }}>
          <div className="thumbnail-wrap"><img src={`/api/images/${image.id}/thumbnail`} alt="" loading="lazy" />{image.reviewed && <span className="thumbnail-check"><Check size={11} /></span>}</div><div className="image-card-text"><strong title={image.originalName}>{image.originalName}</strong><span>{image.session}</span><small>{image.annotationCount} regions <i>·</i> {image.reviewed ? 'Reviewed' : 'To review'}</small></div></button>) : <div className="library-empty"><ImageIcon size={25} strokeWidth={1.2} /><p>{images.length ? 'No matching images.' : 'Your images will appear here.'}</p></div>}</div>
        <div className="dataset-progress"><div><span>Review progress</span><strong>{reviewedCount} <span>/ {images.length}</span></strong></div><div className="progress-track"><div style={{ width: `${images.length ? reviewedCount / images.length * 100 : 0}%` }} /></div><small>Only reviewed images are exported.</small></div>
      </aside>

      <main className="editor-panel">
        <div className="editor-topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{record?.originalName || 'Start a new annotation'}</strong>{record && <span className={`status-pill ${dirty ? 'unsaved' : record.reviewed ? 'reviewed' : ''}`}>{dirty ? 'Unsaved' : record.reviewed ? 'Reviewed' : 'Draft'}</span>}</div><button className="icon-button" title="Delete image" aria-label="Delete image" disabled={!record || disabled} onClick={deleteImage}><Trash2 size={15} /></button></div>
        <div className="editor-toolbar"><div className="tool-group">{[['draw', PenTool, 'Draw polygon (P)'], ['select', MousePointer2, 'Select and edit points (V)'], ['pan', Hand, 'Pan image (H)']].map(([value, Icon, label]) => <button key={value} className={`icon-button ${tool === value ? 'active' : ''}`} aria-label={label} title={label} disabled={disabled} onClick={() => setTool(value)}><Icon size={17} /></button>)}<span className="toolbar-divider" /><button className="icon-button" aria-label="Undo" title="Undo (⌘/Ctrl Z)" disabled={!undo.length || disabled || draft.length > 0} onClick={() => history('undo')}><Undo2 size={16} /></button><button className="icon-button" aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)" disabled={!redo.length || disabled || draft.length > 0} onClick={() => history('redo')}><Redo2 size={16} /></button></div>
          <div className="active-label"><span style={{ background: CLASSES[activeClass].color }} />{CLASSES[activeClass].title}<small>POLYGON</small></div><div className="tool-group"><button className="icon-button" aria-label="Zoom out" disabled={!record || disabled} onClick={() => zoom.current?.out()}><ZoomOut size={16} /></button><button className="icon-button" aria-label="Zoom in" disabled={!record || disabled} onClick={() => zoom.current?.in()}><ZoomIn size={16} /></button><button className="icon-button" aria-label="Fit image" title="Fit image (F)" disabled={!record || disabled} onClick={() => zoom.current?.fit()}><Scan size={16} /></button></div></div>
        <div className="editor-surface" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); uploadImages([...e.dataTransfer.files]); }}>
          <Editor record={record} tool={tool} activeClass={activeClass} selected={selected} onSelect={setSelected} onChange={changeAnnotations} draft={draft} setDraft={setDraft} finishRef={finish} zoomRef={zoom} error={notify} />
          {!record && !loading && <div className="empty-canvas"><div className="empty-kicker"><span /> YOUR NEXT MODEL STARTS HERE</div><EmptyIllustration /><h1>Teach it to see the fretboard.</h1><p>Upload a playing-view photo, trace the parts,<br />and build a dataset made for guitar AR.</p><button className="button primary" onClick={() => fileInput.current.click()} disabled={disabled}><Upload size={16} /> Upload your first images <ArrowUpRight size={15} /></button><span className="drop-hint">or drop images into this workspace</span><div className="empty-steps"><span><i>01</i> Upload</span><span><i>02</i> Outline</span><span><i>03</i> Review & export</span></div></div>}
          {loading && <div className="canvas-loading"><LoaderCircle className="spin" size={23} /><span>Loading workspace…</span></div>}
          {(busy || saving) && record && <div className="interaction-shield" aria-label="Saving or uploading" />}
        </div>
        <footer className="editor-footer"><div className="canvas-hint"><span className="keyboard-mini">↵</span> Finish <span className="keyboard-mini">esc</span> Cancel <span className="keyboard-mini">space</span> Pan</div><div>{record ? `${record.width.toLocaleString()} × ${record.height.toLocaleString()} px` : 'FULL-RESOLUTION ANNOTATION'}<span className="footer-dot">·</span>{record ? `${record.annotations.length} regions` : '4 LABEL CLASSES'}</div></footer>
        <div className="editor-actions"><div className="image-pagination"><button className="icon-button" aria-label="Previous image" disabled={currentIndex <= 0 || disabled} onClick={() => navigate(-1)}><ChevronLeft size={17} /></button><span>{record ? `${currentIndex + 1} of ${images.length}` : 'No image selected'}</span><button className="icon-button" aria-label="Next image" disabled={currentIndex < 0 || currentIndex >= images.length - 1 || disabled} onClick={() => navigate(1)}><ChevronRight size={17} /></button></div><div className="save-actions"><button className="button subtle" disabled={!record || !dirty || disabled || !!draft.length} onClick={() => save()}><Save size={15} /> Save draft</button><button className="button primary" disabled={!record || disabled || !!draft.length || record.reviewed && !dirty} onClick={() => save(true)}>{saving ? <LoaderCircle size={15} className="spin" /> : <CheckCheck size={16} />}{record?.reviewed && !dirty ? 'Reviewed' : 'Review & save'}</button></div></div>
      </main>

      <aside className="inspector"><div className="inspector-title"><Layers size={16} /><h2>Annotation labels</h2><span>4</span></div><p className="inspector-intro">Choose a part, then click around its edges.</p><div className="class-list">{CLASSES.map((item) => <button key={item.id} className={`class-button ${activeClass === item.id && tool === 'draw' ? 'active' : ''}`} style={{ '--class-color': item.color }} disabled={disabled} onClick={() => chooseClass(item.id)}><span className="class-swatch" /><div><strong>{item.title}</strong><small>{item.description}</small></div><kbd>{item.id + 1}</kbd></button>)}</div>
        <div className="regions-header"><span>REGIONS</span><span>{record?.annotations.length || 0}</span></div><div className="regions-list">{record?.annotations.length ? record.annotations.map((shape, i) => <button key={shape.id} className={`region-row ${selected === shape.id ? 'selected' : ''}`} onClick={() => { setSelected(shape.id); setTool('select'); }} disabled={disabled}><span className="region-dot" style={{ background: CLASSES[shape.classId].color }} /><span>{CLASSES[shape.classId].title} <small>{String(i + 1).padStart(2, '0')}</small></span><small>{shape.points.length} pts</small></button>) : <div className="regions-empty"><PenTool size={19} /><p>Your outlines will appear here.</p><small>Click points around a part.<br />Press Enter to close the polygon.</small></div>}</div>
        {selectedShape && <div className="selection-details"><label>Selected region label<select aria-label="Selected region label" value={selectedShape.classId} disabled={disabled} onChange={(e) => changeAnnotations(record.annotations.map((shape) => shape.id === selected ? { ...shape, classId: Number(e.target.value) } : shape))}>{CLASSES.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><button className="button danger-text" disabled={disabled} onClick={removeShape}><Trash2 size={13} /> Delete region</button><small>Drag a corner point to refine the outline.</small></div>}
        {record && <div className="image-options"><label>Image session<input aria-label="Image session" value={record.session} disabled={disabled} maxLength={64} onChange={(e) => { setRecord({ ...record, session: e.target.value, reviewed: false }); setDirty(true); }} /></label><label className="negative-toggle"><input type="checkbox" checked={record.negative} disabled={disabled || !!record.annotations.length} onChange={(e) => { setRecord({ ...record, negative: e.target.checked, reviewed: false }); setDirty(true); }} /><span>No guitar parts in this image<small>Explicit negative training example</small></span></label></div>}
        <div className="annotation-tip"><div><Info size={14} /><strong>A little precision goes a long way.</strong></div><p>Trace each fret and string separately. Outline both edges of thin parts. Overlapping regions are expected.</p><button onClick={() => setGuide(true)}>Read the annotation guide <ArrowUpRight size={12} /></button></div>
      </aside>
    </div>
    {toast && <div role="status" className={`toast ${toast.type}`}><span>{toast.type === 'success' ? <Check size={17} /> : <Info size={17} />}</span><p>{toast.message}</p><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {guide && <div className="modal-backdrop" onClick={() => setGuide(false)}><section className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title" onClick={(e) => e.stopPropagation()}><button className="icon-button modal-close" aria-label="Close guide" onClick={() => setGuide(false)}><X size={19} /></button><span className="eyebrow">A QUICK FIELD GUIDE</span><h2 id="guide-title">Good labels. Better recognition.</h2><p>Work from the largest outline to the smallest detail.</p><ol>{CLASSES.map((c) => <li key={c.id}><span style={{ color: c.color }}>0{c.id + 1}</span><div><strong>{c.title}</strong><p>{c.description} {c.id === 0 ? 'Include the visible neck when the body is outside the frame.' : c.id === 1 ? 'Keep its outline separate from the guitar outline.' : c.id === 2 ? 'Label the metal wire with a narrow polygon.' : 'Zoom in and trace both edges of each visible section.'}</p></div></li>)}</ol><div className="guide-note"><Info size={17} /><p>Annotate all visible target parts. Use separate polygons for sections hidden by fingers. Generic fret and string labels do not assign fret numbers or string identities.</p></div><p className="guide-session">Keep images from one recording in the same session. Export includes reviewed images only, with matching YOLO polygon labels.</p><button className="button primary" onClick={() => setGuide(false)}>Ready to annotate <PenTool size={14} /></button></section></div>}
  </div>;
}
