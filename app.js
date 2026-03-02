(() => {
  "use strict";

  const LANE_NAMES = ["LEFT", "DOWN", "UP", "RIGHT"];

  const CFG = {
    procWidth: 240,
    procHeight: 180,
    processFpsDefault: 12,
    processFpsMin: 6,
    processFpsMax: 30,
    zoneCount: 4,
    zoneHeightRatios: [0.5, 0.3, 0.3, 0.5], // top-aligned lane heights
    miniCols: 2,
    miniRows: 3,
    sampleStep: 5,
    maxFlowForGlobal: 14.0,
    pixelMagThreshold: 0.9,
    miniActivationRatio: 0.15,
    arrowLenBase: 8,
    arrowLenScale: 2,
    arrowLenMax: 28,
    arrowTriggerLenAtMinSens: 24,
    arrowTriggerLenAtMaxSens: 12,
    triggerFrames: 1,
    releaseFrames: 2,
    aeDiffThreshold: 18.0,
    aeResidualThreshold: 0.78,
    aeHoldFrames: 3,
    farneback: {
      pyrScale: 0.5,
      levels: 2,
      winSize: 15,
      iterations: 2,
      polyN: 5,
      polySigma: 1.1,
      flags: 256, // OPTFLOW_FARNEBACK_GAUSSIAN
    },
  };

  const state = {
    cvReady: false,
    running: false,
    stream: null,
    cap: null,
    mats: {},
    hasPrev: false,
    renderFps: 0,
    processFps: 0,
    lastRenderTs: 0,
    lastProcessTs: 0,
    lastProcessMetricTs: 0,
    latestAnalysis: null,
    aeHold: 0,
    zoneState: [],
    rafId: 0,
    useMog2: false,
    mog2: null,
    ctx: null,
  };

  const ui = {
    startBtn: null,
    stopBtn: null,
    status: null,
    sensitivity: null,
    processingFps: null,
    video: null,
    canvas: null,
    laneLegend: [],
  };

  function formatError(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    try {
      return JSON.stringify(error);
    } catch (_e) {
      return String(error);
    }
  }

  function setStatus(message, isError = false) {
    if (!ui.status) return;
    ui.status.textContent = message;
    ui.status.style.color = isError ? "#ffb3b3" : "";
  }

  function getTargetProcessFps() {
    const raw = Number(ui.processingFps?.value);
    const fallback = CFG.processFpsDefault;
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(CFG.processFpsMin, Math.min(CFG.processFpsMax, raw));
  }

  function getSensitivityValue() {
    const raw = Number(ui.sensitivity?.value);
    const min = Number(ui.sensitivity?.min);
    const max = Number(ui.sensitivity?.max);
    const safeMin = Number.isFinite(min) ? min : 0.65;
    const safeMax = Number.isFinite(max) ? max : 3;
    const fallback = 1;
    const value = Number.isFinite(raw) ? raw : fallback;
    return Math.max(safeMin, Math.min(safeMax, value));
  }

  function getArrowTriggerLengthForSensitivity(sensitivity) {
    const min = Number(ui.sensitivity?.min);
    const max = Number(ui.sensitivity?.max);
    const sensMin = Number.isFinite(min) ? min : 0.65;
    const sensMax = Number.isFinite(max) ? max : 3;
    const range = Math.max(0.001, sensMax - sensMin);
    const t = Math.max(0, Math.min(1, (sensitivity - sensMin) / range));
    return (
      CFG.arrowTriggerLenAtMinSens +
      (CFG.arrowTriggerLenAtMaxSens - CFG.arrowTriggerLenAtMinSens) * t
    );
  }

  function getArrowLength(vx, vy) {
    const mag = Math.hypot(vx, vy);
    if (!Number.isFinite(mag) || mag < 0.001) return 0;
    return Math.min(CFG.arrowLenMax, CFG.arrowLenBase + mag * CFG.arrowLenScale);
  }

  function updateRunningStatus() {
    if (!state.running) return;
    const sensitivity = getSensitivityValue();
    const arrowTriggerLen = getArrowTriggerLengthForSensitivity(sensitivity);
    setStatus(
      `Camera running. Preview full speed, detection capped at ${getTargetProcessFps()} FPS. ON when arrow >= ${arrowTriggerLen.toFixed(1)}.`
    );
  }

  function initDom() {
    ui.startBtn = document.getElementById("startBtn");
    ui.stopBtn = document.getElementById("stopBtn");
    ui.status = document.getElementById("status");
    ui.sensitivity = document.getElementById("sensitivity");
    ui.processingFps = document.getElementById("processingFps");
    ui.video = document.getElementById("videoInput");
    ui.canvas = document.getElementById("outputCanvas");
    ui.laneLegend = Array.from(document.querySelectorAll(".lane-legend div"));
    state.ctx = ui.canvas.getContext("2d");

    if (ui.processingFps) {
      ui.processingFps.value = String(CFG.processFpsDefault);
      ui.processingFps.addEventListener("input", () => {
        updateRunningStatus();
      });
    }

    if (ui.sensitivity) {
      ui.sensitivity.addEventListener("input", () => {
        updateRunningStatus();
      });
    }

    ui.startBtn.addEventListener("click", startCamera);
    ui.stopBtn.addEventListener("click", stopCamera);
    window.addEventListener("beforeunload", stopCamera);
  }

  function markCvReady() {
    if (state.cvReady) return;
    if (!window.cv || typeof cv.Mat !== "function") return;

    state.cvReady = true;
    ui.startBtn.disabled = false;
    setStatus("OpenCV.js ready. Press Start Camera.");
  }

  function watchOpenCv() {
    if (window.__opencvReady) markCvReady();
    window.addEventListener("opencv-ready", markCvReady);

    const poll = window.setInterval(() => {
      if (state.cvReady) {
        window.clearInterval(poll);
        return;
      }
      markCvReady();
    }, 120);
  }

  function createZoneRuntime() {
    return {
      active: false,
      onCount: 0,
      offCount: 0,
      score: 0,
      activeCellRatio: 0,
      meanMag: 0,
      arrowLength: 0,
      vecX: 0,
      vecY: 0,
    };
  }

  function getZoneHeight(zoneIdx, totalHeight) {
    const configuredRatio = CFG.zoneHeightRatios[zoneIdx];
    const ratio = Number.isFinite(configuredRatio) ? configuredRatio : 1;
    const clampedRatio = Math.min(1, Math.max(0.05, ratio));
    return Math.max(CFG.miniRows, Math.floor(totalHeight * clampedRatio));
  }

  function getStreamTrackSize(stream) {
    try {
      const track = stream?.getVideoTracks?.()[0];
      const settings = track?.getSettings?.();
      const width = Number(settings?.width) || 0;
      const height = Number(settings?.height) || 0;
      return { width, height };
    } catch (_error) {
      return { width: 0, height: 0 };
    }
  }

  async function waitForVideoDimensions(video, timeoutMs = 2500) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const width = video.videoWidth | 0;
      const height = video.videoHeight | 0;
      if (width > 0 && height > 0) return { width, height };
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return { width: 0, height: 0 };
  }

  function syncVideoCaptureSize(width, height) {
    const w = width | 0;
    const h = height | 0;
    if (w <= 0 || h <= 0) return;
    ui.video.width = w;
    ui.video.height = h;
    ui.video.setAttribute("width", String(w));
    ui.video.setAttribute("height", String(h));
  }

  function getPreferredVideoSize() {
    const liveW = ui.video.videoWidth | 0;
    const liveH = ui.video.videoHeight | 0;
    if (liveW > 0 && liveH > 0) return { width: liveW, height: liveH };

    const attrW = ui.video.width | 0;
    const attrH = ui.video.height | 0;
    if (attrW > 0 && attrH > 0) return { width: attrW, height: attrH };

    const track = getStreamTrackSize(state.stream);
    if (track.width > 0 && track.height > 0) return track;

    return { width: 640, height: 480 };
  }

  function rebuildPipelineTo(width, height, reason) {
    const w = width | 0;
    const h = height | 0;
    if (w <= 0 || h <= 0) return;
    if (reason) {
      console.warn("Rebuilding capture pipeline:", reason, { width: w, height: h });
    }
    syncVideoCaptureSize(w, h);
    ui.canvas.width = w;
    ui.canvas.height = h;
    initCvPipeline(w, h);
    state.hasPrev = false;
    state.latestAnalysis = null;
    clearLegend();
  }

  async function startCamera() {
    if (state.running) return;
    if (!state.cvReady) {
      setStatus("OpenCV.js is not initialized yet.", true);
      return;
    }
    if (typeof cv.calcOpticalFlowFarneback !== "function") {
      setStatus("This OpenCV.js build has no Farneback optical flow.", true);
      return;
    }

    try {
      setStatus("Requesting camera permission...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60, min: 24 },
        },
      });

      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          setStatus("Camera track ended by browser/device.", true);
          console.error("Camera track ended.");
          stopCamera({ keepStatus: true });
        });
      });

      state.stream = stream;
      ui.video.srcObject = stream;
      await ui.video.play();

      const dimsFromVideo = await waitForVideoDimensions(ui.video, 3000);
      const dimsFromTrack = getStreamTrackSize(stream);
      const width = dimsFromVideo.width || dimsFromTrack.width || 640;
      const height = dimsFromVideo.height || dimsFromTrack.height || 480;

      console.log("Camera dimensions", {
        video: dimsFromVideo,
        track: dimsFromTrack,
        chosen: { width, height },
      });

      rebuildPipelineTo(width, height, "start");
      state.zoneState = new Array(CFG.zoneCount).fill(0).map(createZoneRuntime);
      state.running = true;
      state.hasPrev = false;
      state.lastRenderTs = 0;
      state.lastProcessTs = 0;
      state.lastProcessMetricTs = 0;
      state.renderFps = 0;
      state.processFps = 0;
      state.latestAnalysis = null;
      state.aeHold = 0;

      ui.startBtn.disabled = true;
      ui.stopBtn.disabled = false;
      updateRunningStatus();

      state.rafId = requestAnimationFrame(loop);
    } catch (error) {
      const msg = formatError(error);
      console.error("Camera start error:", error);
      setStatus(`Camera error: ${msg}`, true);
      stopCamera({ keepStatus: true });
    }
  }

  function stopCamera(options = {}) {
    const keepStatus = Boolean(options.keepStatus);

    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }

    state.running = false;
    state.hasPrev = false;
    state.latestAnalysis = null;
    state.renderFps = 0;
    state.processFps = 0;
    state.lastRenderTs = 0;
    state.lastProcessTs = 0;
    state.lastProcessMetricTs = 0;

    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
    }

    ui.video.srcObject = null;
    releaseCvPipeline();
    clearLegend();
    if (state.ctx && ui.canvas) {
      state.ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    }

    ui.startBtn.disabled = !state.cvReady;
    ui.stopBtn.disabled = true;

    if (state.cvReady && !keepStatus) {
      setStatus("Stopped. Press Start Camera to run again.");
    }
  }

  function initCvPipeline(frameWidth, frameHeight) {
    releaseCvPipeline();
    state.cap = new cv.VideoCapture(ui.video);

    const mats = {};
    mats.frameRgba = new cv.Mat(frameHeight, frameWidth, cv.CV_8UC4);
    mats.procRgba = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_8UC4);
    mats.grayRaw = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_8UC1);
    mats.grayTmp = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_8UC1);
    mats.grayCurr = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_8UC1);
    mats.grayPrev = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_8UC1);
    mats.diff = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_8UC1);
    mats.flow = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_32FC2);

    state.useMog2 = false;
    state.mog2 = null;
    mats.fgMask = null;

    try {
      if (typeof cv.createBackgroundSubtractorMOG2 === "function") {
        state.mog2 = cv.createBackgroundSubtractorMOG2(160, 16, false);
      } else if (typeof cv.BackgroundSubtractorMOG2 === "function") {
        state.mog2 = new cv.BackgroundSubtractorMOG2(160, 16, false);
      }

      if (state.mog2) {
        mats.fgMask = new cv.Mat(CFG.procHeight, CFG.procWidth, cv.CV_8UC1);
        state.useMog2 = true;
      }
    } catch (_error) {
      state.useMog2 = false;
      state.mog2 = null;
      mats.fgMask = null;
    }

    state.mats = mats;
  }

  function releaseCvPipeline() {
    if (state.mog2 && typeof state.mog2.delete === "function") {
      state.mog2.delete();
    }

    for (const key of Object.keys(state.mats)) {
      const obj = state.mats[key];
      if (obj && typeof obj.delete === "function") {
        obj.delete();
      }
    }

    state.cap = null;
    state.mog2 = null;
    state.mats = {};
    state.useMog2 = false;
  }

  function preprocessFrame() {
    const mats = state.mats;
    cv.resize(
      mats.frameRgba,
      mats.procRgba,
      new cv.Size(CFG.procWidth, CFG.procHeight),
      0,
      0,
      cv.INTER_AREA
    );

    cv.cvtColor(mats.procRgba, mats.grayRaw, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(
      mats.grayRaw,
      mats.grayTmp,
      new cv.Size(5, 5),
      0,
      0,
      cv.BORDER_DEFAULT
    );
    cv.equalizeHist(mats.grayTmp, mats.grayCurr);
    cv.GaussianBlur(
      mats.grayCurr,
      mats.grayCurr,
      new cv.Size(5, 5),
      0,
      0,
      cv.BORDER_DEFAULT
    );
  }

  function loop(ts) {
    if (!state.running) return;

    try {
      drawHud(state.latestAnalysis);
      updateRenderFps(ts);

      const targetFps = getTargetProcessFps();
      const intervalMs = 1000 / Math.max(1, targetFps);
      if (!state.lastProcessTs || ts - state.lastProcessTs >= intervalMs) {
        processFrame(ts);
      }
    } catch (error) {
      const msg = formatError(error);
      console.error("Frame loop error:", error);
      setStatus(`Runtime error: ${msg}`, true);
      stopCamera({ keepStatus: true });
      return;
    }

    state.rafId = requestAnimationFrame(loop);
  }

  function processFrame(ts) {
    const mats = state.mats;
    if (!mats || !mats.frameRgba) return;

    const preferred = getPreferredVideoSize();
    const capW = ui.video.width | 0;
    const capH = ui.video.height | 0;
    if (preferred.width !== capW || preferred.height !== capH) {
      syncVideoCaptureSize(preferred.width, preferred.height);
    }

    if (
      mats.frameRgba.cols !== preferred.width ||
      mats.frameRgba.rows !== preferred.height
    ) {
      rebuildPipelineTo(preferred.width, preferred.height, "size drift");
      return;
    }

    try {
      state.cap.read(mats.frameRgba);
    } catch (error) {
      const msg = formatError(error);
      if (msg.includes("Bad size of input mat")) {
        const fallback = getPreferredVideoSize();
        rebuildPipelineTo(fallback.width, fallback.height, "recover from bad mat size");
        return;
      }
      throw error;
    }
    if (mats.frameRgba.empty()) return;

    state.lastProcessTs = ts;
    cv.flip(mats.frameRgba, mats.frameRgba, 1);
    preprocessFrame();

    if (state.useMog2 && mats.fgMask && state.mog2) {
      if (typeof state.mog2.apply === "function") {
        try {
          state.mog2.apply(mats.grayCurr, mats.fgMask, 0.01);
        } catch (error) {
          console.error("MOG2 apply failed, disabling MOG2 fallback:", error);
          state.useMog2 = false;
        }
      } else {
        state.useMog2 = false;
      }
    }

    if (!state.hasPrev) {
      mats.grayCurr.copyTo(mats.grayPrev);
      state.hasPrev = true;
      state.latestAnalysis = null;
      updateProcessFps(ts);
      return;
    }

    const fb = CFG.farneback;
    cv.calcOpticalFlowFarneback(
      mats.grayPrev,
      mats.grayCurr,
      mats.flow,
      fb.pyrScale,
      fb.levels,
      fb.winSize,
      fb.iterations,
      fb.polyN,
      fb.polySigma,
      fb.flags
    );

    cv.absdiff(mats.grayCurr, mats.grayPrev, mats.diff);
    const meanDiff = cv.mean(mats.diff)[0];

    const analysis = analyzeMotion(meanDiff);
    state.latestAnalysis = analysis;

    mats.grayCurr.copyTo(mats.grayPrev);
    updateProcessFps(ts);
  }

  function analyzeMotion(meanDiff) {
    const mats = state.mats;
    const flowData = mats.flow.data32F;
    const maskData =
      state.useMog2 && mats.fgMask && mats.fgMask.data ? mats.fgMask.data : null;
    const width = mats.flow.cols;
    const height = mats.flow.rows;

    const globalX = [];
    const globalY = [];
    const globalStep = CFG.sampleStep * 2;

    for (let y = 2; y < height; y += globalStep) {
      for (let x = 2; x < width; x += globalStep) {
        const idx = (y * width + x) * 2;
        const dx = flowData[idx];
        const dy = flowData[idx + 1];
        const mag = Math.hypot(dx, dy);
        if (Number.isFinite(mag) && mag < CFG.maxFlowForGlobal) {
          globalX.push(dx);
          globalY.push(dy);
        }
      }
    }

    const gdx = median(globalX);
    const gdy = median(globalY);

    const sensitivity = getSensitivityValue();
    const pixelMagThreshold = CFG.pixelMagThreshold;
    const arrowTriggerLen = getArrowTriggerLengthForSensitivity(sensitivity);

    const zonesRaw = [];
    let residualSum = 0;
    let residualCount = 0;
    const zoneWidth = width / CFG.zoneCount;

    for (let zoneIdx = 0; zoneIdx < CFG.zoneCount; zoneIdx += 1) {
      const x0 = Math.floor(zoneIdx * zoneWidth);
      const x1 = Math.floor((zoneIdx + 1) * zoneWidth);
      const zoneHeight = getZoneHeight(zoneIdx, height);
      const miniW = (x1 - x0) / CFG.miniCols;
      const miniH = zoneHeight / CFG.miniRows;

      let activeCells = 0;
      let zoneActiveMagSum = 0;
      let zoneActiveCount = 0;
      let vecX = 0;
      let vecY = 0;
      let vecSamples = 0;

      for (let row = 0; row < CFG.miniRows; row += 1) {
        for (let col = 0; col < CFG.miniCols; col += 1) {
          const cx0 = Math.floor(x0 + col * miniW);
          const cx1 = Math.floor(x0 + (col + 1) * miniW);
          const cy0 = Math.floor(row * miniH);
          const cy1 = Math.floor((row + 1) * miniH);

          let cellSamples = 0;
          let cellActive = 0;

          for (let y = cy0; y < cy1; y += CFG.sampleStep) {
            for (let x = cx0; x < cx1; x += CFG.sampleStep) {
              const idx = (y * width + x) * 2;
              const rdx = flowData[idx] - gdx;
              const rdy = flowData[idx + 1] - gdy;
              const mag = Math.hypot(rdx, rdy);

              residualSum += mag;
              residualCount += 1;

              if (mag < pixelMagThreshold) {
                cellSamples += 1;
                continue;
              }

              if (maskData) {
                const maskValue = maskData[y * width + x];
                if (maskValue < 200) {
                  cellSamples += 1;
                  continue;
                }
              }

              cellActive += 1;
              zoneActiveMagSum += mag;
              zoneActiveCount += 1;
              vecX += rdx;
              vecY += rdy;
              vecSamples += 1;
              cellSamples += 1;
            }
          }

          const cellRatio = cellActive / Math.max(1, cellSamples);
          if (cellRatio >= CFG.miniActivationRatio) {
            activeCells += 1;
          }
        }
      }

      const activeCellRatio = activeCells / (CFG.miniCols * CFG.miniRows);
      const meanMag = zoneActiveMagSum / Math.max(1, zoneActiveCount);
      const avgVecX = vecX / Math.max(1, vecSamples);
      const avgVecY = vecY / Math.max(1, vecSamples);
      const arrowLength = getArrowLength(avgVecX, avgVecY);
      const rawTrigger = arrowLength >= arrowTriggerLen;

      zonesRaw.push({
        activeCellRatio,
        meanMag,
        arrowLength,
        vecX: avgVecX,
        vecY: avgVecY,
        rawTrigger,
      });
    }

    const avgResidualMag = residualSum / Math.max(1, residualCount);
    if (meanDiff > CFG.aeDiffThreshold && avgResidualMag < CFG.aeResidualThreshold) {
      state.aeHold = CFG.aeHoldFrames;
    }

    const burst = zonesRaw.filter((z) => z.rawTrigger).length;
    if (burst >= 3 && meanDiff > CFG.aeDiffThreshold * 0.82) {
      state.aeHold = Math.max(state.aeHold, 2);
    }

    const suppressed = state.aeHold > 0;
    if (state.aeHold > 0) state.aeHold -= 1;

    const zones = zonesRaw.map((zoneRaw, idx) => {
      const z = state.zoneState[idx];
      if (zoneRaw.rawTrigger) {
        z.onCount += 1;
        z.offCount = 0;
      } else {
        z.offCount += 1;
        z.onCount = 0;
      }

      if (!z.active && z.onCount >= CFG.triggerFrames) z.active = true;
      if (z.active && z.offCount >= CFG.releaseFrames) z.active = false;

      z.score = 0.65 * z.score + 0.35 * (zoneRaw.activeCellRatio * zoneRaw.meanMag);
      z.activeCellRatio = zoneRaw.activeCellRatio;
      z.meanMag = zoneRaw.meanMag;
      z.arrowLength = zoneRaw.arrowLength;
      z.vecX = zoneRaw.vecX;
      z.vecY = zoneRaw.vecY;

      return {
        active: z.active,
        score: z.score,
        activeCellRatio: z.activeCellRatio,
        meanMag: z.meanMag,
        arrowLength: z.arrowLength,
        vecX: z.vecX,
        vecY: z.vecY,
      };
    });

    return {
      zones,
      suppressed,
      meanDiff,
      avgResidualMag,
      sensitivity,
      arrowTriggerLen,
      globalVec: { x: gdx, y: gdy, mag: Math.hypot(gdx, gdy) },
    };
  }

  function drawHud(analysis) {
    const ctx = state.ctx;
    if (!ctx || !ui.canvas) return;
    const w = ui.canvas.width;
    const h = ui.canvas.height;
    if (w <= 0 || h <= 0) return;
    const laneW = w / CFG.zoneCount;

    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < CFG.zoneCount; i += 1) {
      const zone = analysis ? analysis.zones[i] : null;
      const x = i * laneW;
      const zoneHeight = getZoneHeight(i, h);

      const idleFill = analysis && analysis.suppressed
        ? "rgba(255, 186, 94, 0.16)"
        : "rgba(10, 20, 34, 0.16)";
      const active = Boolean(zone && zone.active);
      ctx.fillStyle = active ? "rgba(41, 211, 161, 0.28)" : idleFill;
      ctx.fillRect(x, 0, laneW, zoneHeight);

      ctx.strokeStyle = active ? "#36ffc2" : "rgba(160, 200, 235, 0.45)";
      ctx.lineWidth = active ? 4 : 2;
      ctx.strokeRect(x + 1, 1, laneW - 2, zoneHeight - 2);

      ctx.strokeStyle = "rgba(145, 179, 206, 0.26)";
      ctx.lineWidth = 1;
      for (let c = 1; c < CFG.miniCols; c += 1) {
        const gx = x + (c * laneW) / CFG.miniCols;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, zoneHeight);
        ctx.stroke();
      }
      for (let r = 1; r < CFG.miniRows; r += 1) {
        const gy = (r * zoneHeight) / CFG.miniRows;
        ctx.beginPath();
        ctx.moveTo(x, gy);
        ctx.lineTo(x + laneW, gy);
        ctx.stroke();
      }

      ctx.fillStyle = active ? "#dcfff4" : "#d2e3f4";
      ctx.font = "700 16px 'Space Grotesk'";
      ctx.fillText(`${LANE_NAMES[i]} ${active ? "ON" : "--"}`, x + 10, 24);
      ctx.font = "500 12px 'Space Grotesk'";
      if (zone) {
        ctx.fillText(
          `cells ${(zone.activeCellRatio * 100).toFixed(0)}% | arrow ${zone.arrowLength.toFixed(1)} / ${analysis.arrowTriggerLen.toFixed(1)}`,
          x + 10,
          42
        );
        drawVector(
          ctx,
          x + laneW * 0.5,
          Math.max(18, zoneHeight * 0.74),
          zone.vecX,
          zone.vecY,
          active
        );
      }
      setLegendHot(i, active);
    }

    ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
    ctx.fillRect(8, 8, 418, 54);
    ctx.fillStyle = analysis && analysis.suppressed ? "#ffe2b7" : "#cbe2f8";
    ctx.font = "600 12px 'Space Grotesk'";
    ctx.fillText(
      `View ${state.renderFps.toFixed(1)} FPS | Detect ${state.processFps.toFixed(1)} / ${getTargetProcessFps()} FPS`,
      16,
      28
    );

    if (analysis) {
      ctx.fillText(
        `global (${analysis.globalVec.x.toFixed(2)}, ${analysis.globalVec.y.toFixed(2)}) | meanDiff ${analysis.meanDiff.toFixed(1)} | residual ${analysis.avgResidualMag.toFixed(2)}${
          analysis.suppressed ? " | AE guard" : ""
        }`,
        16,
        46
      );
    } else {
      ctx.fillText("warming up detector...", 16, 46);
    }
  }

  function drawVector(ctx, cx, cy, vx, vy, hot) {
    const mag = Math.hypot(vx, vy);
    const len = getArrowLength(vx, vy);
    if (mag < 0.001 || len <= 0) return;

    const nx = vx / mag;
    const ny = vy / mag;
    const ex = cx + nx * len;
    const ey = cy + ny * len;

    ctx.strokeStyle = hot ? "#d4fff2" : "#b8d3ea";
    ctx.lineWidth = hot ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    const side = 5;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - nx * 8 - ny * side, ey - ny * 8 + nx * side);
    ctx.lineTo(ex - nx * 8 + ny * side, ey - ny * 8 - nx * side);
    ctx.closePath();
    ctx.fillStyle = hot ? "#d4fff2" : "#b8d3ea";
    ctx.fill();
  }

  function setLegendHot(index, isHot) {
    const item = ui.laneLegend[index];
    if (!item) return;
    item.classList.toggle("hot", isHot);
  }

  function clearLegend() {
    for (const item of ui.laneLegend) item.classList.remove("hot");
  }

  function updateRenderFps(ts) {
    if (!state.lastRenderTs) {
      state.lastRenderTs = ts;
      return;
    }
    const dt = ts - state.lastRenderTs;
    state.lastRenderTs = ts;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const current = 1000 / dt;
    state.renderFps = state.renderFps ? state.renderFps * 0.85 + current * 0.15 : current;
  }

  function updateProcessFps(ts) {
    if (!state.lastProcessMetricTs) {
      state.lastProcessMetricTs = ts;
      return;
    }
    const dt = ts - state.lastProcessMetricTs;
    state.lastProcessMetricTs = ts;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const current = 1000 / dt;
    state.processFps = state.processFps
      ? state.processFps * 0.8 + current * 0.2
      : current;
  }

  function median(values) {
    if (!values || values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    if (values.length % 2 === 0) return (values[mid - 1] + values[mid]) * 0.5;
    return values[mid];
  }

  document.addEventListener("DOMContentLoaded", () => {
    initDom();
    watchOpenCv();
  });
})();
