export const CLASSES = [
  { id: 0, name: 'guitar', title: 'Guitar', color: '#7ecbb2', description: 'The visible instrument silhouette.' },
  { id: 1, name: 'fretboard', title: 'Fretboard', color: '#83b9ef', description: 'The fingerboard surface.' },
  { id: 2, name: 'fret', title: 'Fret', color: '#e8ba76', description: 'One visible metal fret wire.' },
  { id: 3, name: 'string', title: 'String', color: '#d49fc5', description: 'One visible string over the fretboard.' },
];

export function polygonArea(points) {
  return Math.abs(points.reduce((area, point, i) => {
    const next = points[(i + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
}

export function validateAnnotations(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Use up to 200 polygons per image.');
  const ids = new Set();
  return value.map((shape) => {
    if (!shape || typeof shape.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(shape.id) || ids.has(shape.id)) {
      throw new Error('Each polygon needs a unique ID.');
    }
    ids.add(shape.id);
    if (!Number.isInteger(shape.classId) || !CLASSES[shape.classId]) throw new Error('Unknown polygon label.');
    if (!Array.isArray(shape.points) || shape.points.length < 3 || shape.points.length > 500) {
      throw new Error('Each polygon needs between 3 and 500 points.');
    }
    const points = shape.points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 || point.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) {
        throw new Error('Polygon coordinates must be within the image.');
      }
      return [...point];
    });
    if (polygonArea(points) <= 1e-12) throw new Error('A polygon needs a visible width. Outline both edges of strings and frets.');
    return { id: shape.id, classId: shape.classId, points };
  });
}

export function validateSession(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Session must be 1–64 letters, numbers, dashes, or underscores. Start with a letter or number.');
  }
  return value;
}

export function toYolo(annotations) {
  return annotations.map(({ classId, points }) => `${classId} ${points.flat().map((n) => n.toFixed(12)).join(' ')}`).join('\n') + (annotations.length ? '\n' : '');
}
