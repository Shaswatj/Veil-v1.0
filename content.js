const STORAGE_KEY = 'youtubeVideoBackdropEnabled';
const BACKDROP_ID = 'youtube-video-backdrop-video';
const BACKDROP_TOGGLE_ID = 'youtube-video-backdrop-toggle';
const MAIN_VIDEO_SELECTOR = 'video.video-stream.html5-main-video';
const YOUTUBE_VIDEO_DIAGNOSTIC_EVENTS = ['loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'ended', 'emptied', 'loadstart', 'canplay', 'waiting'];
let trackedYouTubeVideoElement = null;
let trackedYouTubeVideoSource = null;
let youtubeVideoSourceChangePending = false;
const youtubeVideoDiagnosticIds = new WeakMap();
let youtubeVideoDiagnosticIdCounter = 0;
let mainVideoReplacementObserver = null;
let lastObservedYouTubeVideoElementForDiagnostics = null;
let lastObservedBackdropMediaStream = null;
let lastObservedBackdropCurrentTime = 0;
let backdropDiagnosticFollowupTimer = null;
let backdropFrameCallbackCount = 0;
let backdropFrameSamplesBeforeNavigation = [];
let backdropFrameSwitchReport = null;
let lastFrameDiagnosticUrl = window.location.href;
let postSwitchDiagnosticSampler = null;
let postSwitchFrameDiagnosticCallbackId = null;
let postSwitchFrameDiagnosticVideo = null;
let postSwitchSourceFrameDiagnosticCallbackId = null;
let postSwitchSourceFrameDiagnosticVideo = null;
let postSwitchSourceFrameDiagnosticCount = 0;
let postSwitchBackdropFrameDiagnosticCount = 0;
let backdropVideoMonitorStream = null;
let backdropVideoDiagnosticEventListeners = [];


const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const message = args[0];
  if (typeof message === 'string' && message.startsWith('[Backdrop Diagnostic]')) {
    const keepDiagnostic =
      message.startsWith('[Backdrop Diagnostic] COLLECTOR ARMED ') ||
      message.startsWith('[Backdrop Diagnostic] POST-SWITCH SAMPLE ');
    if (!keepDiagnostic) {
      return;
    }
  }

  originalConsoleLog(...args);
};

function isWatchPage() {
  return /\/watch(\?|$)/.test(window.location.pathname || '') || /\/watch\?/.test(window.location.href || '');
}

function readStorageValue() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        resolve(Boolean(result[STORAGE_KEY]));
      });
      return;
    }

    resolve(localStorage.getItem(STORAGE_KEY) === 'true');
  });
}

function updateBackdropToggleButtonState(enabled) {
  const button = document.getElementById(BACKDROP_TOGGLE_ID);
  if (!button) {
    return;
  }

  const isEnabled = Boolean(enabled);
  const stateLabel = isEnabled ? 'On' : 'Off';
  button.title = `Backdrop: ${stateLabel}`;
  button.setAttribute('aria-label', `Backdrop: ${stateLabel}`);
  button.setAttribute('aria-pressed', String(isEnabled));

  const track = button.querySelector('[data-backdrop-toggle-track]');
  if (track) {
    track.style.backgroundColor = isEnabled ? '#f2f2f2' : 'transparent';
    track.style.borderColor = isEnabled ? '#f2f2f2' : 'rgba(255, 255, 255, 1)';
  }

  const indicator = button.querySelector('[data-backdrop-state-indicator]');
  if (indicator) {
    indicator.style.transform = isEnabled ? 'translateX(10px)' : 'translateX(0)';
    indicator.style.backgroundColor = isEnabled ? '#242424' : '#f2f2f2';
  }
}

function ensureBackdropToggleButton() {
  const controls = document.querySelector('#movie_player .ytp-right-controls');
  if (!controls) {
    return;
  }

  let button = document.getElementById(BACKDROP_TOGGLE_ID);
  const isNewButton = !button;
  if (!button) {
    button = document.createElement('button');
    button.id = BACKDROP_TOGGLE_ID;
    button.type = 'button';
    button.className = 'ytp-button';
    button.innerHTML = '<span data-backdrop-toggle-track aria-hidden="true" style="display:block;position:relative;box-sizing:border-box;width:26px;height:16px;margin:0 auto;border:2.25px solid rgba(255,255,255,1);border-radius:999px;background-color:transparent;transition:background-color 180ms cubic-bezier(0.2,0,0,1),border-color 180ms cubic-bezier(0.2,0,0,1);"><span data-backdrop-state-indicator style="position:absolute;left:2px;top:1.25px;width:9px;height:9px;border-radius:50%;background-color:#f2f2f2;transform:translateX(0);transition:transform 180ms cubic-bezier(0.2,0,0,1),background-color 180ms cubic-bezier(0.2,0,0,1);"></span></span>';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return;
      }

      chrome.storage.local.get([STORAGE_KEY], (result) => {
        chrome.storage.local.set({ [STORAGE_KEY]: !Boolean(result[STORAGE_KEY]) });
      });
    });
  }

  const fullscreenButton = controls.querySelector('.ytp-fullscreen-button');
  const insertionContainer = fullscreenButton && fullscreenButton.parentElement
    ? fullscreenButton.parentElement
    : controls.querySelector('.ytp-right-controls-right') || controls;
  const fullscreenAnchor = fullscreenButton && fullscreenButton.parentElement === insertionContainer
    ? fullscreenButton
    : null;
  const alreadyInPosition = button.parentElement === insertionContainer &&
    (fullscreenAnchor ? button.nextElementSibling === fullscreenAnchor : button === insertionContainer.lastElementChild);
  if (!alreadyInPosition) {
    insertionContainer.insertBefore(button, fullscreenAnchor);
  }

  if (isNewButton) {
    readStorageValue().then(updateBackdropToggleButtonState);
  }
}

function logBackdropState() {
  const backdrop = document.getElementById(BACKDROP_ID);
  if (!backdrop) {
    console.log('[Backdrop Diagnostic] Backdrop not found');
    return;
  }

  const style = window.getComputedStyle(backdrop);
  const rect = backdrop.getBoundingClientRect();
  console.log('[Backdrop Diagnostic] Backdrop', {
    tagName: backdrop.tagName,
    id: backdrop.id,
    className: backdrop.className,
    parentTagName: backdrop.parentElement ? backdrop.parentElement.tagName : null,
    parentId: backdrop.parentElement ? backdrop.parentElement.id : null,
    parentClassName: backdrop.parentElement ? backdrop.parentElement.className : null,
    position: style.position,
    zIndex: style.zIndex,
    opacity: style.opacity,
    visibility: style.visibility,
    display: style.display,
    width: style.width,
    height: style.height,
    background: style.background,
    boundingClientRect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom
    }
  });
}

function logAncestorChain(element) {
  let current = element;
  let level = 0;

  while (current && current !== document.documentElement && level < 30) {
    const style = window.getComputedStyle(current);
    const stackingContext =
      style.position !== 'static' ||
      style.zIndex !== 'auto' ||
      style.opacity !== '1' ||
      style.transform !== 'none' ||
      style.filter !== 'none' ||
      style.isolation === 'isolate' ||
      style.mixBlendMode !== 'normal' ||
      style.transformStyle === 'preserve-3d' ||
      style.perspective !== 'none';

    console.log('[Backdrop Diagnostic] Ancestor', {
      level: level + 1,
      tag: current.tagName,
      id: current.id,
      className: current.className,
      position: style.position,
      zIndex: style.zIndex,
      opacity: style.opacity,
      transform: style.transform,
      filter: style.filter,
      isolation: style.isolation,
      overflow: style.overflow,
      backgroundColor: style.backgroundColor,
      stackingContext: stackingContext ? 'likely' : 'unlikely'
    });

    current = current.parentElement;
    level += 1;
  }

  if (current) {
    const style = window.getComputedStyle(current);
    console.log('[Backdrop Diagnostic] Ancestor', {
      level: level + 1,
      tag: current.tagName,
      id: current.id,
      className: current.className,
      position: style.position,
      zIndex: style.zIndex,
      opacity: style.opacity,
      transform: style.transform,
      filter: style.filter,
      isolation: style.isolation,
      overflow: style.overflow,
      backgroundColor: style.backgroundColor,
      stackingContext: 'html root'
    });
  }
}

function logPageLayers() {
  const targets = ['html', 'body', '#page-manager', '#content', '#masthead-container', '#player', '#player-wrap', '#player-api', '#movie_player'];

  targets.forEach((selector) => {
    const element = document.querySelector(selector);
    if (!element) {
      return;
    }

    const style = window.getComputedStyle(element);
    console.log(`[Backdrop Diagnostic] ${selector}`, {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      position: style.position,
      zIndex: style.zIndex,
      opacity: style.opacity,
      transform: style.transform,
      isolation: style.isolation,
      backgroundColor: style.backgroundColor
    });
  });
}

function getStackingContextSummary(element) {
  if (!(element instanceof Element)) {
    return null;
  }

  const style = window.getComputedStyle(element);
  const willChangeProperties = style.willChange.split(',').map((property) => property.trim());
  const stackingContext =
    ((style.position === 'absolute' || style.position === 'relative' || style.position === 'fixed' || style.position === 'sticky') && style.zIndex !== 'auto') ||
    ((style.display === 'flex' || style.display === 'inline-flex' || style.display === 'grid' || style.display === 'inline-grid') && style.zIndex !== 'auto') ||
    style.opacity !== '1' ||
    style.transform !== 'none' ||
    style.filter !== 'none' ||
    style.mixBlendMode !== 'normal' ||
    style.isolation === 'isolate' ||
    /(^|\s)(layout|paint|strict|content)(\s|$)/.test(style.contain) ||
    style.perspective !== 'none' ||
    style.clipPath !== 'none' ||
    style.maskImage !== 'none' ||
    style.webkitMaskImage !== 'none' ||
    willChangeProperties.some((property) => ['opacity', 'transform', 'filter', 'perspective', 'clip-path', 'mix-blend-mode'].includes(property));

  return {
    tagName: element.tagName,
    id: element.id,
    className: element.className,
    position: style.position,
    zIndex: style.zIndex,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    backgroundColor: style.backgroundColor,
    transform: style.transform,
    filter: style.filter,
    mixBlendMode: style.mixBlendMode,
    isolation: style.isolation,
    contain: style.contain,
    willChange: style.willChange,
    perspective: style.perspective,
    clipPath: style.clipPath,
    transformStyle: style.transformStyle,
    backdropFilter: style.backdropFilter,
    overflow: style.overflow,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    stackingContext: stackingContext ? 'likely' : 'unlikely'
  };
}

function logElementDebugInfo(element, label) {
  if (!(element instanceof Element)) {
    console.log('[Backdrop Diagnostic] Missing element for', label, null);
    return;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  console.log(`[Backdrop Diagnostic] ${label}`, {
    ...getStackingContextSummary(element),
    parentElement: element.parentElement ? element.parentElement.tagName : null,
    parentId: element.parentElement ? element.parentElement.id : null,
    parentClassName: element.parentElement ? element.parentElement.className : null,
    parent: element.parentElement,
    boundingClientRect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom
    },
    pointerEvents: style.pointerEvents
  });
}

function logStackingAncestors(startElement, label) {
  if (!(startElement instanceof Element)) {
    console.log('[Backdrop Diagnostic] No ancestor chain for', label);
    return;
  }

  console.log(`[Backdrop Diagnostic] Ancestor chain for ${label}`);

  let current = startElement.parentElement;
  let level = 0;

  while (current && level < 30) {
    console.log(`[Backdrop Diagnostic] ancestor ${level}`, getStackingContextSummary(current));
    current = current.parentElement;
    level += 1;
  }
}

function logBackdropAncestorDiagnostics() {
  const backdrop = document.getElementById(BACKDROP_ID);
  if (!backdrop) {
    console.log('[Backdrop Diagnostic] Backdrop not found for ancestor diagnostics');
    return;
  }

  logElementDebugInfo(backdrop, 'Backdrop');
  logStackingAncestors(backdrop, 'backdrop');
}

function logYouTubePlayerAncestorDiagnostics() {
  const video = document.querySelector('video.video-stream.html5-main-video');
  if (!video) {
    console.log('[Backdrop Diagnostic] YouTube main video not found for ancestor diagnostics');
    return;
  }

  logElementDebugInfo(video, 'YouTube main video');
  logStackingAncestors(video, 'YouTube main video');
}

function logImportantLayerElements() {
  const selectors = ['#page-manager', '#player', '#movie_player', '.html5-video-container', 'video.video-stream.html5-main-video', 'ytd-watch-metadata h1, #title.ytd-watch-metadata, #title h1'];

  selectors.forEach((selector) => {
    const element = document.querySelector(selector);
    if (element) {
      logElementDebugInfo(element, selector);
    }
  });
}

function logHitTestAt(label, element) {
  if (!(element instanceof Element)) {
    console.log(`[Backdrop Diagnostic] ${label} hit test unavailable`, null);
    return;
  }

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hits = document.elementsFromPoint(x, y) || [];
  const firstHit = document.elementFromPoint(x, y);

  console.log(`[Backdrop Diagnostic] ${label} hit test`, {
    point: { x, y },
    targetRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    elementFromPoint: firstHit ? {
      tagName: firstHit.tagName,
      id: firstHit.id,
      className: firstHit.className,
      zIndex: window.getComputedStyle(firstHit).zIndex,
      position: window.getComputedStyle(firstHit).position
    } : null,
    elementsFromPoint: hits.map((hit) => ({
      tagName: hit.tagName,
      id: hit.id,
      className: hit.className,
      zIndex: window.getComputedStyle(hit).zIndex,
      position: window.getComputedStyle(hit).position
    }))
  });
}

function logViewportHitTest() {
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const hit = document.elementFromPoint(centerX, centerY);
  const hits = document.elementsFromPoint(centerX, centerY) || [];

  console.log('[Backdrop Diagnostic] elementFromPoint center', hit ? {
    tagName: hit.tagName,
    id: hit.id,
    className: hit.className,
    position: window.getComputedStyle(hit).position,
    zIndex: window.getComputedStyle(hit).zIndex,
    backgroundColor: window.getComputedStyle(hit).backgroundColor
  } : null);

  console.log('[Backdrop Diagnostic] elementsFromPoint center', hits.map((element) => ({
    tagName: element.tagName,
    id: element.id,
    className: element.className,
    zIndex: window.getComputedStyle(element).zIndex,
    position: window.getComputedStyle(element).position
  })));

  const video = document.querySelector('video.video-stream.html5-main-video');
  const normalUi = document.querySelector('ytd-watch-metadata h1, #title.ytd-watch-metadata, #title h1');
  logHitTestAt('YouTube video center', video);
  logHitTestAt('Normal YouTube UI center', normalUi);
}

function restoreHtmlBackground() {
  const html = document.documentElement;
  if (!html) {
    return;
  }

  const previousValue = html.dataset.youtubeBackdropPreviousHtmlBackgroundColor;
  if (previousValue === undefined || previousValue === '') {
    html.style.removeProperty('background-color');
    delete html.dataset.youtubeBackdropPreviousHtmlBackgroundColor;
    console.log('[Backdrop] HTML background restored');
    return;
  }

  html.style.backgroundColor = previousValue;
  delete html.dataset.youtubeBackdropPreviousHtmlBackgroundColor;
  console.log('[Backdrop] HTML background restored');
}

function makeHtmlBackgroundTransparent() {
  const html = document.documentElement;
  if (!html) {
    return;
  }

  const previousValue = html.style.backgroundColor || getComputedStyle(html).backgroundColor;
  html.dataset.youtubeBackdropPreviousHtmlBackgroundColor = previousValue;
  html.style.backgroundColor = 'transparent';
  console.log('[Backdrop] HTML background made transparent');
}

function disconnectMainVideoReplacementObserver() {
  if (mainVideoReplacementObserver) {
    mainVideoReplacementObserver.disconnect();
    mainVideoReplacementObserver = null;
    console.log('[Backdrop Diagnostic] Main YouTube video replacement observer disconnected');
  }
}

function getCurrentMainYouTubeVideo() {
  return document.querySelector(MAIN_VIDEO_SELECTOR);
}

function getYouTubeVideoDiagnosticId(video) {
  if (!youtubeVideoDiagnosticIds.has(video)) {
    youtubeVideoDiagnosticIdCounter += 1;
    youtubeVideoDiagnosticIds.set(video, `video-${youtubeVideoDiagnosticIdCounter}`);
  }

  return youtubeVideoDiagnosticIds.get(video);
}

function logYouTubeCaptureStreamCall(video, stream, caller) {
  console.log(`[YouTube captureStream Diagnostic] timestamp=${new Date().toISOString()} caller=${caller} videoIdentity=${getYouTubeVideoDiagnosticId(video)} currentSrc=${video.currentSrc || 'N/A'} streamId=${stream && stream.id ? stream.id : 'N/A'}`);
}

function getBackdropStreamTrace(stream) {
  let tracks = [];
  if (stream && typeof stream.getTracks === 'function') {
    try {
      tracks = stream.getTracks().map((track) => ({
        kind: track.kind,
        id: track.id,
        readyState: track.readyState
      }));
    } catch (error) {
      tracks = [];
    }
  }

  return {
    streamId: stream && stream.id ? stream.id : null,
    tracks,
    stack: new Error().stack
  };
}

function logBackdropCaptureStreamTrace(stream, caller) {
  console.log('[Backdrop captureStream Trace]', {
    caller,
    ...getBackdropStreamTrace(stream)
  });
}

function logBackdropAssignmentTrace(stream, caller, action) {
  const streamTrace = getBackdropStreamTrace(stream);
  console.log(`[Backdrop Assignment Trace] ${JSON.stringify({
    action,
    caller,
    streamId: streamTrace.streamId,
    trackCount: streamTrace.tracks.length,
    tracks: streamTrace.tracks,
    stack: streamTrace.stack
  })}`);
}

function attachNewestBackdropStream(backdropVideo, newStream, caller) {
  const oldStream = backdropVideo.srcObject;
  if (oldStream && typeof oldStream.getTracks === 'function') {
    oldStream.getTracks().forEach((track) => {
      if (!track || typeof track.stop !== 'function') {
        return;
      }

      console.log('[Backdrop Cleanup] stopping old track', track.kind);
      try {
        track.stop();
      } catch {
      }
    });
  }

  logBackdropAssignmentTrace(null, caller, 'clear');
  backdropVideo.srcObject = null;
  logBackdropAssignmentTrace(newStream, caller, 'attach');
  backdropVideo.srcObject = newStream;
}

function bindBackdropToVideo(backdrop, video) {
  if (!backdrop || !(video instanceof HTMLVideoElement)) {
    return;
  }

  if (trackedYouTubeVideoElement === video) {
    return;
  }

  if (typeof video.captureStream !== 'function') {
    console.log('captureStream() is unavailable on the current YouTube main video element.');
    return;
  }

  console.log('[Backdrop Diagnostic] Tracked YouTube video element changed');
  trackedYouTubeVideoElement = video;

  const newStream = video.captureStream();
  logYouTubeCaptureStreamCall(video, newStream, 'bindBackdropToVideo');
  logBackdropCaptureStreamTrace(newStream, 'bindBackdropToVideo');
  if (!newStream) {
    console.log('[Backdrop Diagnostic] No MediaStream produced for the replacement YouTube video element.');
    return;
  }

  attachNewestBackdropStream(backdrop, newStream, 'bindBackdropToVideo');
  trackedYouTubeVideoSource = video.currentSrc || video.src;
  youtubeVideoSourceChangePending = false;
  console.log('[Backdrop Diagnostic] New MediaStream attached to backdrop after main YouTube video replacement.');
}

function refreshBackdropForVideoSourceChange(video) {
  if (video !== trackedYouTubeVideoElement) {
    return;
  }

  const currentSource = video.currentSrc || video.src;
  if (!currentSource || (!youtubeVideoSourceChangePending && currentSource === trackedYouTubeVideoSource)) {
    return;
  }

  const backdrop = document.getElementById(BACKDROP_ID);
  if (!backdrop || typeof video.captureStream !== 'function') {
    return;
  }

  const newStream = video.captureStream();
  logYouTubeCaptureStreamCall(video, newStream, 'refreshBackdropForVideoSourceChange');
  logBackdropCaptureStreamTrace(newStream, 'refreshBackdropForVideoSourceChange');
  if (!newStream) {
    return;
  }

  attachNewestBackdropStream(backdrop, newStream, 'refreshBackdropForVideoSourceChange');
  trackedYouTubeVideoSource = currentSource;
  youtubeVideoSourceChangePending = false;
  backdrop.play().catch((error) => {
    console.log('Backdrop media playback failed after YouTube source change:', error);
  });
}

function observeMainVideoReplacement() {
  ensureBackdropToggleButton();
  if (mainVideoReplacementObserver) {
    return;
  }

  const targetNode = document.body || document.documentElement;
  if (!targetNode) {
    return;
  }

  mainVideoReplacementObserver = new MutationObserver(() => {
    ensureBackdropToggleButton();
    const backdrop = document.getElementById(BACKDROP_ID);
    if (!backdrop) {
      return;
    }

    const player = document.querySelector('#player');
    const playerContainerOuter = player
      ? Array.from(player.children).find((child) => child.id === 'player-container-outer')
      : null;
    if (player && playerContainerOuter && (backdrop.parentElement !== player || backdrop.nextElementSibling !== playerContainerOuter)) {
      player.insertBefore(backdrop, playerContainerOuter);
    }

    const currentMainVideo = getCurrentMainYouTubeVideo();
    if (!currentMainVideo) {
      return;
    }

    if (trackedYouTubeVideoElement === currentMainVideo) {
      return;
    }

    attachYouTubeVideoDiagnosticListeners(currentMainVideo);
    logYouTubeVideoDiagnosticState('main video replacement detected', currentMainVideo);
    bindBackdropToVideo(backdrop, currentMainVideo);
    diagnoseBackdropStacking('main video element replaced');
  });

  mainVideoReplacementObserver.observe(targetNode, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'class', 'id']
  });

  console.log('[Backdrop Diagnostic] Main YouTube video replacement observer attached');
}

function getCaptureStreamActivity(video) {
  // TEMPORARILY DISABLED: diagnostic captureStream() and track.stop() test.
  return false;
}

function requestPostSwitchFrameDiagnostic(backdrop) {
  if (postSwitchDiagnosticSampler === null || typeof backdrop.requestVideoFrameCallback !== 'function') {
    return;
  }

  postSwitchFrameDiagnosticVideo = backdrop;
  postSwitchFrameDiagnosticCallbackId = backdrop.requestVideoFrameCallback((now, metadata) => {
    postSwitchFrameDiagnosticCallbackId = null;
    if (postSwitchDiagnosticSampler === null || postSwitchFrameDiagnosticVideo !== backdrop) {
      return;
    }

    postSwitchBackdropFrameDiagnosticCount += 1;
    const stream = backdrop.srcObject;
    console.log(`[Backdrop Frame Diagnostic] count=${postSwitchBackdropFrameDiagnosticCount} timestamp=${now} currentTime=${backdrop.currentTime} mediaTime=${metadata.mediaTime ?? 'N/A'} presentedFrames=${metadata.presentedFrames ?? 'N/A'} expectedDisplayTime=${metadata.expectedDisplayTime ?? 'N/A'} readyState=${backdrop.readyState} paused=${backdrop.paused} srcObjectId=${stream && stream.id ? stream.id : 'N/A'} srcObjectSame=${stream === backdropVideoMonitorStream}`);
    requestPostSwitchFrameDiagnostic(backdrop);
  });
}

function requestPostSwitchSourceFrameDiagnostic(source) {
  if (postSwitchDiagnosticSampler === null || !(source instanceof HTMLVideoElement) || typeof source.requestVideoFrameCallback !== 'function') {
    return;
  }

  postSwitchSourceFrameDiagnosticVideo = source;
  postSwitchSourceFrameDiagnosticCallbackId = source.requestVideoFrameCallback((now, metadata) => {
    postSwitchSourceFrameDiagnosticCallbackId = null;
    if (postSwitchDiagnosticSampler === null || postSwitchSourceFrameDiagnosticVideo !== source) {
      return;
    }

    postSwitchSourceFrameDiagnosticCount += 1;
    console.log(`[YouTube Frame Diagnostic] count=${postSwitchSourceFrameDiagnosticCount} timestamp=${now} currentTime=${source.currentTime} mediaTime=${metadata.mediaTime ?? 'N/A'} presentedFrames=${metadata.presentedFrames ?? 'N/A'} expectedDisplayTime=${metadata.expectedDisplayTime ?? 'N/A'}`);
    requestPostSwitchSourceFrameDiagnostic(source);
  });
}

function stopPostSwitchSourceFrameDiagnostic() {
  if (postSwitchSourceFrameDiagnosticVideo && postSwitchSourceFrameDiagnosticCallbackId !== null && typeof postSwitchSourceFrameDiagnosticVideo.cancelVideoFrameCallback === 'function') {
    postSwitchSourceFrameDiagnosticVideo.cancelVideoFrameCallback(postSwitchSourceFrameDiagnosticCallbackId);
  }

  postSwitchSourceFrameDiagnosticCallbackId = null;
  postSwitchSourceFrameDiagnosticVideo = null;
}

function logBackdropVideoMonitorState(backdrop) {
  const stream = backdrop ? backdrop.srcObject : null;
  console.log(`[Backdrop Video Monitor] paused=${backdrop ? backdrop.paused : 'N/A'} readyState=${backdrop ? backdrop.readyState : 'N/A'} networkState=${backdrop ? backdrop.networkState : 'N/A'} currentTime=${backdrop ? backdrop.currentTime : 'N/A'} videoWidth=${backdrop ? backdrop.videoWidth : 'N/A'} videoHeight=${backdrop ? backdrop.videoHeight : 'N/A'} srcObjectId=${stream && stream.id ? stream.id : 'N/A'} srcObjectSame=${stream === backdropVideoMonitorStream}`);
}

function logBackdropLayerElement(label, element) {
  if (!element) {
    console.log(`[Backdrop Layer Diagnostic] ${label} unavailable`);
    return;
  }

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const opacity = Number.parseFloat(style.opacity);
  const stackingContextSignals = {
    transform: style.transform !== 'none',
    opacityBelowOne: Number.isFinite(opacity) && opacity < 1,
    filter: style.filter !== 'none',
    willChange: style.willChange !== 'auto',
    isolation: style.isolation === 'isolate',
    contain: style.contain !== 'none',
    mixBlendMode: style.mixBlendMode !== 'normal',
    backdropFilter: style.backdropFilter !== 'none'
  };
  const diagnostic = {
    label,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    width: rect.width,
    height: rect.height,
    x: rect.x,
    y: rect.y,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    position: style.position,
    zIndex: style.zIndex,
    transform: style.transform,
    pointerEvents: style.pointerEvents,
    filter: style.filter,
    willChange: style.willChange,
    contain: style.contain,
    isolation: style.isolation,
    mixBlendMode: style.mixBlendMode,
    backdropFilter: style.backdropFilter,
    stackingContextLikely: Object.values(stackingContextSignals).some(Boolean),
    stackingContextSignals
  };
  console.log(`[Backdrop Layer Diagnostic] ${JSON.stringify(diagnostic)}`);
}

function logBackdropLayerSnapshot(source, backdrop) {
  logBackdropLayerElement('documentElement', document.documentElement);
  logBackdropLayerElement('body', document.body);
  logBackdropLayerElement('#movie_player', document.querySelector('#movie_player'));
  logBackdropLayerElement('ytd-player', document.querySelector('ytd-player'));
  logBackdropLayerElement('YouTube source video', source);
  logBackdropLayerElement('Backdrop video', backdrop);

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const topElement = document.elementFromPoint(centerX, centerY);
  const hits = document.elementsFromPoint(centerX, centerY) || [];
  const elementSummary = (element) => element ? ({
    tag: element.tagName,
    id: element.id,
    className: typeof element.className === 'string' ? element.className : element.className && element.className.baseVal ? element.className.baseVal : ''
  }) : null;
  const hitStack = hits.map((element) => ({
    tag: element.tagName,
    id: element.id,
    className: typeof element.className === 'string' ? element.className : element.className && element.className.baseVal ? element.className.baseVal : ''
  }));
  console.log(`[Backdrop Layer Diagnostic] center elementFromPoint=${JSON.stringify(elementSummary(topElement))}`);
  console.log(`[Backdrop Layer Diagnostic] center elementsFromPoint=${JSON.stringify(hitStack)}`);
}

function diagnoseBackdropStacking(label) {
  const backdrop = document.getElementById(BACKDROP_ID);
  const source = getCurrentMainYouTubeVideo();
  const pageManager = document.querySelector('#page-manager');
  const stackingWillChangeProperties = ['opacity', 'transform', 'filter', 'perspective', 'clip-path', 'mix-blend-mode', 'isolation'];

  const getClassName = (element) => typeof element.className === 'string'
    ? element.className
    : element.className && element.className.baseVal
      ? element.className.baseVal
      : '';

  const getElementDetails = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const opacity = Number.parseFloat(style.opacity);
    const willChangeProperties = style.willChange.split(',').map((property) => property.trim());
    const stackingContextSignals = {
      positionAndNonAutoZIndex: ['absolute', 'relative', 'fixed', 'sticky'].includes(style.position) && style.zIndex !== 'auto',
      fixedOrStickyPosition: style.position === 'fixed' || style.position === 'sticky',
      opacityBelowOne: Number.isFinite(opacity) && opacity < 1,
      transformNotNone: style.transform !== 'none',
      filterNotNone: style.filter !== 'none',
      isolationNotAuto: style.isolation !== 'auto',
      containNotNone: style.contain !== 'none',
      willChangeStackingProperty: willChangeProperties.some((property) => stackingWillChangeProperties.includes(property)),
      mixBlendModeNotNormal: style.mixBlendMode !== 'normal',
      backdropFilterNotNone: style.backdropFilter !== 'none'
    };
    const parent = element.parentElement;

    return {
      tag: element.tagName,
      id: element.id,
      className: getClassName(element),
      parent: parent ? { tag: parent.tagName, id: parent.id, className: getClassName(parent) } : null,
      domOrder: parent ? Array.prototype.indexOf.call(parent.children, element) : null,
      siblingCount: parent ? parent.children.length : null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      position: style.position,
      zIndex: style.zIndex,
      opacity: style.opacity,
      transform: style.transform,
      filter: style.filter,
      isolation: style.isolation,
      contain: style.contain,
      willChange: style.willChange,
      mixBlendMode: style.mixBlendMode,
      backdropFilter: style.backdropFilter,
      overflow: style.overflow,
      display: style.display,
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      stackingContextSignals,
      createsStackingContextLikely: stackingContextSignals.positionAndNonAutoZIndex || stackingContextSignals.fixedOrStickyPosition || stackingContextSignals.opacityBelowOne || stackingContextSignals.transformNotNone || stackingContextSignals.filterNotNone || stackingContextSignals.isolationNotAuto || stackingContextSignals.containNotNone || stackingContextSignals.willChangeStackingProperty || stackingContextSignals.mixBlendModeNotNormal || stackingContextSignals.backdropFilterNotNone
    };
  };

  const logElement = (element, elementLabel) => {
    if (!element) {
      console.log(`[Backdrop Stacking Diagnostic] ${label} ${elementLabel} unavailable`);
      return null;
    }

    const details = getElementDetails(element);
    console.log(`[Backdrop Stacking Diagnostic] ${JSON.stringify({ label, element: elementLabel, ...details })}`);
    return details;
  };

  const logStackingPath = (element, pathLabel) => {
    if (!element) {
      console.log(`[Backdrop Stacking Diagnostic] ${label} ${pathLabel} unavailable`);
      return;
    }

    const path = [];
    for (let current = element; current; current = current.parentElement) {
      path.push(current);
    }
    path.reverse();

    const summaries = path.map((current) => {
      const details = getElementDetails(current);
      const name = details.id ? `${details.tag}#${details.id}` : details.tag;
      return `${name} [stackingContextLikely=${details.createsStackingContextLikely}]`;
    });
    console.log(`[Backdrop Stacking Diagnostic] ${label} ${pathLabel}: ${summaries.join(' -> ')}`);

    path.forEach((current, index) => {
      logElement(current, `${pathLabel} ancestor ${index}`);
    });
  };

  console.log(`[Backdrop Stacking Diagnostic] snapshot=${label}`);
  logElement(backdrop, 'backdrop');
  logElement(pageManager, '#page-manager');
  logElement(document.querySelector('#content'), '#content');
  logElement(document.querySelector('ytd-app'), 'YTD-APP');
  logElement(document.querySelector('ytd-watch-flexy'), 'YTD-WATCH-FLEXY');
  logElement(document.querySelector('#player'), '#player');
  logElement(document.querySelector('#movie_player'), '#movie_player');
  logElement(document.querySelector('.html5-video-container'), '.html5-video-container');
  logElement(source, 'main YouTube video');

  const findInOpenShadowRoots = (selector) => {
    const matches = [];
    const roots = [document];
    const visitedRoots = new Set();

    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      if (visitedRoots.has(root)) {
        continue;
      }
      visitedRoots.add(root);

      root.querySelectorAll(selector).forEach((element) => matches.push(element));
      root.querySelectorAll('*').forEach((element) => {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
        }
      });
    }

    return matches;
  };

  const structureTargets = [
    ['#player', findInOpenShadowRoots('#player')[0] || null],
    ['#cinematics-container', findInOpenShadowRoots('#cinematics-container')[0] || null],
    ['#player-container-outer', findInOpenShadowRoots('#player-container-outer')[0] || null],
    ['#movie_player', findInOpenShadowRoots('#movie_player')[0] || null],
    [`#${BACKDROP_ID}`, backdrop]
  ];
  const availableStructureTargets = structureTargets.filter(([, element]) => !!element);
  const unavailableStructureTargets = structureTargets.filter(([, element]) => !element).map(([selector]) => selector);

  availableStructureTargets.forEach(([selector, element]) => {
    console.log(`[Backdrop Structure Diagnostic] ${JSON.stringify({
      label,
      selector,
      ...getElementDetails(element)
    })}`);

    const parent = element.parentElement;
    if (!parent) {
      console.log(`[Backdrop Structure Diagnostic] ${JSON.stringify({ label, selector, parent: null, parentChildren: [] })}`);
      return;
    }

    const parentChildren = Array.from(parent.children).map((child, domIndex) => {
      const style = window.getComputedStyle(child);
      return {
        domIndex,
        tag: child.tagName,
        id: child.id,
        className: getClassName(child),
        position: style.position,
        zIndex: style.zIndex
      };
    });
    console.log(`[Backdrop Structure Diagnostic] ${JSON.stringify({
      label,
      selector,
      parent: { tag: parent.tagName, id: parent.id, className: getClassName(parent) },
      parentChildren
    })}`);
  });

  const playerElement = structureTargets.find(([selector]) => selector === '#player')[1];
  if (playerElement) {
    const matchingPlayerDescendants = [];
    const playerMatchPattern = /(player|cinematic|video|container)/i;
    const collectPlayerDescendants = (parent, depth) => {
      Array.from(parent.children).forEach((child, domIndex) => {
        const className = getClassName(child);
        const relevant =
          playerMatchPattern.test(child.id) ||
          /(player|cinematic)/i.test(className) ||
          child.tagName === 'VIDEO' ||
          child.tagName === 'CANVAS';

        if (relevant) {
          matchingPlayerDescendants.push({
            depth,
            domIndex,
            ...getElementDetails(child)
          });
        }

        collectPlayerDescendants(child, depth + 1);
      });
    };
    collectPlayerDescendants(playerElement, 1);
    console.log(`[Backdrop Player Subtree Diagnostic] ${JSON.stringify({ label, selector: '#player', matchingDescendants: matchingPlayerDescendants })}`);

    const buildPlayerChildTree = (element, depth, domIndex) => ({
      depth,
      domIndex,
      tag: element.tagName,
      id: element.id,
      className: getClassName(element),
      children: depth < 4
        ? Array.from(element.children).map((child, childIndex) => buildPlayerChildTree(child, depth + 1, childIndex))
        : []
    });
    console.log(`[Backdrop Player Child Tree Diagnostic] ${JSON.stringify({
      label,
      selector: '#player',
      maxDepth: 4,
      tree: buildPlayerChildTree(playerElement, 0, 0)
    })}`);

    const playerChildren = Array.from(playerElement.children).map((child, domIndex) => {
      const style = window.getComputedStyle(child);
      return {
        domIndex,
        tag: child.tagName,
        id: child.id,
        className: getClassName(child),
        position: style.position,
        zIndex: style.zIndex
      };
    });
    console.log(`[Backdrop Structure Diagnostic] ${JSON.stringify({
      label,
      selector: '#player',
      directChildren: playerChildren
    })}`);
  }

  console.log(`[Backdrop Structure Diagnostic] ${JSON.stringify({ label, unavailableSelectors: unavailableStructureTargets })}`);

  const orderTargets = structureTargets.filter(([selector]) => selector !== '#player');
  const documentOrder = orderTargets.map(([selector, element]) => ({
    selector,
    relativeTo: Object.fromEntries(orderTargets.map(([otherSelector, otherElement]) => {
      if (!element || !otherElement) {
        return [otherSelector, 'element unavailable'];
      }
      if (element === otherElement) {
        return [otherSelector, 'same element'];
      }

      const relation = element.compareDocumentPosition(otherElement);
      if (relation & Node.DOCUMENT_POSITION_DISCONNECTED) {
        return [otherSelector, 'disconnected (possibly separate shadow trees)'];
      }
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) {
        return [otherSelector, 'before'];
      }
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) {
        return [otherSelector, 'after'];
      }
      return [otherSelector, 'same tree position'];
    }))
  }));
  console.log(`[Backdrop Structure Diagnostic] ${JSON.stringify({ label, documentOrder })}`);

  logStackingPath(backdrop, 'BACKDROP STACKING PATH');
  logStackingPath(document.querySelector('#movie_player') || source, 'PLAYER STACKING PATH');
  logStackingPath(source, 'SOURCE VIDEO STACKING PATH');

  if (pageManager) {
    Array.from(pageManager.children).forEach((child, index) => {
      logElement(child, `#page-manager direct child ${index}`);
    });
  } else {
    console.log(`[Backdrop Stacking Diagnostic] ${label} #page-manager direct children unavailable`);
  }

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const centerElement = document.elementFromPoint(centerX, centerY);
  const centerStack = document.elementsFromPoint(centerX, centerY).map((element) => ({
    tag: element.tagName,
    id: element.id,
    className: getClassName(element)
  }));
  console.log(`[Backdrop Stacking Diagnostic] ${JSON.stringify({
    label,
    centerPoint: { x: centerX, y: centerY },
    elementFromPoint: centerElement ? { tag: centerElement.tagName, id: centerElement.id, className: getClassName(centerElement) } : null,
    elementsFromPoint: centerStack
  })}`);

  const ambientPattern = /ambient|cinematic|yt-ambient|ytd-ambient|ytp-ambient/i;
  const ambientCandidates = new Set();
  const rootsToSearch = [document];

  for (let rootIndex = 0; rootIndex < rootsToSearch.length; rootIndex += 1) {
    const root = rootsToSearch[rootIndex];
    root.querySelectorAll('*').forEach((element) => {
      if (ambientPattern.test(`${element.tagName} ${element.id} ${getClassName(element)}`)) {
        ambientCandidates.add(element);
      }
      if (element.shadowRoot) {
        rootsToSearch.push(element.shadowRoot);
      }
    });
  }

  const getComposedParent = (element) => {
    if (element.parentElement) {
      return element.parentElement;
    }
    const root = element.getRootNode();
    return root && root.host ? root.host : null;
  };

  const isComposedDescendantOf = (element, ancestor) => {
    for (let current = element; current; current = getComposedParent(current)) {
      if (current === ancestor) {
        return true;
      }
    }
    return false;
  };

  const getRelativePosition = (element, reference) => {
    if (!reference) {
      return 'reference unavailable';
    }
    if (element === reference) {
      return 'same element';
    }
    if (isComposedDescendantOf(element, reference)) {
      return 'descendant';
    }
    if (isComposedDescendantOf(reference, element)) {
      return 'ancestor';
    }

    const elementParent = getComposedParent(element);
    const referenceParent = getComposedParent(reference);
    if (elementParent && elementParent === referenceParent) {
      const elementIndex = Array.prototype.indexOf.call(elementParent.children, element);
      const referenceIndex = Array.prototype.indexOf.call(referenceParent.children, reference);
      return `sibling; elementIndex=${elementIndex}; referenceIndex=${referenceIndex}; elementIsBeforeReference=${elementIndex < referenceIndex}`;
    }

    const relation = element.compareDocumentPosition(reference);
    if (relation & Node.DOCUMENT_POSITION_DISCONNECTED) {
      return 'separate tree or disconnected';
    }
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) {
      return 'element precedes reference in document order';
    }
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) {
      return 'element follows reference in document order';
    }
    return 'related; no direct sibling order';
  };

  const ambientReferences = [
    ['#page-manager', pageManager],
    ['YTD-WATCH-FLEXY', document.querySelector('ytd-watch-flexy')],
    ['#movie_player', document.querySelector('#movie_player')],
    ['backdrop', backdrop]
  ];

  console.log(`[Backdrop Ambient Diagnostic] ${label} candidates=${ambientCandidates.size} searchScope=document plus open shadow roots; attributes=tag/id/class`);
  if (ambientCandidates.size === 0) {
    console.log(`[Backdrop Ambient Diagnostic] ${label} no likely Ambient Mode elements found`);
  }

  ambientCandidates.forEach((element, candidateIndex) => {
    const details = getElementDetails(element);
    const composedParent = getComposedParent(element);
    const ancestry = [];
    for (let current = composedParent; current; current = getComposedParent(current)) {
      ancestry.push(current);
      if (current === document.body) {
        break;
      }
    }
    const ancestorDetails = ancestry.map((ancestor) => ({
      tag: ancestor.tagName,
      id: ancestor.id,
      className: getClassName(ancestor),
      createsStackingContextLikely: getElementDetails(ancestor).createsStackingContextLikely
    }));
    const stackingAncestors = ancestorDetails.filter((ancestor) => ancestor.createsStackingContextLikely);
    const inPageManager = !!pageManager && isComposedDescendantOf(element, pageManager);
    const watchFlexy = document.querySelector('ytd-watch-flexy');
    const inWatchFlexy = !!watchFlexy && isComposedDescendantOf(element, watchFlexy);
    const sharesBackdropParent = !!backdrop && getComposedParent(element) === getComposedParent(backdrop);
    const root = element.getRootNode();
    const inOpenShadowTree = !!(root && root.host);
    const hasCompositingSignal = [element, ...ancestry].some((node) => {
      const style = window.getComputedStyle(node);
      return style.transform !== 'none' || style.filter !== 'none' || style.willChange !== 'auto' || style.backdropFilter !== 'none';
    });
    const rect = element.getBoundingClientRect();
    const elementCenterX = rect.left + rect.width / 2;
    const elementCenterY = rect.top + rect.height / 2;
    const usableRect = rect.width > 0 && rect.height > 0 && elementCenterX >= 0 && elementCenterX < window.innerWidth && elementCenterY >= 0 && elementCenterY < window.innerHeight;
    const elementHitStack = usableRect ? document.elementsFromPoint(elementCenterX, elementCenterY).map((hit) => ({
      tag: hit.tagName,
      id: hit.id,
      className: getClassName(hit)
    })) : [];
    const parentChildren = composedParent ? Array.from(composedParent.children) : [];
    const directSiblings = parentChildren.map((sibling, siblingIndex) => {
      const siblingDetails = getElementDetails(sibling);
      return {
        tag: sibling.tagName,
        id: sibling.id,
        className: getClassName(sibling),
        domOrder: siblingIndex,
        position: siblingDetails.position,
        zIndex: siblingDetails.zIndex,
        opacity: siblingDetails.opacity,
        transform: siblingDetails.transform,
        createsStackingContextLikely: siblingDetails.createsStackingContextLikely
      };
    });

    console.log(`[Backdrop Ambient Diagnostic] ${JSON.stringify({
      label,
      candidateIndex,
      element: { tag: details.tag, id: details.id, className: details.className },
      parent: composedParent ? { tag: composedParent.tagName, id: composedParent.id, className: getClassName(composedParent) } : null,
      domOrder: composedParent ? parentChildren.indexOf(element) : null,
      relativeTo: Object.fromEntries(ambientReferences.map(([name, reference]) => [name, getRelativePosition(element, reference)])),
      ancestorChainToBody: ancestorDetails,
      computed: {
        position: details.position,
        zIndex: details.zIndex,
        opacity: details.opacity,
        transform: details.transform,
        filter: details.filter,
        isolation: details.isolation,
        contain: details.contain,
        willChange: details.willChange,
        mixBlendMode: details.mixBlendMode,
        backdropFilter: details.backdropFilter,
        pointerEvents: details.pointerEvents
      },
      stackingContextSignals: details.stackingContextSignals,
      createsStackingContextLikely: details.createsStackingContextLikely,
      insidePageManager: inPageManager,
      outsidePageManager: !inPageManager,
      insideWatchFlexy: inWatchFlexy,
      siblingOfBackdrop: sharesBackdropParent,
      stackingContextAncestors: stackingAncestors,
      inOpenShadowTree,
      separateOrCompositedStructureAssessment: hasCompositingSignal || inOpenShadowTree || !inPageManager ? 'possible; inspect reported ancestry/signals; DOM alone cannot prove a separate compositor surface' : 'no separate/composited structure identified from these DOM/CSS signals',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      elementCenterHitTest: usableRect ? { x: elementCenterX, y: elementCenterY, elementsFromPoint: elementHitStack } : 'no usable on-screen rect',
      directSiblings
    })}`);
  });

  const cinematicsRoot = document.querySelector('#cinematics');
  if (!cinematicsRoot) {
    console.log(`[YouTube Ambient Subtree Diagnostic] ${label} #cinematics not found`);
    return;
  }

  const cinematicsElements = [cinematicsRoot, ...cinematicsRoot.querySelectorAll('*')];
  const pseudoStyleDetails = (element, pseudo) => {
    const style = window.getComputedStyle(element, pseudo);
    return {
      content: style.content,
      display: style.display,
      position: style.position,
      zIndex: style.zIndex,
      background: style.background,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      opacity: style.opacity,
      filter: style.filter,
      mixBlendMode: style.mixBlendMode,
      transform: style.transform
    };
  };

  const cinematicsSubtree = cinematicsElements.map((element, domOrder) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const parent = element.parentElement;
    const pseudoElements = {
      before: pseudoStyleDetails(element, '::before'),
      after: pseudoStyleDetails(element, '::after')
    };
    const mediaDetails = {};

    if (element instanceof HTMLCanvasElement) {
      mediaDetails.canvasWidth = element.width;
      mediaDetails.canvasHeight = element.height;
    } else if (element instanceof HTMLVideoElement) {
      mediaDetails.videoWidth = element.videoWidth;
      mediaDetails.videoHeight = element.videoHeight;
      mediaDetails.currentTime = element.currentTime;
      mediaDetails.paused = element.paused;
    } else if (element instanceof HTMLImageElement) {
      mediaDetails.naturalWidth = element.naturalWidth;
      mediaDetails.naturalHeight = element.naturalHeight;
      mediaDetails.currentSrc = element.currentSrc;
    }

    return {
      domOrder,
      tag: element.tagName,
      id: element.id,
      className: getClassName(element),
      parent: parent ? { tag: parent.tagName, id: parent.id, className: getClassName(parent) } : null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      computed: {
        background: style.background,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        opacity: style.opacity,
        filter: style.filter,
        mixBlendMode: style.mixBlendMode,
        position: style.position,
        zIndex: style.zIndex,
        transform: style.transform,
        isolation: style.isolation,
        contain: style.contain,
        willChange: style.willChange,
        display: style.display,
        visibility: style.visibility
      },
      mediaDetails,
      pseudoElements
    };
  });

  console.log(`[YouTube Ambient Subtree Diagnostic] ${JSON.stringify({
    label,
    root: { tag: cinematicsRoot.tagName, id: cinematicsRoot.id, className: getClassName(cinematicsRoot) },
    descendantCount: cinematicsElements.length - 1,
    elements: cinematicsSubtree
  })}`);
}

function attachBackdropVideoDiagnosticEvents(backdrop) {
  const eventNames = ['play', 'pause', 'waiting', 'stalled', 'suspend', 'emptied', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'resize'];
  eventNames.forEach((eventName) => {
    const handler = () => {
      console.log(`[Backdrop Video Event] event=${eventName} paused=${backdrop.paused} readyState=${backdrop.readyState} networkState=${backdrop.networkState} currentTime=${backdrop.currentTime}`);
    };
    backdrop.addEventListener(eventName, handler);
    backdropVideoDiagnosticEventListeners.push([eventName, handler]);
  });
}

function detachBackdropVideoDiagnosticEvents(backdrop) {
  backdropVideoDiagnosticEventListeners.forEach(([eventName, handler]) => {
    backdrop.removeEventListener(eventName, handler);
  });
  backdropVideoDiagnosticEventListeners = [];
}

function logAvailableTrackStats(track) {
  if (postSwitchDiagnosticSampler === null || typeof track.getStats !== 'function') {
    return;
  }

  try {
    Promise.resolve(track.getStats()).then((stats) => {
      if (postSwitchDiagnosticSampler === null) {
        return;
      }

      const primitiveStats = [];
      if (stats && typeof stats.forEach === 'function') {
        stats.forEach((report) => {
          const primitiveReport = {};
          Object.entries(report).forEach(([key, value]) => {
            if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
              primitiveReport[key] = value;
            }
          });
          primitiveStats.push(primitiveReport);
        });
      }

      console.log(`[Backdrop Track Stats Diagnostic] ${JSON.stringify(primitiveStats)}`);
    }).catch(() => {});
  } catch (error) {
  }
}

function stopPostSwitchFrameDiagnostic() {
  if (postSwitchFrameDiagnosticVideo && postSwitchFrameDiagnosticCallbackId !== null && typeof postSwitchFrameDiagnosticVideo.cancelVideoFrameCallback === 'function') {
    postSwitchFrameDiagnosticVideo.cancelVideoFrameCallback(postSwitchFrameDiagnosticCallbackId);
  }

  postSwitchFrameDiagnosticCallbackId = null;
  postSwitchFrameDiagnosticVideo = null;
  stopPostSwitchSourceFrameDiagnostic();
}

function startPostSwitchDiagnosticSampler() {
  if (postSwitchDiagnosticSampler !== null) {
    return;
  }

  let sampleNumber = 0;
  postSwitchDiagnosticSampler = setInterval(() => {
    sampleNumber += 1;
    const backdrop = document.getElementById(BACKDROP_ID);
    const source = getCurrentMainYouTubeVideo();
    const stream = backdrop ? backdrop.srcObject : null;
    const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    const trackSnapshots = tracks.map((track) => {
      const settings = {};
      if (typeof track.getSettings === 'function') {
        try {
          Object.entries(track.getSettings()).forEach(([key, value]) => {
            if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
              settings[key] = value;
            }
          });
        } catch (error) {
          settings.error = 'unavailable';
        }
      }

      return {
        kind: track.kind,
        id: track.id,
        readyState: track.readyState,
        muted: track.muted,
        enabled: track.enabled,
        settings
      };
    });
    tracks.forEach(logAvailableTrackStats);
    let presentedFrames = 'N/A';
    let sourcePresentedFrames = 'N/A';

    if (backdrop && typeof backdrop.getVideoPlaybackQuality === 'function') {
      try {
        const playbackQuality = backdrop.getVideoPlaybackQuality();
        presentedFrames = playbackQuality.totalVideoFrames ?? 'N/A';
      } catch (error) {
        presentedFrames = 'N/A';
      }
    }

    if (source && typeof source.getVideoPlaybackQuality === 'function') {
      try {
        const playbackQuality = source.getVideoPlaybackQuality();
        sourcePresentedFrames = playbackQuality.totalVideoFrames ?? 'N/A';
      } catch (error) {
        sourcePresentedFrames = 'N/A';
      }
    }

    if (source !== postSwitchSourceFrameDiagnosticVideo) {
      stopPostSwitchSourceFrameDiagnostic();
      requestPostSwitchSourceFrameDiagnostic(source);
    }

    console.log(`[Backdrop Diagnostic] POST-SWITCH SAMPLE n=${sampleNumber} backdropCurrentTime=${backdrop ? backdrop.currentTime : 'N/A'} backdropPaused=${backdrop ? backdrop.paused : 'N/A'} backdropReadyState=${backdrop ? backdrop.readyState : 'N/A'} backdropEnded=${backdrop ? backdrop.ended : 'N/A'} backdropVideoWidth=${backdrop ? backdrop.videoWidth : 'N/A'} backdropVideoHeight=${backdrop ? backdrop.videoHeight : 'N/A'} backdropPresentedFrames=${presentedFrames} backdropFrameCallbackCount=${postSwitchBackdropFrameDiagnosticCount} sourceCurrentTime=${source ? source.currentTime : 'N/A'} sourcePaused=${source ? source.paused : 'N/A'} sourceReadyState=${source ? source.readyState : 'N/A'} sourcePresentedFrames=${sourcePresentedFrames} sourceFrameCallbackCount=${postSwitchSourceFrameDiagnosticCount} backdropStreamActive=${stream ? stream.active : 'N/A'} backdropTrackCount=${tracks.length}`);
    console.log(`[Backdrop Track Diagnostic] ${JSON.stringify(trackSnapshots)}`);

    if (sampleNumber % 4 === 0) {
      logBackdropVideoMonitorState(backdrop);
      logBackdropLayerSnapshot(source, backdrop);
    }

    if (sampleNumber >= 20) {
      clearInterval(postSwitchDiagnosticSampler);
      postSwitchDiagnosticSampler = null;
      stopPostSwitchFrameDiagnostic();
      detachBackdropVideoDiagnosticEvents(backdrop);
      backdropVideoMonitorStream = null;
    }
  }, 250);

  const backdrop = document.getElementById(BACKDROP_ID);
  if (backdrop) {
    backdropVideoMonitorStream = backdrop.srcObject;
    attachBackdropVideoDiagnosticEvents(backdrop);
  }
  if (backdrop && typeof backdrop.requestVideoFrameCallback === 'function') {
    postSwitchBackdropFrameDiagnosticCount = 0;
    requestPostSwitchFrameDiagnostic(backdrop);
  }

  postSwitchSourceFrameDiagnosticCount = 0;
  requestPostSwitchSourceFrameDiagnostic(getCurrentMainYouTubeVideo());
}

function logYouTubeVideoDiagnosticState(label, video, scheduleFollowup = true) {
  const backdrop = document.getElementById(BACKDROP_ID);
  const backdropStream = backdrop ? backdrop.srcObject : null;
  const currentVideo = video || getCurrentMainYouTubeVideo();
  const backdropStyle = backdrop ? window.getComputedStyle(backdrop) : null;
  const backdropRect = backdrop ? backdrop.getBoundingClientRect() : null;
  const backdropTracks = backdropStream && typeof backdropStream.getTracks === 'function' ? backdropStream.getTracks() : [];

  const sameDomElementAsBefore = currentVideo === lastObservedYouTubeVideoElementForDiagnostics;
  const currentUrl = window.location.href;
  const urlChanged = currentUrl !== lastFrameDiagnosticUrl;
  lastFrameDiagnosticUrl = currentUrl;
  const captureStreamActive = currentVideo ? getCaptureStreamActivity(currentVideo) : false;
  const backdropStreamSameObject = backdropStream === lastObservedBackdropMediaStream;
  const backdropPaused = backdrop ? backdrop.paused : null;
  const backdropEnded = backdrop ? backdrop.ended : null;
  const backdropCurrentTime = backdrop ? backdrop.currentTime : null;
  const backdropCurrentTimeAdvancing = backdrop ? !backdrop.paused && !backdrop.ended && backdropCurrentTime !== null && backdropCurrentTime > lastObservedBackdropCurrentTime : null;
  const backdropCurrentTimeIncreasedSincePreviousSample = backdropCurrentTime !== null && backdropCurrentTime > lastObservedBackdropCurrentTime;

  console.log('[Backdrop Diagnostic] YouTube SPA navigation', {
    label,
    currentUrl,
    sameDomElementAsBefore,
    currentSrc: currentVideo ? currentVideo.currentSrc : null,
    src: currentVideo ? currentVideo.src : null,
    readyState: currentVideo ? currentVideo.readyState : null,
    currentTime: currentVideo ? currentVideo.currentTime : null,
    sourcePaused: currentVideo ? currentVideo.paused : null,
    sourceEnded: currentVideo ? currentVideo.ended : null,
    captureStreamActive,
    backdropStreamSameObject,
    backdropPaused,
    backdropEnded,
    backdropCurrentTime,
    backdropCurrentTimeAdvancing,
    backdropCurrentTimeIncreasedSincePreviousSample,
    backdropReadyState: backdrop ? backdrop.readyState : null,
    backdropVideoWidth: backdrop ? backdrop.videoWidth : null,
    backdropVideoHeight: backdrop ? backdrop.videoHeight : null,
    backdropMediaStreamActive: backdropStream ? backdropStream.active : null,
    backdropHasActiveTracks: backdropTracks.some((track) => track.readyState === 'live'),
    backdropTracks: backdropTracks.map((track) => ({
      readyState: track.readyState,
      enabled: track.enabled
    })),
    backdropComputedStyle: backdropStyle ? {
      opacity: backdropStyle.opacity,
      visibility: backdropStyle.visibility,
      display: backdropStyle.display,
      zIndex: backdropStyle.zIndex
    } : null,
    backdropBoundingClientRect: backdropRect ? {
      x: backdropRect.x,
      y: backdropRect.y,
      width: backdropRect.width,
      height: backdropRect.height,
      top: backdropRect.top,
      left: backdropRect.left,
      right: backdropRect.right,
      bottom: backdropRect.bottom
    } : null,
    backdropExists: !!backdrop
  });

  const navigationEvent = label === 'main video replacement detected' || /^video event: (loadedmetadata|durationchange|emptied|loadstart)$/.test(label);
  const activeBefore = !!backdropFrameSwitchReport;
  const shouldStart = (navigationEvent || urlChanged) && !activeBefore;
  console.log(`[Backdrop Diagnostic] COLLECTOR DECISION label="${label}" urlChanged=${urlChanged} activeBefore=${activeBefore} shouldStart=${shouldStart}`);

  if ((navigationEvent || urlChanged) && !backdropFrameSwitchReport) {
    backdropFrameSwitchReport = {
      navigationTimestamp: new Date().toISOString(),
      navigationLabel: label,
      framesBefore: backdropFrameSamplesBeforeNavigation.slice(-20),
      framesAfter: []
    };
    console.log(`[Backdrop Diagnostic] COLLECTOR ARMED label="${label}" beforeFrames=${backdropFrameSwitchReport.framesBefore.length}`);
    startPostSwitchDiagnosticSampler();
  }

  lastObservedYouTubeVideoElementForDiagnostics = currentVideo || lastObservedYouTubeVideoElementForDiagnostics;
  lastObservedBackdropMediaStream = backdropStream;
  if (backdropCurrentTime !== null) {
    lastObservedBackdropCurrentTime = backdropCurrentTime;
  }

  if (scheduleFollowup) {
    clearTimeout(backdropDiagnosticFollowupTimer);
    backdropDiagnosticFollowupTimer = setTimeout(() => {
      backdropDiagnosticFollowupTimer = null;
      logYouTubeVideoDiagnosticState(`follow-up sample after ${label}`, getCurrentMainYouTubeVideo(), false);
    }, 750);
  }
}

function attachYouTubeVideoDiagnosticListeners(video) {
  if (!(video instanceof HTMLVideoElement) || video.__youtubeBackdropDiagnosticListenersBound) {
    return;
  }

  video.__youtubeBackdropDiagnosticListenersBound = true;

  YOUTUBE_VIDEO_DIAGNOSTIC_EVENTS.forEach((eventName) => {
    video.addEventListener(eventName, () => {
      logYouTubeVideoDiagnosticState(`video event: ${eventName}`, video);
      if (video === trackedYouTubeVideoElement && (eventName === 'emptied' || eventName === 'loadstart')) {
        youtubeVideoSourceChangePending = true;
      }
      if (eventName === 'loadedmetadata') {
        refreshBackdropForVideoSourceChange(video);
        diagnoseBackdropStacking('YouTube source loadedmetadata');
      }
      if (['emptied', 'loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'ended'].includes(eventName)) {
        const backdropVideo = document.getElementById(BACKDROP_ID);
        const stream = backdropVideo ? backdropVideo.srcObject : null;
        let tracks = [];
        if (stream && typeof stream.getTracks === 'function') {
          try {
            tracks = stream.getTracks().map((track) => ({
              kind: track.kind,
              id: track.id,
              readyState: track.readyState,
              enabled: track.enabled,
              muted: track.muted
            }));
          } catch (error) {
            tracks = [];
          }
        }

        console.log(`[YouTube Video Event Trace] ${JSON.stringify({
          event: eventName,
          videoIdentity: getYouTubeVideoDiagnosticId(video),
          currentSrc: video.currentSrc || 'N/A',
          src: video.src || 'N/A',
          currentTime: video.currentTime,
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          matchesTrackedVideo: trackedYouTubeVideoElement === video,
          backdropStreamExists: !!stream,
          backdropStreamId: stream && stream.id ? stream.id : 'N/A',
          backdropTrackCount: tracks.length,
          tracks
        })}`);
      }
      if (postSwitchDiagnosticSampler !== null) {
        console.log(`[YouTube Video Diagnostic] event=${eventName} sameAsTracked=${video === trackedYouTubeVideoElement} currentSrc=${video.currentSrc || 'N/A'} src=${video.src || 'N/A'} readyState=${video.readyState} currentTime=${video.currentTime}`);
      }
    });
  });

  console.log('[Backdrop Diagnostic] YouTube main video diagnostic listeners attached for event tracking');
}

function observeBackdropVideoFrames(backdrop) {
  if (!(backdrop instanceof HTMLVideoElement) || backdrop.__youtubeBackdropFrameDiagnosticStarted) {
    return;
  }

  if (typeof backdrop.requestVideoFrameCallback !== 'function') {
    console.log('[Backdrop Diagnostic] requestVideoFrameCallback supported:', false);
    return;
  }

  backdrop.__youtubeBackdropFrameDiagnosticStarted = true;
  console.log('[Backdrop Diagnostic] requestVideoFrameCallback supported:', true);

  const logNextFrame = (now, metadata) => {
    backdropFrameCallbackCount += 1;
    const frameSample = `[Backdrop Diagnostic] FRAME count=${backdropFrameCallbackCount} time=${now} currentTime=${backdrop.currentTime} mediaTime=${metadata.mediaTime ?? 'N/A'} presentedFrames=${metadata.presentedFrames ?? 'N/A'} expectedDisplayTime=${metadata.expectedDisplayTime ?? 'N/A'}`;
    console.log(frameSample);

    backdropFrameSamplesBeforeNavigation.push(frameSample);
    if (backdropFrameSamplesBeforeNavigation.length > 20) {
      backdropFrameSamplesBeforeNavigation.shift();
    }

    if (backdropFrameSwitchReport) {
      backdropFrameSwitchReport.framesAfter.push(frameSample);

      if (backdropFrameSwitchReport.framesAfter.length >= 50) {
        const report = [
          '[Backdrop Diagnostic] ===== FRAME SWITCH REPORT =====',
          `Navigation timestamp: ${backdropFrameSwitchReport.navigationTimestamp}`,
          `Navigation diagnostic: ${backdropFrameSwitchReport.navigationLabel}`,
          'Frames before navigation:',
          ...backdropFrameSwitchReport.framesBefore,
          'Frames after navigation:',
          ...backdropFrameSwitchReport.framesAfter,
          '[Backdrop Diagnostic] ===== END FRAME SWITCH REPORT ====='
        ].join('\n');

        console.log(report);
        backdropFrameSwitchReport = null;
      }
    }

    backdrop.requestVideoFrameCallback(logNextFrame);
  };

  backdrop.requestVideoFrameCallback(logNextFrame);
}

function removeBackdrop() {
  disconnectMainVideoReplacementObserver();
  restoreHtmlBackground();

  const backdrop = document.getElementById(BACKDROP_ID);
  if (!backdrop) {
    return;
  }

  const stream = backdrop.srcObject;
  if (stream && typeof stream.getTracks === 'function') {
    stream.getTracks().forEach((track) => track.stop());
  }

  backdrop.remove();
  console.log('Backdrop video removed.');
}

function createBackdrop() {
  const existingBackdrop = document.getElementById(BACKDROP_ID);
  const player = document.querySelector('#player');
  const playerContainerOuter = player
    ? Array.from(player.children).find((child) => child.id === 'player-container-outer')
    : null;

  if (existingBackdrop) {
    if (player && playerContainerOuter && (existingBackdrop.parentElement !== player || existingBackdrop.nextElementSibling !== playerContainerOuter)) {
      player.insertBefore(existingBackdrop, playerContainerOuter);
    }
    return existingBackdrop;
  }

  const backdrop = document.createElement('video');
  backdrop.id = BACKDROP_ID;
  backdrop.autoplay = true;
  backdrop.muted = true;
  backdrop.playsInline = true;

  backdrop.style.position = 'fixed';
  backdrop.style.top = '0';
  backdrop.style.left = '0';
  backdrop.style.width = '100vw';
  backdrop.style.height = '100vh';
  backdrop.style.objectFit = 'cover';
  backdrop.style.pointerEvents = 'none';
  backdrop.style.zIndex = '0';
  backdrop.style.opacity = '0.5';
  backdrop.style.display = 'block';

  if (player && playerContainerOuter) {
    player.insertBefore(backdrop, playerContainerOuter);
    console.log('[Backdrop Diagnostic] backdrop.parentElement === #player, before #player-container-outer:', backdrop.parentElement === player);
  } else {
    const pageManager = document.querySelector('#page-manager');
    if (pageManager) {
      pageManager.insertBefore(backdrop, pageManager.firstChild);
      console.log('[Backdrop Diagnostic] backdrop.parentElement === #page-manager:', backdrop.parentElement === pageManager);
    } else {
      document.body.appendChild(backdrop);
      console.log('[Backdrop Diagnostic] backdrop.parentElement === BODY:', backdrop.parentElement === document.body);
    }
  }

  console.log('Backdrop video created behind the page UI.');
  return backdrop;
}

function logMutationDelta(target, mutationType, oldValue, newValue) {
  if (oldValue === newValue) {
    return;
  }

  console.log('[Backdrop Diagnostic] Mutation', {
    target: target && target.id ? target.id : target && target.tagName ? target.tagName : String(target),
    type: mutationType,
    oldValue,
    newValue
  });
}

function observeBackdropMutation() {
  const backdrop = document.getElementById(BACKDROP_ID);
  const player = document.querySelector('#player');

  if (!backdrop && !player) {
    return;
  }

  const mutationTargets = [];
  if (backdrop) {
    mutationTargets.push(backdrop);
  }
  if (player) {
    mutationTargets.push(player);
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      const target = mutation.target;
      if (target === backdrop || target === player) {
        console.log('[Backdrop Diagnostic] Mutation observed on', target.tagName, target.id || '', target.className || '');

        if (mutation.type === 'attributes') {
          const attrName = mutation.attributeName;
          const oldValue = mutation.oldValue;
          const newValue = target.getAttribute(attrName);
          logMutationDelta(target, `attribute:${attrName}`, oldValue, newValue);
        }

        if (mutation.type === 'childList') {
          console.log('[Backdrop Diagnostic] ChildList mutation', {
            addedNodes: mutation.addedNodes.length,
            removedNodes: mutation.removedNodes.length,
            target: target.tagName + (target.id ? '#' + target.id : '')
          });
        }

        if (mutation.type === 'attributes' && target instanceof Element) {
          const style = window.getComputedStyle(target);
          console.log('[Backdrop Diagnostic] Current styles after mutation', {
            tag: target.tagName,
            id: target.id,
            className: target.className,
            position: style.position,
            zIndex: style.zIndex,
            opacity: style.opacity,
            transform: style.transform,
            filter: style.filter,
            backgroundColor: style.backgroundColor
          });
        }
      }
    });
  });

  mutationTargets.forEach((target) => {
    observer.observe(target, {
      attributes: true,
      attributeOldValue: true,
      childList: true,
      subtree: false,
      characterData: false,
      class: true,
      style: true
    });
  });

  console.log('[Backdrop Diagnostic] MutationObserver attached to backdrop and #player');
}

function syncBackdrop(enabled) {
  if (!isWatchPage()) {
    trackedYouTubeVideoElement = null;
    removeBackdrop();
    return;
  }

  const video = document.querySelector(MAIN_VIDEO_SELECTOR) || document.querySelector('video');
  if (!video) {
    console.log('YouTube video not found on this page.');
    trackedYouTubeVideoElement = null;
    removeBackdrop();
    return;
  }

  console.log('YouTube video found:', video);
  logAncestorChain(video);
  logPageLayers();

  if (typeof video.captureStream !== 'function') {
    console.log('captureStream() is unavailable on the YouTube video element. Original YouTube player was not modified.');
    trackedYouTubeVideoElement = null;
    removeBackdrop();
    return;
  }

  console.log('captureStream() is supported on the YouTube video element.');

  if (!enabled) {
    console.log('Extension is OFF. Removing backdrop video without changing the original YouTube video.');
    trackedYouTubeVideoElement = null;
    removeBackdrop();
    return;
  }

  makeHtmlBackgroundTransparent();

  const stream = video.captureStream();
  logYouTubeCaptureStreamCall(video, stream, 'syncBackdrop');
  logBackdropCaptureStreamTrace(stream, 'syncBackdrop');
  console.log('captureStream() produced a MediaStream:', !!stream, stream);

  if (!stream) {
    console.log('No MediaStream was produced; backdrop will not be created.');
    trackedYouTubeVideoElement = null;
    removeBackdrop();
    return;
  }

  const backdrop = createBackdrop();
  attachNewestBackdropStream(backdrop, stream, 'syncBackdrop');
  observeBackdropVideoFrames(backdrop);
  trackedYouTubeVideoElement = video;
  trackedYouTubeVideoSource = video.currentSrc || video.src;
  youtubeVideoSourceChangePending = false;
  attachYouTubeVideoDiagnosticListeners(video);
  logYouTubeVideoDiagnosticState('initial YouTube video established', video);
  observeMainVideoReplacement();

  logBackdropState();
  logAncestorChain(backdrop);
  logPageLayers();
  logBackdropAncestorDiagnostics();
  logYouTubePlayerAncestorDiagnostics();
  logImportantLayerElements();
  logViewportHitTest();
  observeBackdropMutation();

  backdrop.play()
    .then(() => {
      console.log('Backdrop media playback started successfully.');

      const style = getComputedStyle(backdrop);
      const rect = backdrop.getBoundingClientRect();
      console.log('[Backdrop Diagnostic] FINAL computed backdrop state', {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        position: style.position,
        zIndex: style.zIndex,
        width: style.width,
        height: style.height,
        top: style.top,
        left: style.left,
        transform: style.transform,
        filter: style.filter,
        objectFit: style.objectFit,
        pointerEvents: style.pointerEvents,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        video: {
          readyState: backdrop.readyState,
          paused: backdrop.paused,
          ended: backdrop.ended,
          videoWidth: backdrop.videoWidth,
          videoHeight: backdrop.videoHeight,
          currentTime: backdrop.currentTime
        }
      });

      console.log('[Backdrop Diagnostic] BODY background', getComputedStyle(document.body).backgroundColor);
      console.log('[Backdrop Diagnostic] HTML background', getComputedStyle(document.documentElement).backgroundColor);
      logBackdropAncestorDiagnostics();
      logYouTubePlayerAncestorDiagnostics();
      logImportantLayerElements();
      logViewportHitTest();
      diagnoseBackdropStacking('syncBackdrop enabled');
    })
    .catch((error) => {
      console.log('Backdrop media playback failed:', error);
    });
}

async function initialize() {
  if (!isWatchPage()) {
    return;
  }

  const enabled = await readStorageValue();
  syncBackdrop(enabled);
  observeMainVideoReplacement();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
        return;
      }

      const nextEnabled = Boolean(changes[STORAGE_KEY].newValue);
      syncBackdrop(nextEnabled);
      if (isWatchPage()) {
        observeMainVideoReplacement();
      }
      updateBackdropToggleButtonState(nextEnabled);
    });
  }
}

initialize();
