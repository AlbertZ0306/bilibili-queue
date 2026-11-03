const paths = {
  play: [['path', { d: 'm8 5 11 7-11 7Z' }]], restart: [['path', { d: 'M3 10a9 9 0 1 1 2.4 8.1M3 4v6h6' }]],
  prev: [['path', { d: 'M5 5v14m14-14L8 12l11 7Z' }]], next: [['path', { d: 'M19 5v14M5 5l11 7-11 7Z' }]],
  stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]], plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  expand: [['path', { d: 'M14 3h7v7m0-7-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5' }]],
  refresh: [['path', { d: 'M20 7v5h-5M4 17v-5h5m-4.5-4a8 8 0 0 1 13.3-3L20 8M4 16l2.2 3A8 8 0 0 0 19.5 16' }]],
  trash: [['path', { d: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6' }]],
  up: [['path', { d: 'm6 11 6-6 6 6M12 5v14' }]], down: [['path', { d: 'm6 13 6 6 6-6M12 5v14' }]],
  close: [['path', { d: 'm6 6 12 12M6 18 18 6' }]], clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
  list: [['path', { d: 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01' }]],
  grip: [5,12,19].flatMap(cy => [8,16].map(cx => ['circle', { cx, cy, r: 1 }])),
  shield: [['path', { d: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6' }]]
};
export const iconPaths = paths;
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  svg.classList.add('icon');
  for (const [tag, attrs] of paths[name] || paths.play) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}
export function buttonContent(button, name, label) {
  const span = document.createElement('span'); span.textContent = label;
  button.replaceChildren(icon(name), span);
}
