export const buildAnnotationVoiceScript = (receiver: string): string => String.raw`  // ------------------------------------------------------------------- voice

  var voicePhase = 'idle';
  var voiceNote = '';
  var voiceStartedAt = 0;
  var voiceTimer = null;
  var voiceBusyTimer = null;
  var voiceBusyStep = 0;
  // Enter while the recording runs finishes it, and the annotation goes once
  // the words are in the comment.
  var submitAfterVoice = false;

  var iconButton = function (path, label, className) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>';
    return button;
  };

  var voiceBox = null, micButton = null, voiceStatus = null, voiceText = null, voiceCancel = null, voiceFinish = null, voiceBusy = null;
  var wave = null;
  if (sendToApp) {
    voiceBox = document.createElement('div');
    voiceBox.className = 'voice';
    micButton = iconButton(VOICE.icons.mic, VOICE.labels.start, 'ghost');
    voiceStatus = document.createElement('div');
    voiceStatus.className = 'rec';
    voiceStatus.setAttribute('role', 'status');
    voiceStatus.setAttribute('aria-label', VOICE.labels.listening);
    var dot = document.createElement('span');
    dot.className = 'dot';
    wave = document.createElement('canvas');
    wave.className = 'wave';
    wave.setAttribute('aria-hidden', 'true');
    voiceText = document.createElement('span');
    voiceStatus.append(dot, wave, voiceText);
    voiceBusy = document.createElement('span');
    voiceBusy.className = 'spin';
    voiceBusy.setAttribute('role', 'status');
    voiceBusy.setAttribute('aria-label', VOICE.labels.processing);
    voiceBusy.title = VOICE.labels.processing;
    voiceBusy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + VOICE.icons.loader + '</svg>';
    voiceCancel = iconButton(VOICE.icons.close, VOICE.labels.cancel, 'ghost');
    voiceFinish = iconButton(VOICE.icons.check, VOICE.labels.insert, 'ghost confirm');
    voiceBox.append(micButton, voiceStatus, voiceBusy, voiceCancel, voiceFinish);
    editor.insertBefore(voiceBox, submit);
  }

  /**
   * Asks the app for its microphone. Only for the user's own input: the page
   * shares this document and can dispatch events at it, but cannot make them
   * trusted.
   */
  var askApp = function (event, action) {
    if (!sendToApp || settled || !event || !event.isTrusted) return;
    try { sendToApp(JSON.stringify({ type: 'voice', action: action })); } catch (error) { /* shell went away */ }
  };

  // The microphone level as the composer draws it: newest bar on the right,
  // silence a dot, speech a rounded bar, quiet speech raised to use the height.
  var waveBars = [];
  var WAVE_BAR = 2, WAVE_PITCH = 5, WAVE_CURVE = 0.65;
  var drawWave = function (level) {
    if (!wave) return;
    var width = 48, height = 16, ratio = window.devicePixelRatio || 1;
    if (wave.width !== width * ratio) {
      wave.width = width * ratio;
      wave.height = height * ratio;
    }
    waveBars.push(Math.max(0, Math.min(1, level)));
    var capacity = Math.floor(width / WAVE_PITCH);
    while (waveBars.length > capacity) waveBars.shift();
    var context = wave.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = THEME.mutedText;
    context.fillStyle = THEME.mutedText;
    context.lineWidth = WAVE_BAR;
    context.lineCap = 'round';
    var right = width - WAVE_BAR / 2;
    for (var i = 0; i < waveBars.length; i += 1) {
      var x = right - (waveBars.length - 1 - i) * WAVE_PITCH;
      var half = (WAVE_BAR + (height - WAVE_BAR) * Math.pow(waveBars[i], WAVE_CURVE) - WAVE_BAR) / 2;
      context.beginPath();
      if (half < 0.25) {
        context.arc(x, height / 2, WAVE_BAR / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.moveTo(x, height / 2 - half);
        context.lineTo(x, height / 2 + half);
        context.stroke();
      }
    }
  };

  var renderVoiceTime = function () {
    if (!voiceText) return;
    var elapsed = Math.max(0, Math.floor((Date.now() - voiceStartedAt) / 1000));
    dot.classList.toggle('dim', voicePhase === 'recording' && elapsed % 2 === 1);
    if (voiceNote) {
      voiceText.textContent = voiceNote;
      return;
    }
    voiceText.textContent = Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
  };

  var renderVoice = function () {
    if (!voiceBox) return;
    // A status such as a model download takes the wave's place.
    wave.hidden = Boolean(voiceNote);
    micButton.hidden = voicePhase !== 'idle';
    voiceStatus.hidden = voicePhase !== 'recording';
    voiceBusy.hidden = voicePhase !== 'processing';
    voiceCancel.hidden = voicePhase === 'idle';
    voiceFinish.hidden = voicePhase !== 'recording';
    renderVoiceTime();
  };

  /** Puts the transcript where the caret is, with a space before it when the text runs on. */
  var insertTranscript = function (text) {
    var start = comment.selectionStart == null ? comment.value.length : comment.selectionStart;
    var end = comment.selectionEnd == null ? start : comment.selectionEnd;
    var before = comment.value.slice(0, start);
    var spacer = before && !/\s$/.test(before) ? ' ' : '';
    comment.value = before + spacer + text + comment.value.slice(end);
    var caret = before.length + spacer.length + text.length;
    resizeComment();
    try { comment.setSelectionRange(caret, caret); } catch (error) { /* field went away */ }
  };

  var takeTranscript = function (message) { insertTranscript(message.text); if (!message.ends) return true; var queued = submitAfterVoice; applyVoice({ phase: 'idle' }); return queued ? 'submitting' : true; };
  var stepVoiceBusy = function () {
    voiceBusyStep = (voiceBusyStep + 1) % 8;
    var icon = voiceBusy && voiceBusy.firstChild;
    if (icon) icon.style.transform = 'rotate(' + voiceBusyStep * 45 + 'deg)';
  };

  var applyVoice = function (message) {
    var was = voicePhase;
    voicePhase = message.phase === 'recording' || message.phase === 'processing' ? message.phase : 'idle';
    voiceNote = typeof message.note === 'string' ? message.note : '';
    if (voicePhase === 'recording' && was !== 'recording') {
      voiceStartedAt = Date.now();
      waveBars = [];
      drawWave(0);
      voiceTimer = setInterval(renderVoiceTime, 1000);
    }
    if (voicePhase !== 'recording' && voiceTimer) {
      clearInterval(voiceTimer);
      voiceTimer = null;
    }
    if (voicePhase === 'processing' && !voiceBusyTimer) {
      voiceBusyStep = -1;
      stepVoiceBusy();
      voiceBusyTimer = setInterval(stepVoiceBusy, 250);
    }
    if (voicePhase !== 'processing' && voiceBusyTimer) {
      clearInterval(voiceBusyTimer);
      voiceBusyTimer = null;
    }
    renderVoice();
    if (voicePhase !== 'idle') return;
    var submitNow = submitAfterVoice && !message.failed;
    submitAfterVoice = false;
    if (submitNow) attach();
    else if (was !== 'idle') comment.focus({ preventScroll: true });
  };

  if (voiceBox) {
    micButton.addEventListener('click', function (event) { askApp(event, 'start'); });
    voiceFinish.addEventListener('click', function (event) { askApp(event, 'finish'); });
    voiceCancel.addEventListener('click', function (event) {
      submitAfterVoice = false;
      askApp(event, 'cancel');
    });
    window['${receiver}'] = function (message) {
      if (settled || !message) return false;
      if (message.type === 'insert' && typeof message.text === 'string') return takeTranscript(message);
      else if (message.type === 'voice') applyVoice(message);
      else if (message.type === 'level' && typeof message.level === 'number' && voicePhase === 'recording') drawWave(message.level);
    };
    renderVoice();
  }

  /** The app's dictation shortcut, matched by physical key so Option and other layouts still hit it. */
  var isVoiceShortcut = function (event) {
    var shortcut = VOICE && VOICE.shortcut;
    if (!sendToApp || !shortcut) return false;
    if (event.metaKey !== shortcut.meta || event.ctrlKey !== shortcut.ctrl) return false;
    if (event.altKey !== shortcut.alt || event.shiftKey !== shortcut.shift) return false;
    var code = String(event.code || '');
    var key = code.indexOf('Key') === 0 || code.indexOf('Digit') === 0
      ? code.slice(code.indexOf('Key') === 0 ? 3 : 5).toLowerCase()
      : String(event.key || '').toLowerCase();
    return key === shortcut.key;
  };
`;
