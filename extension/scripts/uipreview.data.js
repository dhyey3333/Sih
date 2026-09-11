/* Representative state for the design harness. Fake data only — every value here
   is invented, and the "screenshots" are drawn on a canvas rather than captured.
   Not shipped; see scripts/uipreview.mjs. */
(function () {
  const $ = (id) => document.getElementById(id);

  $('status').dataset.state = 'ok';
  $('status-text').textContent = 'Safe to send';

  /* ── A stand-in capture, drawn twice: as-is and redacted ─────────── */

  const W = 760;
  const H = 470;
  const ROWS = [
    ['Full name', 'Ananya Iyer', '⟦PROFILE.FULL_NAME⟧'],
    ['Aadhaar number', '2234 5678 9018', '⟦PROFILE.AADHAAR⟧'],
    ['Email address', 'ananya.iyer@example.com', '⟦PROFILE.EMAIL⟧'],
    ['Mobile number', '9812345678', '⟦PROFILE.PHONE⟧'],
    ['PAN', 'ABCPI1234K', '⟦PROFILE.PAN⟧'],
    ['Portal password', '••••••••••••', '⟦PASSWORD⟧'],
  ];

  function page(redacted) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#eef2f7';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#15325e';
    x.fillRect(0, 0, W, 46);
    x.fillStyle = '#fff';
    x.font = '600 15px system-ui';
    x.textBaseline = 'middle';
    x.fillText('National Scholarship Portal', 18, 23);

    x.fillStyle = '#fff';
    x.fillRect(24, 68, W - 48, 378);

    // A photo, top right of the form card.
    const px = W - 140;
    const py = 86;
    if (redacted) {
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          x.fillStyle = `hsl(${26 + ((i * j) % 14)} 32% ${38 + ((i + j) % 5) * 4}%)`;
          x.fillRect(px + i * 11, py + j * 11, 11, 11);
        }
      }
    } else {
      x.fillStyle = '#c08a63';
      x.fillRect(px, py, 88, 88);
      x.fillStyle = '#8a5a3b';
      x.beginPath();
      x.arc(px + 44, py + 34, 18, 0, Math.PI * 2);
      x.fill();
      x.beginPath();
      x.ellipse(px + 44, py + 84, 30, 26, 0, 0, Math.PI * 2);
      x.fill();
    }

    ROWS.forEach(([label, value, token], i) => {
      const y = 100 + i * 56;
      x.fillStyle = '#5a6b8c';
      x.font = '11px system-ui';
      x.fillText(label, 46, y);

      const bx = 46;
      const by = y + 10;
      const bw = 560;
      const bh = 28;
      if (redacted) {
        x.fillStyle = '#0b0d12';
        x.fillRect(bx, by, bw, bh);
        x.fillStyle = '#ff9db1';
        x.font = '600 11px ui-monospace, monospace';
        x.fillText(token, bx + 10, by + bh / 2);
      } else {
        x.strokeStyle = '#cfd7e3';
        x.lineWidth = 1;
        x.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        x.fillStyle = '#0d1117';
        x.font = '12px system-ui';
        x.fillText(value, bx + 10, by + bh / 2);
      }

      // Set-of-Mark badge, drawn after the redaction the way the pipeline does.
      x.fillStyle = '#0a6cff';
      x.fillRect(bx - 2, by - 2, 15, 13);
      x.fillStyle = '#fff';
      x.font = '700 9px system-ui';
      x.fillText(String(i + 1), bx + 2, by + 5);
    });

    return c.toDataURL('image/jpeg', 0.9);
  }

  const original = page(false);
  const sanitized = page(true);

  $('stage-empty').hidden = true;
  $('preview-original').src = original;
  $('preview-sanitized').src = sanitized;
  for (const id of [
    'preview-original',
    'stage-reveal',
    'stage-divider',
    'stage-slider',
    'stage-modes',
    'stage-badge-left',
    'stage-badge-right',
  ]) {
    $(id).hidden = false;
  }

  /* ── Detections, and their outlines over the preview ─────────────── */

  const DETECTIONS = [
    ['PASSWORD', '⟦PASSWORD⟧', 'dom-field', 98, [46, 390, 560, 28]],
    ['AADHAAR', '⟦PROFILE.AADHAAR⟧', 'dom-field', 98, [46, 166, 560, 28]],
    ['FACE', '⟦FACE_1⟧', 'vision', 87, [620, 86, 88, 88]],
    ['PAN', '⟦PROFILE.PAN⟧', 'dom-field', 96, [46, 334, 560, 28]],
    ['EMAIL', '⟦PROFILE.EMAIL⟧', 'dom-field', 99, [46, 222, 560, 28]],
    ['PHONE', '⟦PROFILE.PHONE⟧', 'dom-field', 97, [46, 278, 560, 28]],
    ['NAME', '⟦PROFILE.FULL_NAME⟧', 'dom-text', 91, [46, 110, 560, 28]],
    ['AADHAAR', '⟦PROFILE.AADHAAR⟧', 'ocr', 82, [620, 190, 120, 20]],
  ];

  const CRED = new Set(['PASSWORD', 'CARD', 'CVV', 'AADHAAR', 'PAN', 'PASSPORT', 'ACCOUNT']);
  const list = $('detections');
  const boxes = $('stage-boxes');
  list.replaceChildren();
  boxes.replaceChildren();

  DETECTIONS.forEach(([type, token, source, confidence, rect], i) => {
    const id = `d${i}`;

    const li = document.createElement('li');
    li.dataset.det = id;
    const t = document.createElement('span');
    t.className = type === 'FACE' ? 'type type--face' : CRED.has(type) ? 'type type--cred' : 'type';
    t.textContent = type;
    const tok = document.createElement('span');
    tok.className = 'token';
    tok.textContent = token;
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = `${source} · ${confidence}%`;
    li.append(t, tok, src);
    li.addEventListener('pointerenter', () => light(id));
    li.addEventListener('pointerleave', () => light(null));
    list.append(li);

    const box = document.createElement('div');
    box.className = 'stage__box';
    box.dataset.det = id;
    if (type === 'FACE') box.dataset.kind = 'face';
    box.style.left = `${(rect[0] / W) * 100}%`;
    box.style.top = `${(rect[1] / H) * 100}%`;
    box.style.width = `${(rect[2] / W) * 100}%`;
    box.style.height = `${(rect[3] / H) * 100}%`;
    box.style.animationDelay = `${i * 28}ms`;
    boxes.append(box);
  });

  function light(id) {
    for (const box of boxes.querySelectorAll('.stage__box')) {
      box.classList.toggle('is-lit', box.dataset.det === id);
    }
  }

  $('detections-count').textContent = String(DETECTIONS.length);
  $('panel-detections').open = true;

  /* ── Guard, metrics, ledger ──────────────────────────────────────── */

  $('guard').dataset.state = 'pass';
  $('guard-title').textContent = 'Egress guard passed';
  $('guard-detail').textContent = '142 strings re-scanned in 4.9 ms · no PII';

  $('stat-detections').textContent = '18';
  $('stat-area').textContent = '21%';
  $('stat-level').textContent = 'L2';
  $('metric-level').dataset.level = '2';
  $('stat-latency').textContent = '165';
  $('stat-vault').textContent = '9';

  $('stat-requests').textContent = '4';
  $('stat-sent').textContent = '168 KB';
  $('stat-local').textContent = '5';
  $('ledger').dataset.sent = 'true';

  /* ── Pipeline ────────────────────────────────────────────────────── */

  const TIMINGS = [
    ['capture', 42],
    ['DOM snapshot', 18],
    ['vision models', 50],
    ['detect PII', 6],
    ['fuse boxes', 2],
    ['redact pixels', 41],
    ['tokenize', 3],
    ['egress guard', 5],
  ];
  const max = Math.max(...TIMINGS.map(([, ms]) => ms));
  const timings = $('timings');
  timings.replaceChildren();
  for (const [name, ms] of TIMINGS) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.textContent = name;
    const track = document.createElement('span');
    track.className = 'track';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(3, (ms / max) * 100)}%`;
    track.append(fill);
    const v = document.createElement('span');
    v.className = 'ms';
    v.textContent = `${ms} ms`;
    li.append(n, track, v);
    timings.append(li);
  }
  $('timings-total').textContent = '167 ms';
  $('vision-status').textContent = 'WEBGPU · 227 KB · 312 ms load · 50 ms · 1 face(s) · OCR 2 region(s) 71 ms, 2 cached';

  /* ── Payload ─────────────────────────────────────────────────────── */

  $('payload').textContent = JSON.stringify(
    {
      session_id: 'a3f9c1e2',
      task: 'Fill this form with my profile and stop before submitting',
      step: 3,
      disclosure_level: 2,
      page: { origin: 'https://scholarships.example.gov.in', path: '/apply', title: 'Application — step 2' },
      elements: [
        { id: 1, role: 'textbox', label: 'Full name', value: '⟦PROFILE.FULL_NAME⟧' },
        { id: 2, role: 'textbox', label: 'Aadhaar number', value: '⟦PROFILE.AADHAAR⟧' },
        { id: 7, role: 'button', text: 'Submit application' },
      ],
      redactions: [
        { token: '⟦PROFILE.AADHAAR⟧', type: 'AADHAAR', bbox: [46, 166, 560, 28], source: 'dom-field' },
        { token: '⟦FACE_1⟧', type: 'FACE', bbox: [620, 86, 88, 88], source: 'vision' },
      ],
      profile_keys: ['FULL_NAME', 'EMAIL', 'PHONE', 'AADHAAR', 'PAN'],
      screen: { image_jpeg_b64: '<redacted screenshot, 42 KB, 1280×792>', width: 1280, height: 792 },
    },
    null,
    2,
  );

  /* ── Vault + activity ────────────────────────────────────────────── */

  const PROFILE = [
    ['full name', 'Ananya Iyer'],
    ['email', 'ananya.iyer@example.com'],
    ['phone', '9812345678'],
    ['aadhaar', '2234 5678 9018'],
    ['pan', 'ABCPI1234K'],
  ];
  const profile = $('profile');
  profile.replaceChildren();
  for (const [key, value] of PROFILE) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = key;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    label.append(span, input);
    profile.append(label);
  }

  const LOG = [
    '✓ type ⟦PROFILE.PAN⟧ into field 5',
    'local → type ⟦PROFILE.EMAIL⟧ into field 3 — the page declares autocomplete=email',
    '18 redactions · 21% of screen · L2 · 165 ms',
    'Task: Fill this form with my profile and stop before submitting',
    'Ready. Nothing has left this device.',
  ];
  const log = $('log');
  log.replaceChildren();
  LOG.forEach((line, i) => {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = new Date(Date.now() - i * 4000).toLocaleTimeString([], { hour12: false });
    li.append(t, document.createTextNode(line));
    log.append(li);
  });
  $('log-count').textContent = String(LOG.length);
  $('server-status').textContent = 'Connected · rule-based planner (no VLM configured)';

  /* ── Interactions the harness still needs to feel real ───────────── */

  const stage = $('stage');
  const slider = $('stage-slider');
  const pill = $('segmented-pill');
  const ORDER = ['original', 'compare', 'sent'];
  const REVEAL = { original: 100, compare: 55, sent: 0 };

  function setReveal(v) {
    stage.style.setProperty('--reveal', `${v}%`);
    $('stage-badge-left').style.opacity = v > 14 ? '1' : '0';
    $('stage-badge-right').style.opacity = v < 86 ? '1' : '0';
  }

  function setMode(mode, move = true) {
    pill.style.translate = `${ORDER.indexOf(mode) * 100}% 0`;
    for (const b of $('stage-modes').querySelectorAll('button')) {
      b.classList.toggle('is-on', b.dataset.mode === mode);
    }
    if (move) {
      slider.value = String(REVEAL[mode]);
      setReveal(REVEAL[mode]);
    }
  }

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    setReveal(v);
    setMode(v >= 99 ? 'original' : v <= 1 ? 'sent' : 'compare', false);
  });

  $('stage-modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  setMode('compare');
})();
