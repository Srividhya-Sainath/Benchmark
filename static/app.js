const state = {
  currentUser: "",
  images: [],
  filteredImages: [],
  annotations: { version: 1, user: "", items: {}, updated_at: null },
  currentId: null,
  backend: "api",
  zoom: 1,
  rotation: 0,
  saveTimer: null,
  editingQaIds: new Set(),
  pan: null,
  dictation: null,
};

const config = {
  mode: "auto",
  manifestUrl: "./data/images.json",
  hfImageBaseUrl: "",
  staticPassword: "",
  annotationStoragePrefix: "pathologyQaAnnotations",
  speechLanguage: "en-US",
  ...(window.PATHOLOGY_QA_CONFIG || {}),
};

const els = {
  loginScreen: document.getElementById("loginScreen"),
  userNameInput: document.getElementById("userNameInput"),
  passwordInput: document.getElementById("passwordInput"),
  loginError: document.getElementById("loginError"),
  loginButton: document.getElementById("loginButton"),
  logoutButton: document.getElementById("logoutButton"),
  activeUser: document.getElementById("activeUser"),
  datasetFilter: document.getElementById("datasetFilter"),
  completionFilter: document.getElementById("completionFilter"),
  searchInput: document.getElementById("searchInput"),
  imageList: document.getElementById("imageList"),
  progressText: document.getElementById("progressText"),
  progressFill: document.getElementById("progressFill"),
  qaCount: document.getElementById("qaCount"),
  saveStatus: document.getElementById("saveStatus"),
  imageTitle: document.getElementById("imageTitle"),
  imageSubtitle: document.getElementById("imageSubtitle"),
  roiImage: document.getElementById("roiImage"),
  imageStage: document.getElementById("imageStage"),
  imageCanvas: document.getElementById("imageCanvas"),
  metadataStrip: document.getElementById("metadataStrip"),
  qaList: document.getElementById("qaList"),
  annotationSummary: document.getElementById("annotationSummary"),
  notesInput: document.getElementById("notesInput"),
  notesDictateButton: document.querySelector("[data-dictate-notes]"),
  addQaButton: document.getElementById("addQaButton"),
  completeNextButton: document.getElementById("completeNextButton"),
  exportLink: document.getElementById("exportLink"),
  importCsvButton: document.getElementById("importCsvButton"),
  importCsvInput: document.getElementById("importCsvInput"),
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  zoomOutButton: document.getElementById("zoomOutButton"),
  zoomInButton: document.getElementById("zoomInButton"),
  zoomSlider: document.getElementById("zoomSlider"),
  zoomValue: document.getElementById("zoomValue"),
  rotateButton: document.getElementById("rotateButton"),
  fitButton: document.getElementById("fitButton"),
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

function isStaticMode() {
  return state.backend === "static";
}

function resolveAssetUrl(url) {
  return new URL(url, window.location.href).toString();
}

function staticAnnotationKey(user) {
  return `${config.annotationStoragePrefix}:${user}`;
}

function emptyAnnotations(user) {
  return { version: 1, user, items: {}, updated_at: null };
}

function newQa() {
  const now = Date.now();
  return {
    id: `qa_${now}_${Math.random().toString(16).slice(2)}`,
    question: "",
    answer: "",
    _draftQuestion: "",
    _draftAnswer: "",
    created_at: now,
    updated_at: now,
    saved_at: null,
  };
}

function currentImage() {
  return state.images.find((image) => image.id === state.currentId) || null;
}

function currentItem() {
  if (!state.currentId || !state.currentUser) return null;
  if (!state.annotations.items[state.currentId]) {
    state.annotations.items[state.currentId] = { qa: [], notes: "", completed: false, completed_at: null, updated_at: Date.now() };
  }
  const item = state.annotations.items[state.currentId];
  if (!Array.isArray(item.qa)) item.qa = [];
  item.completed = Boolean(item.completed);
  item.completed_at ||= null;
  return item;
}

function compactLabel(image) {
  const metadata = image.metadata || {};
  return metadata.label || image.dataset;
}

function hasAnnotation(imageId) {
  const item = state.annotations.items[imageId];
  if (!item) return false;
  const hasQa = (item.qa || []).some((qa) => isQaSaved(qa));
  return hasQa || Boolean(item.notes?.trim());
}

function isImageComplete(imageId) {
  return Boolean(state.annotations.items[imageId]?.completed);
}

function isQaSaved(qa) {
  return Boolean(qa.saved_at && (qa.question?.trim() || qa.answer?.trim()));
}

function isQaEditing(qa) {
  return state.editingQaIds.has(qa.id) || !isQaSaved(qa);
}

function qaDraftValue(qa, key) {
  const draftKey = key === "question" ? "_draftQuestion" : "_draftAnswer";
  return qa[draftKey] ?? qa[key] ?? "";
}

function normalizeLoadedAnnotations() {
  Object.values(state.annotations.items || {}).forEach((item) => {
    if (!Array.isArray(item.qa)) item.qa = [];
    item.completed = Boolean(item.completed);
    item.completed_at ||= null;
    item.qa.forEach((qa) => {
      qa.id ||= `qa_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      if (!qa.saved_at && (qa.question?.trim() || qa.answer?.trim())) {
        qa.saved_at = qa.updated_at || qa.created_at || Date.now();
      }
      delete qa._draftQuestion;
      delete qa._draftAnswer;
    });
  });
}

function updateStatus(text) {
  els.saveStatus.textContent = text;
}

function setZoom(value) {
  const stage = els.imageStage;
  const before = {
    left: stage.scrollLeft,
    top: stage.scrollTop,
    width: Math.max(1, stage.scrollWidth),
    height: Math.max(1, stage.scrollHeight),
  };
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
  applyImageTransform();
  requestAnimationFrame(() => {
    stage.scrollLeft = (before.left + stage.clientWidth / 2) * (stage.scrollWidth / before.width) - stage.clientWidth / 2;
    stage.scrollTop = (before.top + stage.clientHeight / 2) * (stage.scrollHeight / before.height) - stage.clientHeight / 2;
  });
}

function applyImageTransform() {
  els.imageCanvas.style.setProperty("--zoom", state.zoom);
  els.roiImage.style.transform = `rotate(${state.rotation}deg)`;
  const percent = Math.round(state.zoom * 100);
  els.zoomSlider.value = String(percent);
  els.zoomValue.textContent = `${percent}%`;
  els.zoomOutButton.disabled = state.zoom <= MIN_ZOOM;
  els.zoomInButton.disabled = state.zoom >= MAX_ZOOM;
}

function updateImageBaseSize() {
  const naturalWidth = els.roiImage.naturalWidth;
  const naturalHeight = els.roiImage.naturalHeight;
  if (!naturalWidth || !naturalHeight) return;

  const stageWidth = Math.max(240, els.imageStage.clientWidth - 48);
  const stageHeight = Math.max(220, els.imageStage.clientHeight - 48);
  const fitScale = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight, 1);
  const baseWidth = Math.round(naturalWidth * fitScale);
  const baseHeight = Math.round(naturalHeight * fitScale);

  els.imageCanvas.style.setProperty("--base-width", `${baseWidth}px`);
  els.imageCanvas.style.setProperty("--base-height", `${baseHeight}px`);
  applyImageTransform();
}

function setCurrentImage(imageId, options = {}) {
  state.currentId = imageId;
  state.zoom = 1;
  state.rotation = 0;
  renderAll(options);
}

async function login() {
  const user = cleanTypedName(els.userNameInput.value);
  const password = els.passwordInput.value;
  if (!user || (!isStaticMode() && !password) || (isStaticMode() && config.staticPassword && !password)) return;
  updateStatus("Loading");
  els.loginError.textContent = "";

  if (isStaticMode()) {
    if (config.staticPassword && password !== config.staticPassword) {
      els.loginError.textContent = "Incorrect password";
      updateStatus("Login error");
      return;
    }
    state.currentUser = user;
    state.annotations = loadStaticAnnotations(user);
    state.annotations.user = user;
    state.editingQaIds = new Set();
    normalizeLoadedAnnotations();
    localStorage.setItem("pathologyQaUser", user);
    document.body.classList.add("is-authenticated");
    els.activeUser.textContent = user;
    els.exportLink.href = "#";
    state.currentId = state.filteredImages[0]?.id || state.images[0]?.id || null;
    updateStatus("Saved locally");
    renderAll();
    return;
  }

  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  if (!response.ok) {
    els.loginError.textContent = response.status === 401 ? "Incorrect password" : "Please enter a valid name";
    updateStatus("Login error");
    return;
  }
  state.currentUser = user;
  state.annotations = await response.json();
  state.annotations.user = user;
  state.editingQaIds = new Set();
  normalizeLoadedAnnotations();
  localStorage.setItem("pathologyQaUser", user);
  document.body.classList.add("is-authenticated");
  els.activeUser.textContent = user;
  els.exportLink.href = `/api/export.csv?user=${encodeURIComponent(user)}`;
  state.currentId = state.filteredImages[0]?.id || state.images[0]?.id || null;
  updateStatus("Saved");
  renderAll();
}

function logout() {
  clearTimeout(state.saveTimer);
  state.currentUser = "";
  state.annotations = emptyAnnotations("");
  state.editingQaIds = new Set();
  localStorage.removeItem("pathologyQaUser");
  document.body.classList.remove("is-authenticated");
  els.passwordInput.value = "";
  els.loginError.textContent = "";
  els.activeUser.textContent = "Not selected";
  updateStatus("Choose user");
}

function addQaPair() {
  const item = currentItem();
  if (!item) return;
  const qa = newQa();
  item.qa.push(qa);
  state.editingQaIds.add(qa.id);
  item.updated_at = Date.now();
  renderQa();
  const textarea = els.qaList.querySelector(".qa-item:last-child textarea");
  if (textarea) textarea.focus();
}

function removeQaPair(id) {
  const item = currentItem();
  if (!item) return;
  const qa = item.qa.find((pair) => pair.id === id);
  const wasSaved = qa ? isQaSaved(qa) : false;
  item.qa = item.qa.filter((qa) => qa.id !== id);
  state.editingQaIds.delete(id);
  item.updated_at = Date.now();
  renderQa();
  renderProgress();
  renderImageList();
  if (wasSaved) saveAnnotations();
}

function updateQa(id, key, value) {
  const item = currentItem();
  if (!item) return;
  const qa = item.qa.find((pair) => pair.id === id);
  if (!qa) return;
  if (key === "question") qa._draftQuestion = value;
  if (key === "answer") qa._draftAnswer = value;
  qa.updated_at = Date.now();
  item.updated_at = Date.now();
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function isSpeechSupported() {
  return Boolean(speechRecognitionConstructor());
}

function setDictationButtonState(button, stateName) {
  button.classList.toggle("is-recording", stateName === "listening");
  button.setAttribute("aria-pressed", stateName === "listening" ? "true" : "false");
  button.disabled = stateName === "unavailable";

  if (stateName === "listening") {
    button.textContent = "Listening";
    button.title = "Stop transcribing";
    return;
  }

  if (stateName === "unavailable") {
    button.textContent = "Unavailable";
    button.title = "Speech recognition is unavailable in this browser. Try Chrome or Edge.";
    return;
  }

  button.textContent = "Rec";
  button.title = "Transcribe";
}

function updateDictationControls(root = document) {
  root.querySelectorAll(".dictate-button").forEach((button) => {
    setDictationButtonState(button, isSpeechSupported() ? "ready" : "unavailable");
  });
}

function applyTranscript(textarea, transcript) {
  const base = state.dictation?.baseValue || "";
  const separator = base && transcript ? " " : "";
  textarea.value = `${base}${separator}${transcript}`.replace(/\s+$/g, "");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function stopDictation() {
  const active = state.dictation;
  if (!active) return;
  state.dictation = null;
  setDictationButtonState(active.button, "ready");
  try {
    active.recognition.stop();
  } catch {
    // Recognition may already have stopped.
  }
}

function toggleDictation(button, textarea) {
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) {
    updateStatus("Speech unavailable");
    setDictationButtonState(button, "unavailable");
    return;
  }

  if (state.dictation?.button === button) {
    stopDictation();
    return;
  }
  stopDictation();

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = config.speechLanguage;

  const active = {
    recognition,
    button,
    textarea,
    baseValue: textarea.value.trim(),
    finalTranscript: "",
  };
  state.dictation = active;
  setDictationButtonState(button, "listening");
  textarea.focus();
  updateStatus("Listening");

  recognition.onresult = (event) => {
    if (state.dictation !== active) return;
    let interimTranscript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) {
        active.finalTranscript = `${active.finalTranscript} ${transcript}`.trim();
      } else {
        interimTranscript = `${interimTranscript} ${transcript}`.trim();
      }
    }
    const transcript = `${active.finalTranscript} ${interimTranscript}`.trim();
    applyTranscript(textarea, transcript);
  };

  recognition.onerror = () => {
    if (state.dictation !== active) return;
    updateStatus("Speech error");
    stopDictation();
  };

  recognition.onend = () => {
    if (state.dictation !== active) return;
    state.dictation = null;
    setDictationButtonState(button, "ready");
    updateStatus(isStaticMode() ? "Saved locally" : "Saved");
  };

  try {
    recognition.start();
  } catch {
    updateStatus("Speech error");
    stopDictation();
  }
}

function editQaPair(id) {
  const item = currentItem();
  if (!item) return;
  const qa = item.qa.find((pair) => pair.id === id);
  if (!qa) return;
  qa._draftQuestion = qa.question || "";
  qa._draftAnswer = qa.answer || "";
  state.editingQaIds.add(id);
  renderQa();
}

function cancelQaEdit(id) {
  const item = currentItem();
  if (!item) return;
  const qa = item.qa.find((pair) => pair.id === id);
  if (!qa) return;
  if (!isQaSaved(qa)) {
    removeQaPair(id);
    return;
  }
  delete qa._draftQuestion;
  delete qa._draftAnswer;
  state.editingQaIds.delete(id);
  renderQa();
}

function saveQaPair(id) {
  const item = currentItem();
  if (!item) return;
  const qa = item.qa.find((pair) => pair.id === id);
  if (!qa) return;
  qa.question = qaDraftValue(qa, "question").trim();
  qa.answer = qaDraftValue(qa, "answer").trim();
  if (!qa.question && !qa.answer) return;
  const now = Date.now();
  qa.saved_at = now;
  qa.updated_at = now;
  item.updated_at = now;
  delete qa._draftQuestion;
  delete qa._draftAnswer;
  state.editingQaIds.delete(id);
  renderQa();
  renderProgress();
  renderImageList();
  saveAnnotations();
}

function updateNotes(value) {
  const item = currentItem();
  if (!item) return;
  item.notes = value;
  item.updated_at = Date.now();
  renderProgress();
  renderImageList();
  queueSave();
}

function completeCurrentImageAndNext() {
  const item = currentItem();
  if (!item || !state.currentId) return;

  const before = filteredImages();
  const currentIndex = Math.max(0, before.findIndex((image) => image.id === state.currentId));
  const now = Date.now();
  item.completed = true;
  item.completed_at = item.completed_at || now;
  item.updated_at = now;

  saveAnnotations();

  const after = filteredImages();
  if (!after.length) {
    renderAll({ preserveListScroll: true });
    return;
  }

  const sameImageIndex = after.findIndex((image) => image.id === state.currentId);
  const nextIndex = sameImageIndex >= 0
    ? Math.min(sameImageIndex + 1, after.length - 1)
    : Math.min(currentIndex, after.length - 1);
  setCurrentImage(after[nextIndex].id, { preserveListScroll: true });
}

function queueSave() {
  if (!state.currentUser) return;
  updateStatus("Saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveAnnotations, 350);
}

async function saveAnnotations() {
  try {
    updateStatus("Saving");
    const payload = annotationsForSave();
    if (isStaticMode()) {
      payload.updated_at = Math.floor(Date.now() / 1000);
      localStorage.setItem(staticAnnotationKey(state.currentUser), JSON.stringify(payload));
      state.annotations = payload;
      updateStatus("Saved locally");
      renderProgress();
      renderImageList();
      return;
    }

    const response = await fetch(`/api/annotations?user=${encodeURIComponent(state.currentUser)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Save failed");
    await response.json();
    updateStatus("Saved");
    renderProgress();
    renderImageList();
  } catch (error) {
    updateStatus("Save error");
  }
}

function loadStaticAnnotations(user) {
  try {
    const saved = localStorage.getItem(staticAnnotationKey(user));
    if (!saved) return emptyAnnotations(user);
    const data = JSON.parse(saved);
    if (!data || typeof data !== "object") return emptyAnnotations(user);
    data.version = 1;
    data.user = user;
    if (!data.items || typeof data.items !== "object") data.items = {};
    return data;
  } catch {
    return emptyAnnotations(user);
  }
}

function annotationsForSave() {
  const items = {};
  Object.entries(state.annotations.items || {}).forEach(([imageId, item]) => {
    const qa = (item.qa || [])
      .filter((pair) => isQaSaved(pair))
      .map((pair) => ({
        id: pair.id,
        question: pair.question || "",
        answer: pair.answer || "",
        created_at: pair.created_at || pair.saved_at,
        updated_at: pair.updated_at || pair.saved_at,
        saved_at: pair.saved_at,
      }));
    const notes = item.notes || "";
    const completed = Boolean(item.completed);
    if (qa.length || notes.trim() || completed) {
      items[imageId] = {
        qa,
        notes,
        completed,
        completed_at: item.completed_at || null,
        updated_at: item.updated_at || Date.now(),
      };
    }
  });
  return { version: 1, user: state.currentUser, items };
}

function annotationRows() {
  const imagesById = new Map(state.images.map((image) => [image.id, image]));
  const rows = [];
  Object.entries(state.annotations.items || {}).forEach(([imageId, item]) => {
    const image = imagesById.get(imageId) || {};
    const qaRows = (item.qa || [])
      .filter((qa) => isQaSaved(qa))
      .map((qa, index) => {
      const question = String(qa.question || "").trim();
      const answer = String(qa.answer || "").trim();
      return {
        user: state.currentUser,
        dataset: image.dataset || "",
        filename: image.filename || imageId,
        image_id: imageId,
        qa_index: String(index + 1),
        question,
        answer,
        notes: String(item.notes || "").trim(),
        completed: Boolean(item.completed) ? "true" : "false",
        completed_at: String(item.completed_at || ""),
        updated_at: String(item.updated_at || ""),
      };
    });

    if (qaRows.length) {
      rows.push(...qaRows);
      return;
    }

    if (String(item.notes || "").trim() || item.completed) {
      rows.push({
        user: state.currentUser,
        dataset: image.dataset || "",
        filename: image.filename || imageId,
        image_id: imageId,
        qa_index: "",
        question: "",
        answer: "",
        notes: String(item.notes || "").trim(),
        completed: Boolean(item.completed) ? "true" : "false",
        completed_at: String(item.completed_at || ""),
        updated_at: String(item.updated_at || ""),
      });
    }
  });
  return rows;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  const [header = [], ...body] = rows;
  return body
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(header.map((field, index) => [field, cells[index] || ""])));
}

function truthyCsvValue(value) {
  return ["1", "true", "yes", "complete", "completed"].includes(String(value || "").trim().toLowerCase());
}

function imageIdFromImportRow(row) {
  if (row.image_id) return row.image_id;
  if (row.dataset && row.filename) return `${row.dataset}/${row.filename}`;
  return "";
}

async function importAnnotationsCsv(file) {
  if (!file || !state.currentUser) return;
  try {
    const rows = parseCsv(await file.text());
    const imagesById = new Map(state.images.map((image) => [image.id, image]));
    const imported = new Map();
    const now = Date.now();

    rows.forEach((row) => {
      const imageId = imageIdFromImportRow(row);
      if (!imageId || !imagesById.has(imageId)) return;

      if (!imported.has(imageId)) {
        imported.set(imageId, {
          qa: [],
          notes: row.notes || "",
          completed: truthyCsvValue(row.completed),
          completed_at: row.completed_at ? Number(row.completed_at) || row.completed_at : null,
          updated_at: row.updated_at ? Number(row.updated_at) || row.updated_at : now,
        });
      }

      const item = imported.get(imageId);
      if (row.notes && !item.notes) item.notes = row.notes;
      if (truthyCsvValue(row.completed)) item.completed = true;
      if (row.completed_at && !item.completed_at) item.completed_at = Number(row.completed_at) || row.completed_at;

      const question = String(row.question || "").trim();
      const answer = String(row.answer || "").trim();
      if (!question && !answer) return;
      const timestamp = Number(row.updated_at) || now;
      item.qa.push({
        id: `qa_import_${imageId}_${row.qa_index || item.qa.length + 1}`.replace(/[^A-Za-z0-9_-]+/g, "_"),
        question,
        answer,
        created_at: timestamp,
        updated_at: timestamp,
        saved_at: timestamp,
      });
    });

    if (!imported.size) {
      updateStatus("Import empty");
      return;
    }

    imported.forEach((item, imageId) => {
      state.annotations.items[imageId] = item;
    });
    normalizeLoadedAnnotations();
    saveAnnotations();
    const visibleImages = filteredImages();
    state.currentId = visibleImages.find((image) => imported.has(image.id))?.id || visibleImages[0]?.id || state.currentId;
    renderAll({ preserveListScroll: true });
    updateStatus(`Imported ${imported.size} images`);
  } catch {
    updateStatus("Import error");
  } finally {
    els.importCsvInput.value = "";
  }
}

function exportAnnotationsCsv(event) {
  if (!isStaticMode()) return;
  event.preventDefault();
  const fieldnames = ["user", "dataset", "filename", "image_id", "qa_index", "question", "answer", "notes", "completed", "completed_at", "updated_at"];
  const lines = [
    fieldnames.join(","),
    ...annotationRows().map((row) => fieldnames.map((field) => csvEscape(row[field])).join(",")),
  ];
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const exportName = (state.currentUser || "annotations").replace(/[^A-Za-z0-9_-]+/g, "_");
  link.href = url;
  link.download = `${exportName}_qa_annotations.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function filteredImages() {
  const dataset = els.datasetFilter.value;
  const completion = els.completionFilter.value;
  const query = els.searchInput.value.trim().toLowerCase();
  return state.images.filter((image) => {
    const datasetOk = dataset === "all" || image.dataset === dataset;
    const completeOk =
      completion === "all" ||
      (completion === "complete" && isImageComplete(image.id)) ||
      (completion === "incomplete" && !isImageComplete(image.id));
    const haystack = `${image.filename} ${image.dataset} ${Object.values(image.metadata || {}).join(" ")}`.toLowerCase();
    return datasetOk && completeOk && (!query || haystack.includes(query));
  });
}

function renderImageList(options = {}) {
  const scrollTop = els.imageList.scrollTop;
  state.filteredImages = filteredImages();
  els.imageList.innerHTML = "";

  state.filteredImages.forEach((image) => {
    const button = document.createElement("button");
    const isComplete = isImageComplete(image.id);
    button.className = `image-row ${image.id === state.currentId ? "active" : ""} ${hasAnnotation(image.id) ? "done" : ""} ${isComplete ? "complete" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(image.filename)}${isComplete ? `<span class="complete-check" title="Complete" aria-label="Complete">✓</span>` : ""}</strong>
        <span>${escapeHtml(compactLabel(image))}</span>
      </span>
      <span class="dataset-pill">${escapeHtml(image.dataset)}</span>
    `;
    button.addEventListener("click", () => setCurrentImage(image.id, { preserveListScroll: true }));
    els.imageList.appendChild(button);
  });

  if (options.preserveScroll) {
    els.imageList.scrollTop = scrollTop;
  }
}

function renderDatasetOptions() {
  const datasets = [...new Set(state.images.map((image) => image.dataset))].sort();
  datasets.forEach((dataset) => {
    const option = document.createElement("option");
    option.value = dataset;
    option.textContent = dataset;
    els.datasetFilter.appendChild(option);
  });
}

function renderProgress() {
  const images = filteredImages();
  const visibleIds = new Set(images.map((image) => image.id));
  const completed = images.filter((image) => isImageComplete(image.id)).length;
  const total = images.length;
  const qaTotal = Object.entries(state.annotations.items || {}).reduce((count, [imageId, item]) => {
    if (!visibleIds.has(imageId)) return count;
    return count + (item.qa || []).filter((qa) => isQaSaved(qa)).length;
  }, 0);
  els.progressText.textContent = `${completed} of ${total} completed`;
  els.qaCount.textContent = `${qaTotal} Q&A`;
  els.progressFill.style.width = total ? `${(completed / total) * 100}%` : "0%";
}

function renderSelectedImage() {
  const image = currentImage();
  if (!image) {
    els.imageTitle.textContent = "No image selected";
    els.imageSubtitle.textContent = "";
    els.roiImage.removeAttribute("src");
    els.roiImage.alt = "Selected ROI";
    els.metadataStrip.innerHTML = "";
    return;
  }
  els.imageTitle.textContent = image.filename;
  els.imageSubtitle.textContent = `${image.dataset} / ${compactLabel(image)}`;
  els.roiImage.src = image.url;
  els.roiImage.alt = image.filename;
  els.imageStage.scrollLeft = 0;
  els.imageStage.scrollTop = 0;
  applyImageTransform();

  const metadata = image.metadata || {};
  const entries = Object.entries(metadata).filter(([key]) => key !== "file_name");
  els.metadataStrip.innerHTML = entries.length
    ? entries.map(([key, value]) => `<span class="meta-chip"><b>${escapeHtml(prettyKey(key))}</b> ${escapeHtml(value)}</span>`).join("")
    : `<span class="meta-chip"><b>Dataset</b> ${escapeHtml(image.dataset)}</span>`;
}

function renderAnnotationSummary() {
  const item = currentItem();
  const count = item ? item.qa.filter((qa) => isQaSaved(qa)).length : 0;
  els.annotationSummary.textContent = `${count} ${count === 1 ? "pair" : "pairs"} on this image`;
}

function renderQa() {
  const item = currentItem();
  els.qaList.innerHTML = "";
  if (!item || item.qa.length === 0) {
    els.qaList.innerHTML = `<div class="empty-state">No questions yet</div>`;
  } else {
    item.qa.forEach((qa, index) => {
      const wrapper = document.createElement("div");
      const editing = isQaEditing(qa);
      wrapper.className = `qa-item ${editing ? "is-editing" : "is-saved"}`;
      if (editing) {
        wrapper.innerHTML = `
        <div class="qa-top">
          <span class="qa-number">${isQaSaved(qa) ? `Editing pair ${index + 1}` : `New pair ${index + 1}`}</span>
          <button class="remove-button" title="Remove pair" aria-label="Remove pair">x</button>
        </div>
        <label class="field">
          <div class="field-head">
            <span>Question</span>
            <button class="dictate-button" type="button" data-dictate-field="question" title="Transcribe question" aria-label="Transcribe question">Rec</button>
          </div>
          <textarea rows="3" data-field="question" placeholder="Question">${escapeHtml(qaDraftValue(qa, "question"))}</textarea>
        </label>
        <label class="field">
          <div class="field-head">
            <span>Answer</span>
            <button class="dictate-button" type="button" data-dictate-field="answer" title="Transcribe answer" aria-label="Transcribe answer">Rec</button>
          </div>
          <textarea rows="4" data-field="answer" placeholder="Answer">${escapeHtml(qaDraftValue(qa, "answer"))}</textarea>
        </label>
        <div class="qa-actions">
          <button class="text-button qa-cancel-button" type="button">Cancel</button>
          <button class="primary-button qa-save-button" type="button">Save</button>
        </div>
      `;
        wrapper.querySelector(".remove-button").addEventListener("click", () => removeQaPair(qa.id));
        wrapper.querySelector(".qa-cancel-button").addEventListener("click", () => cancelQaEdit(qa.id));
        wrapper.querySelector(".qa-save-button").addEventListener("click", () => saveQaPair(qa.id));
        wrapper.querySelectorAll("textarea").forEach((textarea) => {
          textarea.addEventListener("input", (event) => updateQa(qa.id, event.target.dataset.field, event.target.value));
        });
        wrapper.querySelectorAll("[data-dictate-field]").forEach((button) => {
          const textarea = wrapper.querySelector(`textarea[data-field="${button.dataset.dictateField}"]`);
          button.addEventListener("click", () => toggleDictation(button, textarea));
        });
        updateDictationControls(wrapper);
      } else {
        wrapper.innerHTML = `
          <div class="qa-saved-row">
            <div class="qa-saved-copy">
              <div class="qa-saved-title">Pair ${index + 1}</div>
              <p><b>Q</b> ${escapeHtml(qa.question || "")}</p>
              <p><b>A</b> ${escapeHtml(qa.answer || "")}</p>
            </div>
            <div class="qa-saved-actions">
              <button class="text-button qa-edit-button" type="button">Edit</button>
              <button class="remove-button" title="Remove pair" aria-label="Remove pair">x</button>
            </div>
          </div>
        `;
        wrapper.querySelector(".qa-edit-button").addEventListener("click", () => editQaPair(qa.id));
        wrapper.querySelector(".remove-button").addEventListener("click", () => removeQaPair(qa.id));
      }
      els.qaList.appendChild(wrapper);
    });
  }
  els.notesInput.value = item?.notes || "";
  renderAnnotationSummary();
}

function renderAll(options = {}) {
  renderImageList({ preserveScroll: options.preserveListScroll });
  renderProgress();
  renderSelectedImage();
  renderQa();
}

function applyImageFilters() {
  renderImageList();
  renderProgress();
  if (state.filteredImages.some((image) => image.id === state.currentId)) return;
  setCurrentImage(state.filteredImages[0]?.id || null);
}

function moveSelection(delta) {
  if (!state.filteredImages.length) return;
  const currentIndex = state.filteredImages.findIndex((image) => image.id === state.currentId);
  const nextIndex = Math.max(0, Math.min(state.filteredImages.length - 1, currentIndex + delta));
  setCurrentImage(state.filteredImages[nextIndex].id);
}

function canPanImage() {
  return els.imageStage.scrollWidth > els.imageStage.clientWidth || els.imageStage.scrollHeight > els.imageStage.clientHeight;
}

function startImagePan(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (!canPanImage()) return;
  state.pan = {
    x: event.clientX,
    y: event.clientY,
    left: els.imageStage.scrollLeft,
    top: els.imageStage.scrollTop,
  };
  els.imageStage.classList.add("is-panning");
  els.imageStage.setPointerCapture?.(event.pointerId);
}

function moveImagePan(event) {
  if (!state.pan) return;
  event.preventDefault();
  els.imageStage.scrollLeft = state.pan.left - (event.clientX - state.pan.x);
  els.imageStage.scrollTop = state.pan.top - (event.clientY - state.pan.y);
}

function stopImagePan(event) {
  if (!state.pan) return;
  state.pan = null;
  els.imageStage.classList.remove("is-panning");
  els.imageStage.releasePointerCapture?.(event.pointerId);
}

function prettyKey(key) {
  return key.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanTypedName(value) {
  return value.trim().replace(/\s+/g, " ");
}

function encodePath(path) {
  return String(path)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function imageUrlFromManifest(image) {
  const relPath = image.hf_path || image.path || `${image.dataset}/${image.filename}`;
  if (config.hfImageBaseUrl) {
    return `${normalizeImageUrl(config.hfImageBaseUrl).replace(/\/+$/, "")}/${encodePath(relPath)}`;
  }
  if (image.url) return normalizeImageUrl(image.url);
  return relPath;
}

function normalizeImageUrl(url) {
  return String(url).replace("/tree/", "/resolve/").replace("/blob/", "/resolve/");
}

async function loadStaticImages() {
  const response = await fetch(resolveAssetUrl(config.manifestUrl));
  if (!response.ok) throw new Error("Static manifest not found");
  const payload = await response.json();
  const images = Array.isArray(payload.images) ? payload.images : [];
  return images.map((image) => ({
    id: image.id || `${image.dataset}/${image.filename}`,
    dataset: image.dataset || "Dataset",
    filename: image.filename || "",
    url: imageUrlFromManifest(image),
    metadata: image.metadata || {},
  }));
}

async function loadImages() {
  if (config.mode === "static") {
    state.backend = "static";
    return loadStaticImages();
  }

  try {
    const imagesResponse = await fetch("/api/images");
    if (!imagesResponse.ok) throw new Error("API manifest not available");
    const imagePayload = await imagesResponse.json();
    state.backend = "api";
    return imagePayload.images || [];
  } catch (error) {
    if (config.mode === "api") throw error;
    state.backend = "static";
    return loadStaticImages();
  }
}

function configureBackendUi() {
  if (isStaticMode()) {
    els.passwordInput.placeholder = "Password";
    els.loginButton.disabled = !cleanTypedName(els.userNameInput.value) || Boolean(config.staticPassword && !els.passwordInput.value);
    updateStatus("Static mode");
  } else {
    els.passwordInput.placeholder = "Password";
    els.loginButton.disabled = !cleanTypedName(els.userNameInput.value) || !els.passwordInput.value;
  }
}

function bindEvents() {
  els.loginButton.addEventListener("click", login);
  [els.userNameInput, els.passwordInput].forEach((input) => {
    input.addEventListener("input", () => {
      configureBackendUi();
      els.loginError.textContent = "";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !els.loginButton.disabled) login();
    });
  });
  els.logoutButton.addEventListener("click", logout);
  els.exportLink.addEventListener("click", exportAnnotationsCsv);
  els.importCsvButton.addEventListener("click", () => els.importCsvInput.click());
  els.importCsvInput.addEventListener("change", (event) => importAnnotationsCsv(event.target.files?.[0]));
  els.datasetFilter.addEventListener("change", applyImageFilters);
  els.completionFilter.addEventListener("change", applyImageFilters);
  els.searchInput.addEventListener("input", () => {
    applyImageFilters();
  });
  els.addQaButton.addEventListener("click", addQaPair);
  els.completeNextButton.addEventListener("click", completeCurrentImageAndNext);
  els.notesInput.addEventListener("input", (event) => updateNotes(event.target.value));
  els.notesDictateButton.addEventListener("click", () => toggleDictation(els.notesDictateButton, els.notesInput));
  els.prevButton.addEventListener("click", () => moveSelection(-1));
  els.nextButton.addEventListener("click", () => moveSelection(1));
  els.zoomOutButton.addEventListener("click", () => {
    setZoom(state.zoom - ZOOM_STEP);
  });
  els.zoomInButton.addEventListener("click", () => {
    setZoom(state.zoom + ZOOM_STEP);
  });
  els.zoomSlider.addEventListener("input", (event) => {
    setZoom(Number(event.target.value) / 100);
  });
  els.imageStage.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    event.preventDefault();
    setZoom(state.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }, { passive: false });
  els.imageStage.addEventListener("dblclick", () => {
    setZoom(1);
  });
  els.imageStage.addEventListener("pointerdown", startImagePan);
  els.imageStage.addEventListener("pointermove", moveImagePan);
  els.imageStage.addEventListener("pointerup", stopImagePan);
  els.imageStage.addEventListener("pointerleave", stopImagePan);
  els.imageStage.addEventListener("pointercancel", stopImagePan);
  els.roiImage.addEventListener("load", updateImageBaseSize);
  window.addEventListener("resize", updateImageBaseSize);
  els.rotateButton.addEventListener("click", () => {
    state.rotation = (state.rotation + 90) % 360;
    applyImageTransform();
  });
  els.fitButton.addEventListener("click", () => {
    state.rotation = 0;
    setZoom(1);
  });
}

async function init() {
  bindEvents();
  updateDictationControls();
  els.loginButton.disabled = true;
  state.images = await loadImages();
  configureBackendUi();
  renderDatasetOptions();
  state.filteredImages = filteredImages();
  state.currentId = state.filteredImages[0]?.id || null;
  updateStatus(isStaticMode() ? "Static mode" : "Choose user");
  renderAll();

  const previousUser = localStorage.getItem("pathologyQaUser");
  if (previousUser) {
    els.userNameInput.value = previousUser;
    configureBackendUi();
  }
}

init().catch(() => updateStatus("Load error"));
