const STORAGE_KEY = 'roadmap-tiles-v3';
const PREFS_KEY = 'roadmap-prefs-v1';

const COLS_CHOICES = ['auto', '2', '3', '4', '5'];
const THEME_CHOICES = ['system', 'light', 'dark'];

const DEFAULT_TILES = [
  { id: 't1', title: 'DIG — Deferred Ingestion Gateway', tags: ['CLIC', 'Ingestion'], pct: 50, todos: [
    { id: 'a1', text: 'Spec fonctionnelle validée', done: true },
    { id: 'a2', text: 'Revue architecture avec l\'équipe', done: true },
    { id: 'a3', text: 'Développement du connecteur', done: false },
    { id: 'a4', text: 'Tests de charge', done: false },
  ]},
  { id: 't2', title: 'Renommage ClicOut', tags: ['Export'], pct: 33, todos: [
    { id: 'b1', text: 'Shortlist de noms avec « asset »', done: true },
    { id: 'b2', text: 'Vérification marques / conflits', done: false },
    { id: 'b3', text: 'Validation direction', done: false },
  ]},
  { id: 't3', title: 'Campagne NPS « Première Écoute »', tags: ['CLIC', 'Adoption'], pct: 90, todos: [] },
  { id: 't4', title: 'Migration AdBox → CLIC', tags: ['CLIC', 'Discovery'], pct: 45, todos: [] },
];

let tiles = [];
const flipped = new Set();
const activeFilters = new Set();
let filtersOpen = false;
let prefs = { cols: 'auto', theme: 'system', lang: 'fr' };

// Posé dès le parse du script : sans cela, un système en mode sombre
// verrait la page s'afficher en clair le temps de lire les préférences.
function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
document.documentElement.dataset.theme = systemTheme();

/* ---------- Persistance ----------
   Deux dépôts possibles. Le dépôt de l'hôte n'existe que si la page est
   hébergée ; ouverte en local, elle doit tout de même retenir le travail,
   d'où le repli sur localStorage. On tente le premier, on retombe sur le
   second dès qu'il manque ou qu'il échoue — les deux peuvent lever
   (navigation privée, quota), aucun appel n'est donc laissé nu. */
const store = {
  async get(key) {
    if (window.storage && window.storage.get) {
      try {
        const res = await window.storage.get(key);
        if (res && res.value != null) return res.value;
      } catch (e) { /* dépôt hôte indisponible */ }
    }
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  async set(key, value) {
    if (window.storage && window.storage.set) {
      try { await window.storage.set(key, value); return true; } catch (e) { /* repli */ }
    }
    try { localStorage.setItem(key, value); return true; }
    catch (e) { console.error('Aucun stockage disponible', e); return false; }
  },
};

async function load() {
  let brut = null;
  try { brut = JSON.parse(await store.get(STORAGE_KEY)); } catch (e) { /* rien de lisible */ }
  tiles = normaliseTiles(brut);
  if (!tiles.length) {
    tiles = DEFAULT_TILES;
    saveTiles();
  }
  recomputeDerived();

  try {
    const saved = JSON.parse(await store.get(PREFS_KEY));
    // Validation explicite : JSON.parse('null') rend null sans lever,
    // et une valeur hors liste casserait le sélecteur
    if (saved && COLS_CHOICES.includes(String(saved.cols))) prefs.cols = String(saved.cols);
    if (saved && THEME_CHOICES.includes(saved.theme)) prefs.theme = saved.theme;
    if (saved && LANGS.includes(saved.lang)) prefs.lang = saved.lang;
  } catch (e) {
    // pas de préférence enregistrée : on garde les valeurs par défaut
  }
  applyCols();
  applyTheme();
  applyLang();

  render();
}

let prefsTimer = null;
function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(async () => {
    store.set(PREFS_KEY, JSON.stringify(prefs));
  }, 400);
}

/* Applique la langue au châssis de la page : sens de lecture, attribut
   lang, titre, et tous les éléments porteurs d'un data-i18n. Le contenu
   des cartes, lui, est retraduit par render(). */
function applyLang() {
  const dict = I18N[prefs.lang] || I18N.fr;
  const racine = document.documentElement;
  racine.lang = prefs.lang;
  racine.dir = dict.dir;
  document.title = tr('titre');
  document.getElementById('pageTitle').textContent = tr('titre');

  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = tr(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = tr(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-label]').forEach(el => {
    el.setAttribute('aria-label', tr(el.dataset.i18nLabel));
  });
  document.querySelectorAll('.cfg-lang').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.lang === prefs.lang));
  });
}

// « Système » n'est pas un thème : c'est une délégation au réglage de l'OS
function currentTheme() {
  return prefs.theme === 'system' ? systemTheme() : prefs.theme;
}

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
  document.querySelectorAll('.cfg-choice[data-theme]').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.theme === prefs.theme));
  });
}

// La densité vit dans un attribut : le CSS porte les variantes, le JS
// n'écrit aucune valeur de grid-template-columns
function applyCols() {
  const grid = document.getElementById('grid');
  if (prefs.cols === 'auto') grid.removeAttribute('data-cols');
  else grid.dataset.cols = prefs.cols;
  document.querySelectorAll('.cfg-choice[data-cols]').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.cols === prefs.cols));
  });
}

let tilesTimer = null;
function saveTiles() {
  clearTimeout(tilesTimer);
  tilesTimer = setTimeout(async () => {
    store.set(STORAGE_KEY, JSON.stringify(tiles));
  }, 400);
}

/* Remet une liste venue du stockage ou d'un fichier importé dans un état
   sûr : types corrigés, pourcentages bornés, rattachements orphelins
   coupés. Une carte sans identifiant est écartée plutôt que devinée. */
function normaliseTiles(brut) {
  if (!Array.isArray(brut)) return [];
  const vus = new Set();
  const liste = brut
    .filter(t => t && typeof t === 'object' && t.id != null)
    .map(t => {
      const id = String(t.id);
      if (vus.has(id)) return null;          // identifiant déjà pris
      vus.add(id);
      const pct = Number(t.pct);
      return {
        id,
        title: typeof t.title === 'string' ? t.title : tr('sansTitre'),
        tags: Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string') : [],
        pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
        parentId: t.parentId == null ? null : String(t.parentId),
        todos: Array.isArray(t.todos)
          ? t.todos.filter(td => td && td.id != null).map(td => ({
              id: String(td.id),
              text: typeof td.text === 'string' ? td.text : '',
              done: !!td.done,
            }))
          : [],
      };
    })
    .filter(Boolean);
  // un parent absent laisserait une carte hors de toute hiérarchie
  liste.forEach(t => {
    if (t.parentId && !liste.some(x => x.id === t.parentId)) t.parentId = null;
  });
  return liste;
}

// ---------- Tags & couleurs ----------
function allTags() {
  const counts = new Map();
  tiles.forEach(t => t.tags.forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'fr'));
}

function findCanonical(tag) {
  const lower = tag.toLowerCase();
  for (const [existing] of allTags()) {
    if (existing.toLowerCase() === lower) return existing;
  }
  return tag;
}

function visibleTiles() {
  if (!activeFilters.size) return tiles;
  return tiles.filter(t => t.tags.some(tag => activeFilters.has(tag)));
}

/* =========================================================
   Hiérarchie mère / filles
   Une carte rattachée à une autre devient sa « fille ». La
   jauge d'une carte mère est dérivée : moyenne des jauges de
   ses filles, calculée récursivement. Elle n'est plus
   réglable à la main tant qu'elle a des filles.
   ========================================================= */
function childrenOf(id) {
  return tiles.filter(t => t.parentId === id);
}

function hasChildren(t) {
  return tiles.some(x => x.parentId === t.id);
}

// candidateId est-il un descendant de ofId ? (protection anti-cycle)
function isDescendant(candidateId, ofId) {
  let cur = tiles.find(t => t.id === candidateId);
  const seen = new Set();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ofId) return true;
    cur = tiles.find(t => t.id === cur.parentId);
  }
  return false;
}

// Recalcule toutes les jauges dérivées (les feuilles gardent leur valeur propre)
function recomputeDerived() {
  const memo = {};
  const calc = (t, seen) => {
    if (memo[t.id] !== undefined) return memo[t.id];
    if (seen.has(t.id)) return t.pct; // garde-fou anti-cycle
    seen.add(t.id);
    const kids = childrenOf(t.id);
    memo[t.id] = kids.length
      ? Math.round(kids.reduce((s, k) => s + calc(k, seen), 0) / kids.length)
      : t.pct;
    return memo[t.id];
  };
  tiles.forEach(t => { t.pct = calc(t, new Set()); });
}

// Rafraîchit les faces avant de toute la chaîne d'ancêtres d'une carte
function updateAncestors(t) {
  let cur = t;
  const seen = new Set();
  while (cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = tiles.find(x => x.id === cur.parentId);
    if (!parent) break;
    const card = document.querySelector(`.card[data-id="${parent.id}"]`);
    if (card) updateFront(card, parent);
    cur = parent;
  }
}

/* =========================================================
   Anneau circulaire interactif
   Le progrès démarre en haut (12 h) et tourne dans le sens
   horaire. Survoler l'anneau affiche un repère fantôme à la
   valeur visée ; cliquer ou glisser règle le pourcentage.
   ========================================================= */
const R = 92;                     // rayon dans le viewBox 220×220
const CIRC = 2 * Math.PI * R;

function ringSVG(pct) {
  const offset = CIRC * (1 - pct / 100);
  const h = handleXY(pct);
  return `
  <svg viewBox="0 0 220 220" role="slider" tabindex="0"
       aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
       aria-label="${tr('pourcentage')}">
    <circle class="ring-track" cx="110" cy="110" r="${R}" fill="none" stroke-width="13"/>
    <circle class="ring-prog" cx="110" cy="110" r="${R}" fill="none" stroke-width="13"
      stroke-linecap="round" transform="rotate(-90 110 110)"
      stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
    <circle class="ring-hit" cx="110" cy="110" r="${R}" fill="none" stroke="transparent" stroke-width="34"/>
    <g class="ring-handle" transform="translate(${h.x.toFixed(1)} ${h.y.toFixed(1)})">
      <circle class="handle-dot" r="5.5"/>
    </g>
    <g class="ring-bubble" transform="translate(${h.x.toFixed(1)} ${h.y.toFixed(1)})">
      <path d="M 0 -11 C -9 -19 -14 -26 -14 -34 A 14 14 0 1 1 14 -34 C 14 -26 9 -19 0 -11 Z"/>
      <text y="-29" text-anchor="middle">${pct}</text>
    </g>
  </svg>`;
}

// Position de la poignée sur l'arc à la valeur courante
function handleXY(pct) {
  const a = (pct / 100) * 2 * Math.PI - Math.PI / 2;
  return { x: 110 + R * Math.cos(a), y: 110 + R * Math.sin(a) };
}

// Convertit une position de pointeur en pourcentage (0 en haut, horaire)
function pointerPct(svg, e) {
  const rect = svg.getBoundingClientRect();
  const x = e.clientX - rect.left - rect.width / 2;
  const y = e.clientY - rect.top - rect.height / 2;
  let deg = Math.atan2(y, x) * 180 / Math.PI;   // 0° = droite
  deg = (deg + 90 + 360) % 360;                  // 0° = haut, horaire
  return Math.round(deg / 3.6);
}

function taskCountLabel(t) {
  const kids = childrenOf(t.id);
  if (kids.length) return tr('moyenneFilles', kids.length);
  if (!t.todos.length) return '';
  return tr('nbTaches', t.todos.filter(x => x.done).length, t.todos.length);
}

// ---------- Rendu ----------
function render() {
  renderFilters();
  renderGrid();
  renderSuggestions();
  bindEvents();
}

function renderFilters() {
  const bar = document.getElementById('filters');
  const tags = allTags();
  [...activeFilters].forEach(f => { if (!tags.some(([t]) => t === f)) activeFilters.delete(f); });

  // Sans aucun tag, le bouton lui-même n'a pas lieu d'être
  if (!tags.length) {
    bar.innerHTML = '';
    filtersOpen = false;
    applyFiltersPanel();
    return;
  }

  let html = '';
  tags.forEach(([tag, count]) => {
    html += `
      <button class="filter-chip ${activeFilters.has(tag) ? 'active' : ''}" data-filter="${escapeHtml(tag)}">
        ${escapeHtml(tag)} <span class="count">${count}</span>
      </button>`;
  });
  if (activeFilters.size) {
    html += `<button class="filter-chip reset" data-reset>✕ ${tr('toutAfficher')}</button>`;
  }
  bar.innerHTML = html;
  applyFiltersPanel();
}

// Synchronise bouton et panneau sur filtersOpen / activeFilters.
// `inert` plutôt qu'un simple masquage : un panneau replié ne doit ni
// capter le clavier ni être annoncé par un lecteur d'écran.
function applyFiltersPanel() {
  const toggle = document.getElementById('filtersToggle');
  const panel = document.getElementById('filtersPanel');
  const count = document.getElementById('filtersCount');
  toggle.hidden = !allTags().length;
  toggle.setAttribute('aria-expanded', String(filtersOpen));
  panel.classList.toggle('open', filtersOpen);
  panel.inert = !filtersOpen;
  count.hidden = !activeFilters.size;
  count.textContent = activeFilters.size;
}

function renderSuggestions() {
  document.getElementById('tagSuggestions').innerHTML =
    allTags().map(([tag]) => `<option value="${escapeHtml(tag)}"></option>`).join('');
}

function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const visible = new Set(visibleTiles().map(t => t.id));

  tiles.forEach(t => {
    const card = document.createElement('div');
    card.className = 'card'
      + (flipped.has(t.id) ? ' flipped' : '')
      + (t.pct >= 100 ? ' done' : '')
      + (visible.has(t.id) ? '' : ' hidden');
    card.dataset.id = t.id;

    const dotsHTML = t.tags.map(tag => `
      <span class="tag-dot" data-tag="${escapeHtml(tag)}" title="${escapeHtml(tag)}"></span>`).join('');

    const tagsHTML = t.tags.map(tag => `
      <span class="tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}<button class="tag-del" title="${tr('retirerTag')}" aria-label="${escapeHtml(tr('retirerTagNomme', tag))}">✕</button></span>`).join('');

    const todosHTML = t.todos.length
      ? t.todos.map(td => `
          <li class="todo ${td.done ? 'checked' : ''}" data-todo="${td.id}">
            <input type="checkbox" class="todo-check" ${td.done ? 'checked' : ''} aria-label="${tr('tacheTerminee')}">
            <input class="todo-text" value="${escapeHtml(td.text)}" aria-label="${tr('intituleTache')}">
            <button class="todo-del" title="${tr('supprimerTache')}" aria-label="${tr('supprimerTache')}">✕</button>
          </li>`).join('')
      : `<li class="todo-empty">${tr('aucuneTache')}<br>${tr('ajoutezEnUne')}</li>`;

    card.innerHTML = `
      <div class="card-inner">
        <div class="face front">
          <div class="tile-head">
            <input class="tile-title" value="${escapeHtml(t.title)}" aria-label="${tr('titreEpique')}" style="flex:1; min-width:0">
            <span class="tag-dots">${dotsHTML}</span>
          </div>
          <div class="ring-wrap${hasChildren(t) ? ' derived' : ''}">
            ${ringSVG(t.pct)}
            <button class="ring-center" draggable="false" title="${tr('voirTaches')}" aria-label="${tr('voirTaches')}">
              <span class="ring-value">${t.pct}<span class="unit">%</span></span>
              <span class="ring-sub">${taskCountLabel(t)}</span>
            </button>
          </div>
          <div class="drag-handle" title="${tr('deplacerCarte')}" aria-label="${tr('deplacerCarte')}">
            <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/>
              <circle cx="3" cy="8" r="1.6"/><circle cx="9" cy="8" r="1.6"/>
              <circle cx="3" cy="13" r="1.6"/><circle cx="9" cy="13" r="1.6"/>
            </svg>
          </div>
        </div>
        <div class="face back">
          <div class="back-head">
            <div class="back-title">${escapeHtml(t.title)}</div>
          </div>
          <div class="tag-row">
            ${tagsHTML}
            <input class="tag-input" list="tagSuggestions" placeholder="${tr('plusTag')}" aria-label="${tr('ajouterTag')}">
          </div>
          ${t.parentId ? `
          <div class="parent-info">
            <span>↳ ${tr('filleDe')} <strong>${escapeHtml(tiles.find(x => x.id === t.parentId)?.title || '?')}</strong></span>
            <button class="detach-parent" title="${tr('detacher')}" aria-label="${tr('detacher')}">✕</button>
          </div>` : ''}
          <ul class="todo-list">${todosHTML}</ul>
          <div class="todo-add">
            <button class="icon-btn del del-tile" title="${tr('supprimerEpique')}" aria-label="${tr('supprimerEpique')}">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.7 4.3h10.6"/><path d="M6.4 4.3V3h3.2v1.3"/>
                <path d="M4 4.3l.55 8.2a1 1 0 0 0 1 .95h4.9a1 1 0 0 0 1-.95L12 4.3"/>
                <path d="M6.6 6.9v3.8M9.4 6.9v3.8"/>
              </svg>
            </button>
            <span class="todo-add-slot">
              <button class="add-todo" title="${tr('ajouterTache')}" aria-label="${tr('ajouterTache')}"><span class="plus">+</span> ${tr('nouvelleTache')}</button>
              <button class="del-confirm" aria-label="${tr('supprimerDefinitivementCarte')}">${tr('supprimerDefinitivement')}</button>
            </span>
            <button class="icon-btn flip-btn" title="${tr('retourJauge')}" aria-label="${tr('retourJauge')}">⇄</button>
          </div>
          <div class="assoc-overlay" aria-hidden="true">
            <div class="assoc-zone" data-side="left">
              <span class="assoc-big">${tr('fille')}</span>
              <span class="assoc-small">${tr('deCetteCarte')}</span>
            </div>
            <div class="assoc-zone" data-side="right">
              <span class="assoc-big">${tr('mere')}</span>
              <span class="assoc-small">${tr('deCetteCarte')}</span>
            </div>
          </div>
        </div>
      </div>`;
    grid.appendChild(card);
  });

  const add = document.createElement('button');
  add.className = 'add-tile';
  add.setAttribute('aria-label', tr('nouvelleEpique'));
  add.title = tr('nouvelleEpique');
  add.innerHTML = '<span class="add-ring" aria-hidden="true"></span>';
  add.onclick = () => {
    const newTile = { id: 't' + Date.now(), title: tr('nouvelleEpique'), tags: [...activeFilters], pct: 0, todos: [] };
    tiles.push(newTile);
    saveTiles();
    render();
    const titleInput = document.querySelector(`.card[data-id="${newTile.id}"] .tile-title`);
    if (titleInput) { titleInput.focus(); titleInput.select(); }
  };
  grid.appendChild(add);
}

function getTile(el) {
  return tiles.find(x => x.id === el.closest('.card').dataset.id);
}

// Met à jour l'anneau (arc, poignée, bulle, valeur, sous-titre, état "done")
function updateFront(card, t) {
  const svg = card.querySelector('.ring-wrap svg');
  const prog = svg.querySelector('.ring-prog');
  prog.setAttribute('stroke-dashoffset', (CIRC * (1 - t.pct / 100)).toFixed(2));
  svg.setAttribute('aria-valuenow', t.pct);
  const h = handleXY(t.pct);
  const transform = `translate(${h.x.toFixed(1)} ${h.y.toFixed(1)})`;
  svg.querySelector('.ring-handle').setAttribute('transform', transform);
  const bubble = svg.querySelector('.ring-bubble');
  bubble.setAttribute('transform', transform);
  bubble.querySelector('text').textContent = t.pct;
  card.querySelector('.ring-value').innerHTML = `${t.pct}<span class="unit">%</span>`;
  card.querySelector('.ring-sub').textContent = taskCountLabel(t);
  card.classList.toggle('done', t.pct >= 100);
}

function bindEvents() {
  const grid = document.getElementById('grid');

  // ---------- Drag & drop : réordonner les cartes ----------
  let draggedCard = null;

  grid.querySelectorAll('.card').forEach(card => {
    card.draggable = false;
    // Seule la poignée en bas à droite arme le déplacement de la carte
    card.addEventListener('pointerdown', e => {
      card.draggable = !!e.target.closest('.drag-handle');
    }, true);
    card.addEventListener('dragstart', e => {
      draggedCard = card;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
      // Image de drag : une pastille compacte (titre + %) plutôt qu'un clone
      // de la carte entière, qui masquait la cible et ses zones de dépôt
      const t = tiles.find(x => x.id === card.dataset.id);
      const ghost = document.createElement('div');
      ghost.className = 'drag-pill';
      const title = t.title.length > 26 ? t.title.slice(0, 25) + '…' : t.title;
      ghost.textContent = `${title} · ${t.pct} %`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 18, 16);
      card._ghost = ghost;
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => {
      card._ghost?.remove();
      card._ghost = null;
      card.classList.remove('dragging');
      card.draggable = false;
      draggedCard = null;
      clearAssocPreview();
      // L'ordre du DOM devient l'ordre de référence, puis est persisté
      const order = [...grid.querySelectorAll('.card')].map(c => c.dataset.id);
      tiles.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveTiles();
    });
  });

  const clearAssocPreview = () => {
    grid.querySelectorAll('.card.assoc-visible').forEach(c => {
      c.classList.remove('assoc-visible');
      c.querySelectorAll('.assoc-zone').forEach(z => z.classList.remove('active', 'invalid'));
    });
  };

  grid.addEventListener('dragover', e => {
    if (!draggedCard) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.card');
    if (!target || target === draggedCard) { clearAssocPreview(); return; }

    // Cible retournée : proposition d'association mère/fille au lieu du
    // réordonnancement — moitié gauche = la carte déposée devient fille,
    // moitié droite = elle devient mère
    if (target.classList.contains('flipped')) {
      clearAssocPreview();
      target.classList.add('assoc-visible');
      const rect = target.getBoundingClientRect();
      const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
      const dragged = tiles.find(x => x.id === draggedCard.dataset.id);
      const host = tiles.find(x => x.id === target.dataset.id);
      const invalid = side === 'left'
        ? isDescendant(host.id, dragged.id)   // la cible descend déjà de la carte déposée
        : isDescendant(dragged.id, host.id);  // la carte déposée descend déjà de la cible
      // Le nom de la carte déposée dans chaque zone lève toute ambiguïté
      const short = dragged.title.length > 20 ? dragged.title.slice(0, 19) + '…' : dragged.title;
      target.querySelectorAll('.assoc-zone .assoc-small').forEach(s => {
        s.textContent = `« ${short} »`;
      });
      const zone = target.querySelector(`.assoc-zone[data-side="${side}"]`);
      target.querySelectorAll('.assoc-zone').forEach(z => z.classList.remove('active', 'invalid'));
      zone.classList.add('active');
      zone.classList.toggle('invalid', invalid);
      return;
    }

    clearAssocPreview();
    // La grille coule ligne par ligne : la moitié gauche/droite de la
    // carte survolée décide de l'insertion avant/après
    const rect = target.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    if (after && target.nextElementSibling !== draggedCard) target.after(draggedCard);
    else if (!after && target.previousElementSibling !== draggedCard) target.before(draggedCard);
  });

  grid.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('.card');
    if (!draggedCard || !target || target === draggedCard) { clearAssocPreview(); return; }
    if (!target.classList.contains('flipped')) { clearAssocPreview(); return; }

    const dragged = tiles.find(x => x.id === draggedCard.dataset.id);
    const host = tiles.find(x => x.id === target.dataset.id);
    const rect = target.getBoundingClientRect();
    const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    clearAssocPreview();
    if (!dragged || !host) return;

    if (side === 'left') {
      // La carte déposée devient fille de la carte retournée
      if (isDescendant(host.id, dragged.id)) return; // cycle
      dragged.parentId = host.id;
    } else {
      // La carte déposée devient mère de la carte retournée
      if (isDescendant(dragged.id, host.id)) return; // cycle
      host.parentId = dragged.id;
    }
    recomputeDerived();
    saveTiles();
    render();
  });

  // draggable n'est vrai que pendant un appui actif sur le fond d'une carte :
  // dès le relâchement, tout est réarmé à false pour qu'aucun clic ultérieur
  // (flip, boutons…) ne soit interprété comme un début de drag
  const disarmDrag = () => grid.querySelectorAll('.card').forEach(c => { c.draggable = false; });
  document.addEventListener('pointerup', disarmDrag);
  document.addEventListener('pointercancel', disarmDrag);

  // Filtres
  document.querySelectorAll('.filter-chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', e => {
      const tag = chip.dataset.filter;
      activeFilters.has(tag) ? activeFilters.delete(tag) : activeFilters.add(tag);
      render();
    });
  });
  document.querySelector('.filter-chip[data-reset]')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Retournement : centre de l'anneau (recto) ou bouton ⇄ (verso).
  // Implémenté en pointerdown/pointerup plutôt qu'en click : l'événement
  // click peut être avalé par les heuristiques de drag natif du navigateur,
  // les pointer events, eux, sont toujours délivrés.
  const doFlip = card => {
    const id = card.dataset.id;
    flipped.has(id) ? flipped.delete(id) : flipped.add(id);
    card.classList.toggle('flipped');
    if (card.classList.contains('flipped')) {
      setTimeout(() => card.querySelector('.add-todo')?.focus(), 560);
    }
  };
  // Détection de "vrai clic" (appui + relâchement quasi immobiles) : plus
  // fiable que l'événement click, que le drag natif peut avaler
  const bindTapFlip = (el, isExcluded) => {
    let downAt = null;
    el.addEventListener('pointerdown', e => {
      if (isExcluded && isExcluded(e)) { downAt = null; return; }
      downAt = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', e => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 8) return;
      if (isExcluded && isExcluded(e)) return;
      doFlip(el.closest('.card'));
    });
    el.addEventListener('pointerleave', () => { downAt = null; });
    el.addEventListener('click', e => e.preventDefault());
  };

  // Centre de l'anneau et ⇄ du verso : flip direct
  grid.querySelectorAll('.flip-btn, .ring-center').forEach(el => {
    el.addEventListener('pointerdown', e => {
      const card = el.closest('.card');
      if (card) card.draggable = false;
      e.stopPropagation(); // ne pas déclencher aussi le flip du recto
    });
    bindTapFlip(el);
  });

  // Tout le reste du recto flippe aussi, hors zones interactives
  grid.querySelectorAll('.face.front').forEach(front => {
    bindTapFlip(front, e =>
      !!e.target.closest('input, button, select, .ring-hit, .drag-handle'));
  });

  // Anneau interactif : le survol révèle la poignée et sa bulle à la valeur
  // courante ; cliquer ou glisser sur l'anneau règle le pourcentage
  grid.querySelectorAll('.ring-wrap svg').forEach(svg => {
    const card = svg.closest('.card');
    const wrap = svg.closest('.ring-wrap');
    const prog = svg.querySelector('.ring-prog');
    let dragging = false;
    let lastPct = null;

    const setPct = raw => {
      const t = getTile(svg);
      if (!t || hasChildren(t)) return; // jauge dérivée : non réglable
      let pct = raw;
      // Anti-bascule : en glissant près de 0/100, on bute au lieu de boucler
      if (lastPct !== null) {
        if (lastPct >= 75 && pct <= 25) pct = 100;
        else if (lastPct <= 25 && pct >= 75) pct = 0;
      }
      lastPct = pct;
      if (t.pct === pct) return;
      t.pct = pct;
      recomputeDerived();
      updateFront(card, t);
      updateAncestors(t);
      saveTiles();
    };

    svg.addEventListener('pointermove', e => {
      if (dragging) setPct(pointerPct(svg, e));
    });
    svg.addEventListener('pointerdown', e => {
      const t = getTile(svg);
      if (!t || hasChildren(t)) return; // pas de saisie sur une jauge dérivée
      dragging = true;
      lastPct = t.pct;
      prog.classList.add('dragging');
      wrap.classList.add('adjusting');
      svg.setPointerCapture(e.pointerId);
      setPct(pointerPct(svg, e));
    });
    svg.addEventListener('pointerup', e => {
      dragging = false;
      lastPct = null;
      prog.classList.remove('dragging');
      wrap.classList.remove('adjusting');
      svg.releasePointerCapture(e.pointerId);
    });
    svg.addEventListener('pointercancel', () => {
      dragging = false;
      lastPct = null;
      prog.classList.remove('dragging');
      wrap.classList.remove('adjusting');
    });

    // Clavier : flèches ± 5 (sauf jauge dérivée)
    svg.addEventListener('keydown', e => {
      const t = getTile(svg);
      if (!t || hasChildren(t)) return;
      let delta = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = 5;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -5;
      if (!delta) return;
      e.preventDefault();
      t.pct = Math.max(0, Math.min(100, t.pct + delta));
      recomputeDerived();
      updateFront(card, t);
      updateAncestors(t);
      saveTiles();
    });
  });

  // Titre
  grid.querySelectorAll('.tile-title').forEach(inp => {
    inp.addEventListener('change', e => {
      const t = getTile(e.target);
      if (!t) return;
      t.title = e.target.value;
      e.target.closest('.card').querySelector('.back-title').textContent = e.target.value;
      saveTiles();
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  });

  // Ajout de tag
  grid.querySelectorAll('.tag-input').forEach(inp => {
    const commit = e => {
      const raw = e.target.value.trim();
      if (!raw) return;
      const t = getTile(e.target);
      if (!t) return;
      const tag = findCanonical(raw);
      if (!t.tags.some(x => x.toLowerCase() === tag.toLowerCase())) {
        t.tags.push(tag);
        saveTiles();
        render();
        document.querySelector(`.card[data-id="${t.id}"] .tag-input`)?.focus();
      } else {
        e.target.value = '';
      }
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(e); });
    inp.addEventListener('change', commit);
  });

  // Retrait de tag
  grid.querySelectorAll('.tag-del').forEach(btn => {
    btn.addEventListener('click', e => {
      const t = getTile(e.currentTarget);
      if (!t) return;
      const tag = e.currentTarget.closest('.tag').dataset.tag;
      t.tags = t.tags.filter(x => x !== tag);
      saveTiles();
      render();
    });
  });

  // Suppression d'épique en deux temps : la poubelle arme la confirmation,
  // le bouton rouge la valide. Une seule carte peut être armée à la fois.
  grid.querySelectorAll('.del-tile').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const card = e.currentTarget.closest('.card');
      const t = tiles.find(x => x.id === card.dataset.id);
      if (!t) return;
      const armed = card.classList.contains('confirming');
      clearConfirming();
      if (armed) return;   // second clic sur la poubelle : on désarme
      card.classList.add('confirming');
      // le détachement des filles n'est pas évident : on l'annonce à l'infobulle
      const kids = childrenOf(t.id).length;
      const confirmBtn = card.querySelector('.del-confirm');
      confirmBtn.title = kids
        ? `Supprimer « ${t.title} » et ses tâches. Ses ${kids} carte(s) fille(s) seront détachées, pas supprimées.`
        : `Supprimer « ${t.title} » et ses tâches.`;
      confirmBtn.focus();
    });
  });

  grid.querySelectorAll('.del-confirm').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const t = getTile(e.currentTarget);
      if (!t) return;
      tiles.forEach(x => { if (x.parentId === t.id) x.parentId = null; });
      tiles = tiles.filter(x => x.id !== t.id);
      flipped.delete(t.id);
      recomputeDerived();
      saveTiles();
      render();
    });
  });

  // Cases à cocher : recale le pourcentage (sauf si la jauge est dérivée des filles)
  grid.querySelectorAll('.todo-check').forEach(cb => {
    cb.addEventListener('change', e => {
      const t = getTile(e.target);
      const td = t?.todos.find(x => x.id === e.target.closest('.todo').dataset.todo);
      if (!td) return;
      td.done = e.target.checked;
      e.target.closest('.todo').classList.toggle('checked', td.done);
      if (!hasChildren(t)) {
        t.pct = Math.round(t.todos.filter(x => x.done).length / t.todos.length * 100);
      }
      recomputeDerived();
      updateFront(e.target.closest('.card'), t);
      updateAncestors(t);
      saveTiles();
    });
  });

  // Détachement d'une carte fille de sa mère (verso)
  grid.querySelectorAll('.detach-parent').forEach(btn => {
    btn.addEventListener('click', e => {
      const t = getTile(e.currentTarget);
      if (!t) return;
      t.parentId = null;
      recomputeDerived();
      saveTiles();
      render();
    });
  });

  // Édition du texte d'une tâche ; une tâche vidée est supprimée
  grid.querySelectorAll('.todo-text').forEach(inp => {
    inp.addEventListener('change', e => {
      const t = getTile(e.target);
      const td = t?.todos.find(x => x.id === e.target.closest('.todo').dataset.todo);
      if (!td) return;
      const text = e.target.value.trim();
      if (!text) {
        t.todos = t.todos.filter(x => x.id !== td.id);
        saveTiles();
        render();
        return;
      }
      td.text = text;
      saveTiles();
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  });

  // Suppression d'une tâche
  grid.querySelectorAll('.todo-del').forEach(btn => {
    btn.addEventListener('click', e => {
      const t = getTile(e.currentTarget);
      if (!t) return;
      const todoId = e.currentTarget.closest('.todo').dataset.todo;
      t.todos = t.todos.filter(x => x.id !== todoId);
      saveTiles();
      render();
    });
  });

  // Ajout d'une tâche : crée la ligne puis place le curseur sur son intitulé
  grid.querySelectorAll('.add-todo').forEach(btn => {
    btn.addEventListener('click', e => {
      const t = getTile(e.currentTarget);
      if (!t) return;
      const newId = 'td' + Date.now();
      t.todos.push({ id: newId, text: tr('nouvelleTache'), done: false });
      saveTiles();
      render();
      const inp = document.querySelector(`.card[data-id="${t.id}"] .todo[data-todo="${newId}"] .todo-text`);
      if (inp) { inp.focus(); inp.select(); }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Le bouton de filtres appartient au châssis de la page, pas à la grille
// re-rendue : son écouteur se pose une fois, hors de bindEvents()
document.getElementById('filtersToggle').addEventListener('click', () => {
  filtersOpen = !filtersOpen;
  applyFiltersPanel();
});

function clearConfirming() {
  document.querySelectorAll('.card.confirming')
    .forEach(c => c.classList.remove('confirming'));
}

/* ---------- Export / import ----------
   Le fichier porte un en-tête (format, date) plutôt que le tableau nu :
   un import saura ainsi reconnaître ce qu'on lui donne, et les deux
   formes restent acceptées à la relecture. */
const EXPORT_FORMAT = 'taches/v1';

function noteCfg(texte, erreur) {
  const el = document.getElementById('cfgNote');
  el.textContent = texte;
  el.classList.toggle('erreur', !!erreur);
  clearTimeout(noteCfg.timer);
  noteCfg.timer = setTimeout(() => { el.textContent = ''; }, 6000);
}

document.getElementById('btnExport').addEventListener('click', () => {
  const contenu = JSON.stringify(
    { format: EXPORT_FORMAT, exporte: new Date().toISOString(), tiles }, null, 2);
  const url = URL.createObjectURL(new Blob([contenu], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `taches-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // le révoquer aussitôt annulerait le téléchargement en cours
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const n = tiles.length;
  noteCfg(tr('exportOk', n));
});

const fileImport = document.getElementById('fileImport');
document.getElementById('btnImport').addEventListener('click', () => {
  fileImport.value = '';        // sans quoi réimporter le même fichier ne déclenche rien
  fileImport.click();
});

fileImport.addEventListener('change', () => {
  const fichier = fileImport.files && fileImport.files[0];
  if (!fichier) return;
  const lecteur = new FileReader();
  lecteur.onerror = () => noteCfg(tr('fichierIllisible'), true);
  lecteur.onload = () => {
    let donnees;
    try { donnees = JSON.parse(lecteur.result); }
    catch (e) { noteCfg(tr('jsonInvalide'), true); return; }
    // on accepte l'enveloppe comme le tableau nu
    const liste = normaliseTiles(Array.isArray(donnees) ? donnees : donnees && donnees.tiles);
    if (!liste.length) {
      noteCfg(tr('aucuneCarte'), true);
      return;
    }
    const n = liste.length;
    if (!confirm(tr('confirmImport', tiles.length, n))) return;
    tiles = liste;
    flipped.clear();
    activeFilters.clear();
    recomputeDerived();
    saveTiles();
    render();
    noteCfg(tr('importOk', n));
  };
  lecteur.readAsText(fichier);
});

const cfgToggle = document.getElementById('cfgToggle');
const cfgPanel = document.getElementById('cfgPanel');

function setCfgOpen(open) {
  cfgPanel.hidden = !open;
  cfgToggle.setAttribute('aria-expanded', String(open));
}

cfgToggle.addEventListener('click', e => {
  e.stopPropagation();
  setCfgOpen(cfgPanel.hidden);
});

document.querySelectorAll('.cfg-choice[data-cols]').forEach(btn => {
  btn.addEventListener('click', () => {
    prefs.cols = btn.dataset.cols;
    applyCols();
    savePrefs();
  });
});

document.querySelectorAll('.cfg-lang').forEach(btn => {
  btn.addEventListener('click', () => {
    prefs.lang = btn.dataset.lang;
    applyLang();
    render();          // les libellés vivant dans les cartes
    savePrefs();
  });
});

document.querySelectorAll('.cfg-choice[data-theme]').forEach(btn => {
  btn.addEventListener('click', () => {
    prefs.theme = btn.dataset.theme;
    applyTheme();
    savePrefs();
  });
});

// En mode « Système », suivre l'OS s'il bascule pendant la session
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (prefs.theme === 'system') applyTheme();
});

// Fermeture au clic extérieur et à Échap, comme n'importe quelle popup
document.addEventListener('click', e => {
  if (!cfgPanel.hidden && !e.target.closest('.cfg-anchor')) setCfgOpen(false);
  // un clic hors de la carte armée abandonne la suppression
  if (!e.target.closest('.card.confirming')) clearConfirming();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!cfgPanel.hidden) {
    setCfgOpen(false);
    cfgToggle.focus();
  }
  const armed = document.querySelector('.card.confirming');
  if (armed) {
    clearConfirming();
    armed.querySelector('.del-tile')?.focus();
  }
});

load();
