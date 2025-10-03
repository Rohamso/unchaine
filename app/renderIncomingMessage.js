function renderIncomingMessage({ text, fromPeerId, ts }) {
  const row = document.createElement('div');
  row.className = 'row them';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(ts || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  const more = document.createElement('button');
  more.textContent = '⋯';
  more.style = 'border:none;background:transparent;color:#889;cursor:pointer;font-size:16px;';
  more.title = 'More';
  more.onclick = (ev) => {
    ev.stopPropagation();
    showMessageMenu(more, { text, offenderId: fromPeerId || 'unknown', ts });
  };

  row.append(meta, bubble, more);
  document.getElementById('msgs').appendChild(row);
}
