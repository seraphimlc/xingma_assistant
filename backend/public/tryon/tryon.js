(function () {
  var MODEL_ID = 'lucy-vton-latest';
  var PROMPT =
    'Substitute the current top with the knit garment in the reference image. Match its color, knit texture, neckline, sleeves and silhouette. Keep the person face, body, pose and background unchanged.';
  var CAMERA_TIP = '无法打开摄像头。请点右上角菜单，选择「在浏览器中打开」后再试衣。';

  var params = new URLSearchParams(location.search);
  var productId = params.get('productId') || '';
  var ticket = params.get('ticket') || '';
  var nameEl = document.getElementById('name');
  var statusEl = document.getElementById('status');
  var hintEl = document.getElementById('hint');
  var bannerEl = document.getElementById('banner');
  var chipsEl = document.getElementById('chips');
  var goBtn = document.getElementById('go');
  var previewEl = document.getElementById('preview');
  var outputEl = document.getElementById('output');

  var colors = [];
  var selected = 0;
  var running = false;
  var starting = false;
  var session = null;

  /**
   * canvas.captureStream 只接受 1..60 的有限数字。
   * lucy-vton-latest 的 model.fps 是 {ideal:30,max:30}，不能原样传进去。
   */
  function finiteFps(value, fallback) {
    var n = value;
    if (n && typeof n === 'object') {
      if (n.ideal != null) n = n.ideal;
      else if (n.max != null) n = n.max;
      else if (n.exact != null) n = n.exact;
      else n = n.min;
    }
    n = Number(n);
    if (!isFinite(n)) n = fallback == null ? 24 : Number(fallback);
    if (!isFinite(n)) n = 24;
    n = Math.round(n);
    if (n < 1) n = 1;
    if (n > 60) n = 60;
    return n;
  }

  function positiveInt(value, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n) || n < 1) n = Math.round(Number(fallback));
    if (!isFinite(n) || n < 1) n = 720;
    return n;
  }

  function stageSize(model) {
    var width = positiveInt(model && model.width, 1280);
    var height = positiveInt(model && model.height, 720);
    var portrait = window.innerHeight >= window.innerWidth;
    if (portrait && width > height) {
      var swap = width;
      width = height;
      height = swap;
    }
    if (!portrait && height > width) {
      var swapLand = height;
      height = width;
      width = swapLand;
    }
    return { width: positiveInt(width, 720), height: positiveInt(height, 1280) };
  }

  function showBanner(text) {
    bannerEl.hidden = !text;
    bannerEl.textContent = text || '';
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function authHeaders() {
    return { Authorization: 'Bearer ' + ticket, 'Content-Type': 'application/json' };
  }

  function messageOf(data, fallback) {
    var msg = data && (data.message || data.error);
    if (Array.isArray(msg)) msg = msg.join('；');
    msg = msg ? String(msg) : fallback;
    if (/DECART|API_KEY|dct_/i.test(msg)) return fallback;
    return msg;
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    colors.forEach(function (color, index) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (index === selected ? ' on' : '');
      btn.setAttribute('role', 'option');
      var img = document.createElement('img');
      img.alt = color.name;
      var join = color.imageUrl.indexOf('?') >= 0 ? '&' : '?';
      img.src = color.imageUrl + join + 'ticket=' + encodeURIComponent(ticket);
      var label = document.createElement('span');
      label.textContent = color.name;
      btn.appendChild(img);
      btn.appendChild(label);
      btn.addEventListener('click', function () {
        chooseColor(index);
      });
      chipsEl.appendChild(btn);
    });
  }

  function chooseColor(index) {
    if (index < 0 || index >= colors.length || index === selected && running) {
      selected = index;
      renderChips();
      return;
    }
    selected = index;
    renderChips();
    if (session && session.rt) applyGarment(colors[index]);
  }

  async function loadCatalog() {
    if (!productId || !ticket) {
      setStatus('试衣链接不完整');
      showBanner('请返回商品页，重新点「试衣」。');
      return;
    }
    var url = '/api/products/' + encodeURIComponent(productId) + '/tryon?ticket=' + encodeURIComponent(ticket);
    var res;
    try {
      res = await fetch(url, { headers: authHeaders() });
    } catch (e) {
      setStatus('网络不好');
      showBanner('暂时连不上试衣服务，请稍后再试。');
      return;
    }
    var data = {};
    try { data = await res.json(); } catch (e2) { data = {}; }
    if (!res.ok) {
      setStatus('无法试衣');
      showBanner(messageOf(data, '试衣链接已失效，请返回商品页重新打开'));
      return;
    }
    nameEl.textContent = data.name || '试衣';
    colors = Array.isArray(data.colors) ? data.colors : [];
    if (!data.available || !colors.length) {
      setStatus('这款暂时不能试衣');
      showBanner('这款暂时没有可用于试衣的图片。');
      return;
    }
    selected = 0;
    renderChips();
    goBtn.disabled = false;
    setStatus('选择颜色，点「开始试衣」');
  }

  async function loadGarment(color) {
    if (color.blob) return color.blob;
    var res = await fetch(color.imageUrl, { headers: { Authorization: 'Bearer ' + ticket } });
    if (!res.ok) {
      var data = {};
      try { data = await res.json(); } catch (e) { data = {}; }
      throw new Error(messageOf(data, '无法加载衣服图片'));
    }
    var blob = await res.blob();
    if (!blob.type || blob.type.indexOf('image/') !== 0) {
      blob = new Blob([blob], { type: 'image/jpeg' });
    }
    color.blob = blob;
    return blob;
  }

  function drawCover(ctx, video, width, height) {
    var vw = video.videoWidth || width;
    var vh = video.videoHeight || height;
    if (!vw || !vh) return;
    var scale = Math.max(width / vw, height / vh);
    var dw = vw * scale;
    var dh = vh * scale;
    ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
  }

  function buildSendStream(cameraStream, model) {
    var size = stageSize(model);
    var width = size.width;
    var height = size.height;
    var fps = finiteFps(model && model.fps, 24);
    var video = document.createElement('video');
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    video.srcObject = cameraStream;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var timer = 0;
    function frame() {
      if (video.readyState >= 2) drawCover(ctx, video, width, height);
      timer = window.requestAnimationFrame(frame);
    }
    var ready = video.play().catch(function () { return null; }).then(function () {
      frame();
      var captured = canvas.captureStream(fps);
      return captured;
    });
    return {
      ready: ready,
      stop: function () {
        if (timer) window.cancelAnimationFrame(timer);
        video.pause();
        video.srcObject = null;
      },
    };
  }

  async function openCamera(model) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(CAMERA_TIP);
    }
    var size = stageSize(model);
    var fps = finiteFps(model && model.fps, 24);
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: size.width },
          height: { ideal: size.height },
          frameRate: { ideal: fps },
        },
      });
    } catch (e) {
      throw new Error(CAMERA_TIP);
    }
  }

  function showVideo(el, stream) {
    previewEl.classList.remove('show');
    outputEl.classList.remove('show');
    el.srcObject = stream;
    el.classList.add('show');
    var play = el.play();
    if (play && play.catch) play.catch(function () {});
  }

  async function applyGarment(color) {
    if (!session || !session.rt) return;
    setStatus('正在换 ' + color.name + '…');
    try {
      var blob = await loadGarment(color);
      await session.rt.set({ prompt: PROMPT, image: blob, enhance: false });
      setStatus('试衣中 · ' + color.name);
      showBanner('');
    } catch (e) {
      setStatus('换色失败');
      showBanner((e && e.message) || '这件衣服没换上，请再点一次颜色。');
    }
  }

  async function startSession() {
    if (running || starting) return;
    if (!window.DecartTryOn || !window.DecartTryOn.createDecartClient || !window.DecartTryOn.models) {
      showBanner('试衣组件没加载出来，请稍后再试。');
      return;
    }
    starting = true;
    goBtn.disabled = true;
    showBanner('');
    setStatus('正在打开摄像头…');
    var model = window.DecartTryOn.models.realtime(MODEL_ID);
    var camera = null;
    var sender = null;
    try {
      camera = await openCamera(model);
      showVideo(previewEl, camera);
      hintEl.style.display = 'none';
      sender = buildSendStream(camera, model);
      var sendStream = await sender.ready;
      setStatus('正在连接试衣…');
      var color = colors[selected] || colors[0];
      var blob = await loadGarment(color);
      var client = window.DecartTryOn.createDecartClient({
        telemetry: false,
        logger: window.DecartTryOn.noopLogger,
        baseUrl: 'https://api.decart.ai',
        apiKeyProvider: async function () {
          var res = await fetch('/api/tryon/tokens', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ ticket: ticket }),
          });
          var data = {};
          try { data = await res.json(); } catch (e) { data = {}; }
          if (!res.ok || !data.token) throw new Error(messageOf(data, '试衣暂时连不上，请稍后再试'));
          return data.token;
        },
      });
      var rt = await client.realtime.connect(sendStream, {
        model: model,
        mirror: false,
        retries: 1,
        onRemoteStream: function (remote) {
          showVideo(outputEl, remote);
          hintEl.style.display = 'none';
        },
      });
      session = { rt: rt, camera: camera, sender: sender };
      running = true;
      await rt.set({ prompt: PROMPT, image: blob, enhance: false });
      setStatus('试衣中 · ' + color.name);
      goBtn.textContent = '停止';
      goBtn.classList.add('stop');
      goBtn.disabled = false;
    } catch (e) {
      if (sender) sender.stop();
      stopTracks(camera);
      previewEl.classList.remove('show');
      hintEl.style.display = '';
      var msg = (e && e.message) || '试衣暂时连不上，请稍后再试';
      if (/camera|notallowed|notfound|permission|设备|摄像头|getUserMedia/i.test(msg) || msg === CAMERA_TIP) {
        msg = CAMERA_TIP;
      } else if (/DECART|API_KEY|dct_/i.test(msg)) {
        msg = '试衣暂时连不上，请稍后再试';
      }
      setStatus('没能开始');
      showBanner(msg);
      goBtn.textContent = '开始试衣';
      goBtn.classList.remove('stop');
      goBtn.disabled = false;
    } finally {
      starting = false;
    }
  }

  function stopTracks(stream) {
    if (!stream || !stream.getTracks) return;
    stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (e) {}
    });
  }

  function stopSession() {
    var current = session;
    session = null;
    running = false;
    if (current && current.rt) {
      try { current.rt.disconnect(); } catch (e) {}
    }
    if (current && current.sender) current.sender.stop();
    if (current && current.camera) stopTracks(current.camera);
    previewEl.classList.remove('show');
    outputEl.classList.remove('show');
    outputEl.srcObject = null;
    previewEl.srcObject = null;
    hintEl.style.display = '';
    goBtn.textContent = '开始试衣';
    goBtn.classList.remove('stop');
    goBtn.disabled = colors.length === 0;
    if (colors.length) setStatus('已停止。可以再点「开始试衣」');
  }

  goBtn.addEventListener('click', function () {
    if (running) stopSession();
    else startSession();
  });

  window.addEventListener('pagehide', stopSession);
  loadCatalog();
})();
