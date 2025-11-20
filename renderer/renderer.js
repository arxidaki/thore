(() => {
  const stateKey = 'webcropper.feeds.v1';
  const defaultViewport = { width: 1280, height: 720 };
  const defaultCrop = { x: 0, y: 0, width: 480, height: 270 };
  const minCrop = { width: 120, height: 120 };

  const grid = document.getElementById('feed-grid');
  const addButton = document.getElementById('add-feed');

  const modal = document.getElementById('cropper-modal');
  const cropperWebview = document.getElementById('cropper-webview');
  const cropperCanvas = document.getElementById('cropper-canvas');
  const selectionEl = document.getElementById('selection');
  const closeModalBtn = document.getElementById('close-modal');
  const saveCropBtn = document.getElementById('save-crop');
  const modalTitle = document.getElementById('modal-title');
  const modalViewWidth = document.getElementById('modal-view-width');
  const modalViewHeight = document.getElementById('modal-view-height');
  const modalZoom = document.getElementById('modal-zoom');
  const addModal = document.getElementById('add-modal');
  const addUrlInput = document.getElementById('add-url-input');
  const addCancelBtn = document.getElementById('add-cancel');
  const addSaveBtn = document.getElementById('add-save');

  let feeds = [];
  let activeFeedId = null;
  let selection = { ...defaultCrop };
  let viewport = { ...defaultViewport };
  let zoom = 1;
  let dragState = null;
  let ctrlActive = false;
  let dragMove = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function loadState() {
    try {
      const stored = localStorage.getItem(stateKey);
      if (stored) {
        feeds = JSON.parse(stored);
      }
    } catch (err) {
      console.warn('Failed to load state', err);
    }
  }

  function persistState() {
    try {
      localStorage.setItem(stateKey, JSON.stringify(feeds));
    } catch (err) {
      console.warn('Failed to persist state', err);
    }
  }

  function createFeed(url, crop, view) {
    const normalized = normalizeUrl(url);
    const position = getNextPosition();
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : `feed-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url: normalized,
      crop: { ...crop },
      viewport: { ...view },
      scale: 1,
      position,
      createdAt: Date.now()
    };
  }

  function renderFeeds() {
    grid.innerHTML = '';
    if (!feeds.length) {
      const empty = document.createElement('div');
      empty.style.color = 'var(--subtle)';
      empty.style.padding = '40px 0';
      empty.textContent = 'No live crops yet. Add a URL to begin.';
      grid.appendChild(empty);
      return;
    }

    feeds.forEach((feed) => {
      const card = document.createElement('div');
      card.className = 'card';
      const { x = 0, y = 0 } = feed.position || {};
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;

      const stage = document.createElement('div');
      stage.className = 'stage';
      stage.style.width = `${feed.crop.width}px`;
      stage.style.height = `${feed.crop.height}px`;

      const webviewFrame = document.createElement('div');
      webviewFrame.className = 'webview-frame';

      const webview = document.createElement('webview');
      webview.className = 'live-webview';
      webview.setAttribute('allowpopups', '');
      webview.setAttribute('partition', 'persist:live');
      webview.src = feed.url;
      webview.style.width = `${feed.viewport.width}px`;
      webview.style.height = `${feed.viewport.height}px`;
      webview.style.left = `${-feed.crop.x}px`;
      webview.style.top = `${-feed.crop.y}px`;

      webview.addEventListener('dom-ready', () => {
        webview.setZoomFactor(feed.scale);
      });

      webviewFrame.appendChild(webview);
      stage.appendChild(webviewFrame);

      const overlay = document.createElement('div');
      overlay.className = 'reorder-overlay';
      overlay.addEventListener('click', (event) => {
        if (!ctrlActive) return;
        event.preventDefault();
        event.stopPropagation();
      });
      overlay.addEventListener('pointerdown', (event) => {
        if (!ctrlActive) return;
        event.preventDefault();
        event.stopPropagation();
        beginMove(event, feed, card);
      });
      stage.appendChild(overlay);

      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'options-wrap';

      const optionsButton = document.createElement('button');
      optionsButton.className = 'options-trigger';
      optionsButton.type = 'button';
      optionsButton.textContent = '⋯';

      const optionsMenu = document.createElement('div');
      optionsMenu.className = 'options-menu';

      const adjustBtn = document.createElement('button');
      adjustBtn.className = 'ghost';
      adjustBtn.textContent = 'Adjust crop';
      adjustBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllMenus();
        openCropper(feed.id);
      });

      const reloadBtn = document.createElement('button');
      reloadBtn.className = 'ghost';
      reloadBtn.textContent = 'Reload';
      reloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const view = card.querySelector('webview');
        if (view) view.reload();
        closeAllMenus();
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'ghost danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        feeds = feeds.filter((f) => f.id !== feed.id);
        persistState();
        renderFeeds();
      });

      const sliderWrap = document.createElement('div');
      sliderWrap.className = 'slider menu-slider';
      const sliderLabel = document.createElement('span');
      sliderLabel.textContent = 'Zoom';
      const zoomSlider = document.createElement('input');
      zoomSlider.type = 'range';
      zoomSlider.min = '0.5';
      zoomSlider.max = '2';
      zoomSlider.step = '0.05';
      zoomSlider.value = feed.scale.toString();
      zoomSlider.addEventListener('input', (e) => {
        const value = Number(e.target.value);
        feed.scale = value;
        webview.setZoomFactor(value);
        updateMeta();
        persistState();
      });
      sliderWrap.append(sliderLabel, zoomSlider);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const updateMeta = () => {
        meta.textContent = `Crop ${feed.crop.width}×${feed.crop.height} @ ${feed.scale.toFixed(2)}x · Viewport ${feed.viewport.width}×${feed.viewport.height}`;
      };
      updateMeta();

      optionsMenu.append(adjustBtn, reloadBtn, removeBtn, sliderWrap, meta);

      optionsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = optionsMenu.classList.contains('is-open');
        closeAllMenus();
        if (!isOpen) optionsMenu.classList.add('is-open');
      });

      optionsMenu.addEventListener('click', (e) => e.stopPropagation());

      optionsWrap.append(optionsButton, optionsMenu);
      stage.appendChild(optionsWrap);

      card.append(stage);
      grid.appendChild(card);
    });
  }

  function openCropper(feedId) {
    const feed = feeds.find((f) => f.id === feedId);
    if (!feed) return;

    activeFeedId = feedId;
    selection = { ...feed.crop };
    viewport = { ...feed.viewport };
    zoom = feed.scale || 1;

    modalTitle.textContent = `Adjust crop · ${feed.url}`;
    modalViewWidth.value = viewport.width;
    modalViewHeight.value = viewport.height;
    modalZoom.value = zoom.toFixed(2);

    cropperCanvas.style.width = `${viewport.width}px`;
    cropperCanvas.style.height = `${viewport.height}px`;
    cropperWebview.style.width = `${viewport.width}px`;
    cropperWebview.style.height = `${viewport.height}px`;
    cropperWebview.src = feed.url;
    cropperWebview.addEventListener(
      'dom-ready',
      () => {
        cropperWebview.setZoomFactor(zoom);
      },
      { once: true }
    );

    renderSelection();
    modal.classList.remove('hidden');
  }

  function closeCropper() {
    modal.classList.add('hidden');
    activeFeedId = null;
    dragState = null;
  }

  function closeAllMenus() {
    document.querySelectorAll('.options-menu.is-open').forEach((menu) => menu.classList.remove('is-open'));
  }

  function renderSelection() {
    selectionEl.style.width = `${selection.width}px`;
    selectionEl.style.height = `${selection.height}px`;
    selectionEl.style.left = `${selection.x}px`;
    selectionEl.style.top = `${selection.y}px`;
  }

  function beginDrag(event, mode) {
    event.preventDefault();
    dragState = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startSelection: { ...selection }
    };
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', endDrag);
  }

  function onDrag(event) {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    let { x, y, width, height } = dragState.startSelection;

    if (dragState.mode === 'move') {
      x = clamp(x + dx, 0, Math.max(0, viewport.width - width));
      y = clamp(y + dy, 0, Math.max(0, viewport.height - height));
    } else {
      if (dragState.mode.includes('e')) {
        width = clamp(width + dx, minCrop.width, viewport.width - x);
      }
      if (dragState.mode.includes('s')) {
        height = clamp(height + dy, minCrop.height, viewport.height - y);
      }
      if (dragState.mode.includes('w')) {
        const nx = clamp(x + dx, 0, x + width - minCrop.width);
        width = clamp(width - (nx - x), minCrop.width, viewport.width - nx);
        x = nx;
      }
      if (dragState.mode.includes('n')) {
        const ny = clamp(y + dy, 0, y + height - minCrop.height);
        height = clamp(height - (ny - y), minCrop.height, viewport.height - ny);
        y = ny;
      }
    }

    selection = { x, y, width, height };
    renderSelection();
  }

  function endDrag() {
    window.removeEventListener('pointermove', onDrag);
    window.removeEventListener('pointerup', endDrag);
    dragState = null;
  }

  function beginMove(event, feed, card) {
    dragMove = {
      feedId: feed.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...(feed.position || { x: 0, y: 0 }) },
      card
    };
    window.addEventListener('pointermove', onMoveDrag);
    window.addEventListener('pointerup', endMoveDrag);
  }

  function onMoveDrag(event) {
    if (!dragMove) return;
    const dx = event.clientX - dragMove.startX;
    const dy = event.clientY - dragMove.startY;
    const feed = feeds.find((f) => f.id === dragMove.feedId);
    if (!feed) return;
    const x = dragMove.origin.x + dx;
    const y = dragMove.origin.y + dy;
    feed.position = { x, y };
    dragMove.card.style.left = `${x}px`;
    dragMove.card.style.top = `${y}px`;
  }

  function endMoveDrag() {
    if (dragMove) {
      persistState();
    }
    dragMove = null;
    window.removeEventListener('pointermove', onMoveDrag);
    window.removeEventListener('pointerup', endMoveDrag);
  }

  function setCtrlMode(active) {
    ctrlActive = active;
    document.body.classList.toggle('ctrl-mode', ctrlActive);
  }

  function syncViewportInputs() {
    const w = clamp(Number(modalViewWidth.value) || viewport.width, 640, 3840);
    const h = clamp(Number(modalViewHeight.value) || viewport.height, 480, 2400);
    viewport = { width: w, height: h };
    cropperCanvas.style.width = `${w}px`;
    cropperCanvas.style.height = `${h}px`;
    cropperWebview.style.width = `${w}px`;
    cropperWebview.style.height = `${h}px`;
    selection.x = clamp(selection.x, 0, Math.max(0, viewport.width - selection.width));
    selection.y = clamp(selection.y, 0, Math.max(0, viewport.height - selection.height));
    renderSelection();
  }

  function saveCrop() {
    if (!activeFeedId) return;
    const feed = feeds.find((f) => f.id === activeFeedId);
    if (!feed) return;
    const newZoom = clamp(Number(modalZoom.value) || zoom, 0.5, 2);
    feed.crop = { ...selection };
    feed.viewport = { ...viewport };
    feed.scale = newZoom;
    persistState();
    renderFeeds();
    closeCropper();
  }

  function handleAddClick() {
    if (openAddModal()) return;
    const url = window.prompt('Enter page URL');
    if (url) addFeed(url);
  }

  if (addButton) {
    addButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleAddClick();
    });
  } else {
    const fallback = document.createElement('button');
    fallback.id = 'add-feed';
    fallback.className = 'floating-add';
    fallback.textContent = '+';
    fallback.title = 'Add new live crop';
    fallback.style.position = 'fixed';
    fallback.style.bottom = '18px';
    fallback.style.right = '18px';
    document.body.appendChild(fallback);
    fallback.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleAddClick();
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target && target.id === 'add-feed') {
      e.preventDefault();
      e.stopPropagation();
      handleAddClick();
    }
  });

  function openAddModal() {
    if (!addModal || !addUrlInput) return false;
    addModal.classList.remove('hidden');
    addUrlInput.value = '';
    setTimeout(() => addUrlInput.focus(), 30);
    return true;
  }

  function closeAddModal() {
    if (!addModal) return;
    addModal.classList.add('hidden');
  }

  function submitAddModal() {
    const url = addUrlInput.value.trim();
    if (!url) return;
    addFeed(url);
    closeAddModal();
  }

  function addFeed(url) {
    const crop = { ...defaultCrop };
    const viewport = { ...defaultViewport };
    feeds.push(createFeed(url.trim(), crop, viewport));
    persistState();
    renderFeeds();
  }

  function getNextPosition() {
    const count = feeds.length;
    const stepX = 520;
    const stepY = 320;
    const col = count % 3;
    const row = Math.floor(count / 3);
    return { x: col * stepX, y: row * stepY };
  }

  function normalizeUrl(url) {
    const trimmed = url.trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  selectionEl.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.handle');
    const mode = handle ? handle.dataset.dir : 'move';
    beginDrag(event, mode);
  });

  cropperCanvas.addEventListener('pointerdown', (event) => {
    if (event.target === cropperWebview) {
      const rect = cropperCanvas.getBoundingClientRect();
      const x = clamp(event.clientX - rect.left - selection.width / 2, 0, Math.max(0, viewport.width - selection.width));
      const y = clamp(event.clientY - rect.top - selection.height / 2, 0, Math.max(0, viewport.height - selection.height));
      selection = { ...selection, x, y };
      renderSelection();
    }
  });

  closeModalBtn.addEventListener('click', closeCropper);
  saveCropBtn.addEventListener('click', saveCrop);
  modalViewWidth.addEventListener('change', syncViewportInputs);
  modalViewHeight.addEventListener('change', syncViewportInputs);
  modalZoom.addEventListener('change', () => {
    zoom = clamp(Number(modalZoom.value) || 1, 0.5, 2);
    cropperWebview.setZoomFactor(zoom);
  });

  if (addCancelBtn) addCancelBtn.addEventListener('click', closeAddModal);
  if (addSaveBtn) addSaveBtn.addEventListener('click', submitAddModal);
  if (addUrlInput) {
    addUrlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitAddModal();
      }
    });
  }

  document.addEventListener('click', closeAllMenus);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Control') {
      setCtrlMode(true);
    }
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeCropper();
    }
  });

  window.addEventListener('keyup', (event) => {
    if (event.key === 'Control') {
      setCtrlMode(false);
    }
    if (event.key === 'Escape') {
      if (!modal.classList.contains('hidden')) {
        closeCropper();
      }
      if (addModal && !addModal.classList.contains('hidden')) {
        closeAddModal();
      }
    }
  });

  window.addEventListener('blur', () => setCtrlMode(false));

  loadState();
  renderFeeds();
})();
